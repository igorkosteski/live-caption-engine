const fs = require('fs');

require('dotenv').config();

const express = require('express');
const logger = require('./logger');
const { buildConfig } = require('./config');
const { createEngine } = require('./engines');
const RtmpStreamSession = require('./rtmp-stream-session');
const LiveWebVtt = require('./captions/live-webvtt');
const MediaPackagePublisher = require('./captions/mediapackage-publisher');
const GeminiDubbingEngine = require('./engines/gemini-dubbing-engine');
const PollyDubbingEngine = require('./engines/polly-dubbing-engine');
const AudioSegmentPublisher = require('./dubbing/audio-segment-publisher');

function warnOnUnreachableRtmpHost(rtmpUrl) {
  let parsedUrl;

  try {
    parsedUrl = new URL(rtmpUrl);
  } catch {
    return;
  }

  const isDocker = fs.existsSync('/.dockerenv');
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1']);

  if (isDocker && loopbackHosts.has(parsedUrl.hostname)) {
    logger.warn(
      {
        rtmpUrl,
        suggestedHost: 'host.docker.internal'
      },
      'RTMP_URL points to container loopback; use the Docker host alias to reach an RTMP server running on the host'
    );
  }
}

async function main() {
  const config = buildConfig();
  const app = express();

  warnOnUnreachableRtmpHost(config.stream.rtmpUrl);

  const engine = createEngine({
    engineName: config.engine,
    logger,
    sonioxConfig: config.soniox,
    geminiConfig: config.gemini,
    streamConfig: config.stream
  });

  const streamSession = new RtmpStreamSession({
    logger,
    streamConfig: config.stream,
    engine
  });

  // Captions must be enabled when MediaPackage publishing is active.
  const captionsActive = config.captions.enabled || config.mediapackage.enabled;

  const captions = captionsActive
    ? new LiveWebVtt({
        logger,
        segmentDurationMs: config.captions.segmentDurationMs,
        windowSegments: config.captions.windowSegments,
        basePath: config.captions.basePath
      })
    : null;

  let publisher = null;

  if (captions) {
    engine.on('final-caption', (cue) => {
      captions.addCue(cue);
    });

    if (config.mediapackage.enabled && !config.mediapackage.ingestUrl) {
      throw new Error('MEDIAPACKAGE_INGEST_URL is required when MEDIAPACKAGE_ENABLED=true');
    }

    // Resolve translation settings independent of engine type.
    const translationEnabled =
      config.engine === 'gemini'
        ? config.gemini?.enableTranslation && config.gemini.targetLanguages.length > 0
        : config.soniox?.enableTranslation && config.soniox.translationTargetLanguages.length > 0;

    const translationTargetLanguages =
      config.engine === 'gemini'
        ? (config.gemini?.targetLanguages ?? [])
        : (config.soniox?.translationTargetLanguages ?? []);

    // Map language code -> LiveWebVtt instance so the event handler can route by language.
    const translatedCaptionsByLang = new Map();

    if (translationEnabled) {
      const translatedPublishers = [];

      for (const lang of translationTargetLanguages) {
        const safeLang = lang.replace(/[^a-zA-Z0-9-]/g, '');

        const translatedCaptions = new LiveWebVtt({
          logger,
          segmentDurationMs: config.captions.segmentDurationMs,
          windowSegments: config.captions.windowSegments,
          basePath: `${config.captions.basePath}/${safeLang}`
        });

        translatedCaptionsByLang.set(lang, translatedCaptions);

        // Push translated captions to MediaPackage (source track is HTTP-only).
        if (config.mediapackage.enabled) {
          const translatedPublisher = new MediaPackagePublisher({
            logger,
            captions: translatedCaptions,
            ingestUrl: config.mediapackage.ingestUrl,
            awsRegion: config.mediapackage.awsRegion,
            subtitlePath: `${config.mediapackage.translationSubtitlePath}-${safeLang}`
          });

          translatedPublisher.start();
          translatedPublishers.push(translatedPublisher);
        }

        app.get(`${config.captions.basePath}/${safeLang}/live.vtt`, (_req, res) => {
          res.type('text/vtt').send(translatedCaptions.renderLiveVtt());
        });

        app.get(`${config.captions.basePath}/${safeLang}/index.m3u8`, (_req, res) => {
          res.type('application/vnd.apple.mpegurl').send(translatedCaptions.renderPlaylist());
        });

        app.get(`${config.captions.basePath}/${safeLang}/segments/:segmentIndex.vtt`, (req, res) => {
          const segmentIndex = Number.parseInt(req.params.segmentIndex, 10);
          const segment = translatedCaptions.renderSegment(segmentIndex);

          if (!segment) {
            res.status(404).json({ ok: false, message: 'Caption segment not found' });
            return;
          }

          res.type('text/vtt').send(segment);
        });
      }

      engine.on('final-caption-translated', (cue) => {
        const track = translatedCaptionsByLang.get(cue.language);
        if (track) {
          track.addCue(cue);
        }
      });

      if (translatedPublishers.length > 0) {
        publisher = {
          stop() {
            for (const p of translatedPublishers) p.stop();
          }
        };
      }
    }

    app.get(`${config.captions.basePath}/live.vtt`, (_req, res) => {
      res.type('text/vtt').send(captions.renderLiveVtt());
    });

    app.get(`${config.captions.basePath}/index.m3u8`, (_req, res) => {
      res.type('application/vnd.apple.mpegurl').send(captions.renderPlaylist());
    });

    app.get(`${config.captions.basePath}/segments/:segmentIndex.vtt`, (req, res) => {
      const segmentIndex = Number.parseInt(req.params.segmentIndex, 10);
      const segment = captions.renderSegment(segmentIndex);

      if (!segment) {
        res.status(404).json({ ok: false, message: 'Caption segment not found' });
        return;
      }

      res.type('text/vtt').send(segment);
    });
  }

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true, engine: config.engine });
  });

  app.get('/readyz', (_req, res) => {
    res.status(200).json({ ok: true, source: 'rtmp', engine: config.engine });
  });

  const server = app.listen(config.app.port, () => {
    logger.info(
      {
        port: config.app.port,
        captionsEnabled: config.captions.enabled,
        captionsBasePath: config.captions.basePath,
        dubbingEnabled: config.dubbing.enabled
      },
      'HTTP server listening'
    );
  });

  // ── Dubbing ──────────────────────────────────────────────────────────────────
  const dubbingEngines = [];  // { engine, audioPublisher|null, lang, safeLang }

  if (config.dubbing.enabled && config.dubbing.targetLanguages.length > 0) {
    for (const lang of config.dubbing.targetLanguages) {
      const safeLang = lang.replace(/[^a-zA-Z0-9-]/g, '');

      if (config.dubbing.engine === 'gemini') {
        if (!config.dubbing.geminiApiKey) {
          throw new Error('DUBBING_ENGINE=gemini requires GEMINI_API_KEY');
        }

        const dubbingEngine = new GeminiDubbingEngine({
          logger,
          geminiConfig: {
            apiKey: config.dubbing.geminiApiKey,
            model: config.dubbing.geminiModel,
            sourceLanguage: config.dubbing.geminiSourceLanguage
          },
          streamConfig: config.stream,
          targetLanguage: lang,
          voiceName: config.dubbing.geminiVoice
        });

        await dubbingEngine.start();

        // Gemini dubbing needs raw PCM — wire after streamSession is created.
        streamSession.on('audio', (chunk) => dubbingEngine.sendAudio(chunk));

        const geminiAudioPublisher = config.mediapackage.enabled
          ? new AudioSegmentPublisher({
              logger,
              dubbingStream: dubbingEngine.dubbingStream,
              ingestUrl: config.mediapackage.ingestUrl,
              awsRegion: config.mediapackage.awsRegion,
              audioPath: `${config.dubbing.audioPath}-${safeLang}`,
              segmentDurationMs: config.captions.segmentDurationMs,
              windowSegments: config.captions.windowSegments
            })
          : null;

        geminiAudioPublisher?.start();
        dubbingEngines.push({ engine: dubbingEngine, audioPublisher: geminiAudioPublisher, lang, safeLang });
      } else if (config.dubbing.engine === 'polly') {
        const dubbingEngine = new PollyDubbingEngine({
          logger,
          awsRegion: config.mediapackage.awsRegion,
          targetLanguage: lang,
          voiceId: config.dubbing.pollyVoices[lang] || undefined,
          engine  // Polly listens to final-caption-translated events from the main engine
        });

        dubbingEngine.start();

        const pollyAudioPublisher = config.mediapackage.enabled
          ? new AudioSegmentPublisher({
              logger,
              dubbingStream: dubbingEngine.dubbingStream,
              ingestUrl: config.mediapackage.ingestUrl,
              awsRegion: config.mediapackage.awsRegion,
              audioPath: `${config.dubbing.audioPath}-${safeLang}`,
              segmentDurationMs: config.captions.segmentDurationMs,
              windowSegments: config.captions.windowSegments
            })
          : null;

        pollyAudioPublisher?.start();
        dubbingEngines.push({ engine: dubbingEngine, audioPublisher: pollyAudioPublisher, lang, safeLang });
      } else {
        throw new Error(`Unknown DUBBING_ENGINE: ${config.dubbing.engine}. Use 'gemini' or 'polly'.`);
      }
    }

    // HTTP endpoints: GET /dub/:lang/audio.pcm  — live chunked PCM stream
    for (const { engine: dubbingEngine, lang, safeLang } of dubbingEngines) {
      const { sampleRate, channels } = dubbingEngine.dubbingStream;

      app.get(`/dub/${safeLang}/audio.pcm`, (req, res) => {
        res.setHeader('Content-Type', 'audio/pcm');
        res.setHeader('X-Sample-Rate', String(sampleRate));
        res.setHeader('X-Channels', String(channels));
        res.setHeader('X-Language', lang);
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.flushHeaders();

        dubbingEngine.dubbingStream.pipe(res);

        logger.info({ lang, remoteAddress: req.socket.remoteAddress }, 'Dubbing subscriber connected');
      });
    }

    logger.info(
      {
        dubbingEngine: config.dubbing.engine,
        languages: config.dubbing.targetLanguages,
        endpoints: config.dubbing.targetLanguages.map((l) => `/dub/${l.replace(/[^a-zA-Z0-9-]/g, '')}/audio.pcm`),
        mediapackageAudio: config.mediapackage.enabled
          ? config.dubbing.targetLanguages.map((l) => `${config.dubbing.audioPath}-${l.replace(/[^a-zA-Z0-9-]/g, '')}/audio.m3u8`)
          : false
      },
      'Dubbing ready'
    );
  }

  await streamSession.start();

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down');

    for (const { engine: dubbingEngine, audioPublisher } of dubbingEngines) {
      try { await dubbingEngine.stop?.(); } catch { /* ignore */ }
      try { audioPublisher?.stop(); } catch { /* ignore */ }
    }

    if (publisher) {
      publisher.stop();
    }

    try {
      await streamSession.stop();
    } catch (error) {
      logger.error({ err: error }, 'Error stopping stream session');
    }

    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  logger.error({ err: error }, 'Fatal startup error');
  process.exit(1);
});

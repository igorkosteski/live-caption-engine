'use strict';

const { randomUUID } = require('crypto');
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
  app.use(express.json());

  // ── Active sessions ──────────────────────────────────────────────────────

  /** @type {Map<string, object>} */
  const sessions = new Map();

  // ── Session factory ──────────────────────────────────────────────────────

  /**
   * Start a new stream session.
   *
   * @param {object} params
   * @param {string}   params.sessionId         UUID for this session
   * @param {string}   params.rtmpUrl           RTMP ingest URL for this stream
   * @param {string[]} params.languages         Translation target language codes (e.g. ['de','fr'])
   * @param {string[]} params.dubbingLanguages  Dubbing target languages (defaults to languages)
   */
  async function startSession({ sessionId, rtmpUrl, languages, dubbingLanguages }) {
    warnOnUnreachableRtmpHost(rtmpUrl);

    // Per-session stream config — API-provided rtmpUrl takes precedence.
    const streamConfig = { ...config.stream, rtmpUrl };

    // Language lists: API param > env-var fallback.
    const translationLanguages = languages && languages.length > 0
      ? languages
      : (config.engine === 'gemini'
          ? (config.gemini?.targetLanguages ?? [])
          : (config.soniox?.translationTargetLanguages ?? []));

    const enableTranslation = translationLanguages.length > 0;

    // Override per-engine language config with the API-provided list.
    let sonioxConfig = config.soniox;
    let geminiConfig = config.gemini;

    if (config.engine === 'soniox' && enableTranslation) {
      sonioxConfig = { ...config.soniox, enableTranslation: true, translationTargetLanguages: translationLanguages };
    } else if (config.engine === 'gemini' && enableTranslation) {
      geminiConfig = { ...config.gemini, enableTranslation: true, targetLanguages: translationLanguages };
    }

    const engine = createEngine({ engineName: config.engine, logger, sonioxConfig, geminiConfig, streamConfig });
    const streamSession = new RtmpStreamSession({ logger, streamConfig, engine });

    // ── Captions ────────────────────────────────────────────────────────────

    const captionsActive = config.captions.enabled || config.mediapackage.enabled;
    const captionsBasePath = `/sessions/${sessionId}/captions`;

    const captions = captionsActive
      ? new LiveWebVtt({
          logger,
          segmentDurationMs: config.captions.segmentDurationMs,
          windowSegments: config.captions.windowSegments,
          basePath: captionsBasePath
        })
      : null;

    /** @type {MediaPackagePublisher[]} */
    const publishers = [];

    /** @type {Map<string, LiveWebVtt>} */
    const translatedCaptionsByLang = new Map();

    if (captions) {
      engine.on('final-caption', (cue) => captions.addCue(cue));

      if (config.mediapackage.enabled && !config.mediapackage.ingestUrl) {
        throw new Error('MEDIAPACKAGE_INGEST_URL is required when MEDIAPACKAGE_ENABLED=true');
      }

      if (config.mediapackage.enabled) {
        // Always publish source-language captions so MediaPackage has a baseline subtitle track
        // even when translation output is disabled or temporarily empty.
        const sourcePublisher = new MediaPackagePublisher({
          logger,
          captions,
          ingestUrl: config.mediapackage.ingestUrl,
          awsRegion: config.mediapackage.awsRegion,
          subtitlePath: `${config.mediapackage.subtitlePath}-${sessionId}`
        });
        sourcePublisher.start();
        publishers.push(sourcePublisher);
      }

      if (enableTranslation) {
        for (const lang of translationLanguages) {
          const safeLang = lang.replace(/[^a-zA-Z0-9-]/g, '');

          const translatedCaptions = new LiveWebVtt({
            logger,
            segmentDurationMs: config.captions.segmentDurationMs,
            windowSegments: config.captions.windowSegments,
            basePath: `${captionsBasePath}/${safeLang}`
          });

          translatedCaptionsByLang.set(lang, translatedCaptions);

          if (config.mediapackage.enabled) {
            // Include sessionId in subtitle path so parallel sessions don't collide in MediaPackage.
            const p = new MediaPackagePublisher({
              logger,
              captions: translatedCaptions,
              ingestUrl: config.mediapackage.ingestUrl,
              awsRegion: config.mediapackage.awsRegion,
              subtitlePath: `${config.mediapackage.translationSubtitlePath}-${sessionId}-${safeLang}`
            });
            p.start();
            publishers.push(p);
          }
        }

        engine.on('final-caption-translated', (cue) => {
          const track = translatedCaptionsByLang.get(cue.language);
          if (track) track.addCue(cue);
        });
      }
    }

    // ── Dubbing ──────────────────────────────────────────────────────────────

    const dubbingTargetLangs = dubbingLanguages && dubbingLanguages.length > 0
      ? dubbingLanguages
      : (config.dubbing.enabled ? config.dubbing.targetLanguages : []);

    /** @type {Array<{engine: object, audioPublisher: object|null, lang: string, safeLang: string}>} */
    const dubbingEngines = [];

    for (const lang of dubbingTargetLangs) {
      const safeLang = lang.replace(/[^a-zA-Z0-9-]/g, '');

      if (config.dubbing.engine === 'gemini') {
        if (!config.dubbing.geminiApiKey) throw new Error('DUBBING_ENGINE=gemini requires GEMINI_API_KEY');

        const dubbingEngine = new GeminiDubbingEngine({
          logger,
          geminiConfig: {
            apiKey: config.dubbing.geminiApiKey,
            model: config.dubbing.geminiModel,
            sourceLanguage: config.dubbing.geminiSourceLanguage
          },
          streamConfig,
          targetLanguage: lang,
          voiceName: config.dubbing.geminiVoice
        });

        await dubbingEngine.start();
        streamSession.on('audio', (chunk) => dubbingEngine.sendAudio(chunk));

        const audioPublisher = config.mediapackage.enabled
          ? new AudioSegmentPublisher({
              logger,
              dubbingStream: dubbingEngine.dubbingStream,
              ingestUrl: config.mediapackage.ingestUrl,
              awsRegion: config.mediapackage.awsRegion,
              audioPath: `${config.dubbing.audioPath}-${sessionId}-${safeLang}`,
              segmentDurationMs: config.captions.segmentDurationMs,
              windowSegments: config.captions.windowSegments
            })
          : null;

        audioPublisher?.start();
        dubbingEngines.push({ engine: dubbingEngine, audioPublisher, lang, safeLang });

      } else if (config.dubbing.engine === 'polly') {
        const dubbingEngine = new PollyDubbingEngine({
          logger,
          awsRegion: config.mediapackage.awsRegion,
          targetLanguage: lang,
          voiceId: config.dubbing.pollyVoices[lang] || undefined,
          engine
        });

        dubbingEngine.start();

        const audioPublisher = config.mediapackage.enabled
          ? new AudioSegmentPublisher({
              logger,
              dubbingStream: dubbingEngine.dubbingStream,
              ingestUrl: config.mediapackage.ingestUrl,
              awsRegion: config.mediapackage.awsRegion,
              audioPath: `${config.dubbing.audioPath}-${sessionId}-${safeLang}`,
              segmentDurationMs: config.captions.segmentDurationMs,
              windowSegments: config.captions.windowSegments
            })
          : null;

        audioPublisher?.start();
        dubbingEngines.push({ engine: dubbingEngine, audioPublisher, lang, safeLang });

      } else {
        throw new Error(`Unknown DUBBING_ENGINE: ${config.dubbing.engine}. Use 'gemini' or 'polly'.`);
      }
    }

    await streamSession.start();

    // ── Build endpoint map for the API response ──────────────────────────────

    const endpoints = {
      captions: captions ? `${captionsBasePath}/live.vtt` : null,
      translatedCaptions: [...translatedCaptionsByLang.keys()].map((lang) => ({
        lang,
        url: `${captionsBasePath}/${lang.replace(/[^a-zA-Z0-9-]/g, '')}/live.vtt`
      })),
      dub: dubbingEngines.map(({ lang, safeLang }) => ({
        lang,
        url: `/sessions/${sessionId}/dub/${safeLang}/audio.pcm`
      }))
    };

    logger.info({ sessionId, rtmpUrl, languages: translationLanguages, dubbingLanguages: dubbingTargetLangs }, 'Session started');

    // ── Teardown helper ──────────────────────────────────────────────────────

    const stop = async () => {
      for (const { engine: dubbingEngine, audioPublisher } of dubbingEngines) {
        try { await dubbingEngine.stop?.(); } catch { /* ignore */ }
        try { audioPublisher?.stop(); } catch { /* ignore */ }
      }
      for (const p of publishers) {
        try { p.stop(); } catch { /* ignore */ }
      }
      try { await streamSession.stop(); } catch { /* ignore */ }
    };

    return {
      sessionId,
      rtmpUrl,
      languages: translationLanguages,
      dubbingLanguages: dubbingTargetLangs,
      startedAt: new Date().toISOString(),
      captions,
      translatedCaptionsByLang,
      dubbingEngines,
      endpoints,
      stop
    };
  }

  // ── Session management endpoints ─────────────────────────────────────────

  /**
   * POST /sessions
   * Body: { rtmpUrl?: string, languages?: string[], dubbingLanguages?: string[] }
   * Response 201: { ok: true, sessionId, endpoints }
   */
  app.post('/sessions', async (req, res) => {
    const { rtmpUrl, languages = [], dubbingLanguages = [] } = req.body || {};
    const sessionRtmpUrl = rtmpUrl || config.stream.rtmpUrl;

    if (!sessionRtmpUrl || typeof sessionRtmpUrl !== 'string') {
      return res.status(400).json({ ok: false, message: 'rtmpUrl is required (request body or RTMP_URL env)' });
    }
    if (!Array.isArray(languages) || !Array.isArray(dubbingLanguages)) {
      return res.status(400).json({ ok: false, message: 'languages and dubbingLanguages must be arrays' });
    }

    try {
      const sessionId = randomUUID();
      const session = await startSession({ sessionId, rtmpUrl: sessionRtmpUrl, languages, dubbingLanguages });
      sessions.set(sessionId, session);
      res.status(201).json({ ok: true, sessionId, endpoints: session.endpoints });
    } catch (err) {
      logger.error({ err }, 'Failed to start session');
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  /**
   * GET /sessions
   * Lists all active sessions.
   */
  app.get('/sessions', (_req, res) => {
    const list = [...sessions.values()].map(({ sessionId, rtmpUrl, languages, dubbingLanguages, startedAt, endpoints }) => ({
      sessionId, rtmpUrl, languages, dubbingLanguages, startedAt, endpoints
    }));
    res.json({ ok: true, sessions: list });
  });

  /**
   * DELETE /sessions/:sessionId
   * Stops and tears down the session.
   */
  app.delete('/sessions/:sessionId', async (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ ok: false, message: 'Session not found' });
    }
    try {
      await session.stop();
      sessions.delete(req.params.sessionId);
      logger.info({ sessionId: req.params.sessionId }, 'Session stopped');
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Failed to stop session');
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // ── Per-session caption endpoints ────────────────────────────────────────

  app.get('/sessions/:sessionId/captions/live.vtt', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session?.captions) return res.status(404).json({ ok: false });
    res.type('text/vtt').send(session.captions.renderLiveVtt());
  });

  app.get('/sessions/:sessionId/captions/index.m3u8', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session?.captions) return res.status(404).json({ ok: false });
    res.type('application/vnd.apple.mpegurl').send(session.captions.renderPlaylist());
  });

  app.get('/sessions/:sessionId/captions/segments/:segmentIndex.vtt', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session?.captions) return res.status(404).json({ ok: false });
    const segment = session.captions.renderSegment(Number.parseInt(req.params.segmentIndex, 10));
    if (!segment) return res.status(404).json({ ok: false, message: 'Caption segment not found' });
    res.type('text/vtt').send(segment);
  });

  app.get('/sessions/:sessionId/captions/:lang/live.vtt', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    const track = session?.translatedCaptionsByLang?.get(req.params.lang);
    if (!track) return res.status(404).json({ ok: false });
    res.type('text/vtt').send(track.renderLiveVtt());
  });

  app.get('/sessions/:sessionId/captions/:lang/index.m3u8', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    const track = session?.translatedCaptionsByLang?.get(req.params.lang);
    if (!track) return res.status(404).json({ ok: false });
    res.type('application/vnd.apple.mpegurl').send(track.renderPlaylist());
  });

  app.get('/sessions/:sessionId/captions/:lang/segments/:segmentIndex.vtt', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    const track = session?.translatedCaptionsByLang?.get(req.params.lang);
    if (!track) return res.status(404).json({ ok: false });
    const segment = track.renderSegment(Number.parseInt(req.params.segmentIndex, 10));
    if (!segment) return res.status(404).json({ ok: false, message: 'Caption segment not found' });
    res.type('text/vtt').send(segment);
  });

  // ── Per-session dubbing endpoints ────────────────────────────────────────

  app.get('/sessions/:sessionId/dub/:lang/audio.pcm', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ ok: false });
    const entry = session.dubbingEngines.find((e) => e.safeLang === req.params.lang);
    if (!entry) return res.status(404).json({ ok: false });

    const { sampleRate, channels } = entry.engine.dubbingStream;
    res.setHeader('Content-Type', 'audio/pcm');
    res.setHeader('X-Sample-Rate', String(sampleRate));
    res.setHeader('X-Channels', String(channels));
    res.setHeader('X-Language', entry.lang);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.flushHeaders();
    entry.engine.dubbingStream.pipe(res);

    logger.info(
      { lang: entry.lang, sessionId: req.params.sessionId, remoteAddress: req.socket.remoteAddress },
      'Dubbing subscriber connected'
    );
  });

  // ── Health endpoints ──────────────────────────────────────────────────────

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true, engine: config.engine });
  });

  app.get('/readyz', (_req, res) => {
    res.status(200).json({ ok: true, activeSessions: sessions.size });
  });

  // ── Start HTTP server ─────────────────────────────────────────────────────

  const server = app.listen(config.app.port, () => {
    logger.info(
      { port: config.app.port, engine: config.engine },
      'HTTP server listening — POST /sessions to start a stream'
    );
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down');
    for (const [, session] of sessions) {
      try { await session.stop(); } catch { /* ignore */ }
    }
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

}

main().catch((error) => {
  logger.error({ err: error }, 'Fatal startup error');
  process.exit(1);
});

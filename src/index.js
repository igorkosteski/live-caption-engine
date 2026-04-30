const fs = require('fs');

require('dotenv').config();

const express = require('express');
const logger = require('./logger');
const { buildConfig } = require('./config');
const { createEngine } = require('./engines');
const RtmpStreamSession = require('./rtmp-stream-session');
const LiveWebVtt = require('./captions/live-webvtt');

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
    streamConfig: config.stream
  });

  const streamSession = new RtmpStreamSession({
    logger,
    streamConfig: config.stream,
    engine
  });

  const captions = config.captions.enabled
    ? new LiveWebVtt({
        logger,
        segmentDurationMs: config.captions.segmentDurationMs,
        windowSegments: config.captions.windowSegments,
        basePath: config.captions.basePath
      })
    : null;

  if (captions) {
    engine.on('final-caption', (cue) => {
      captions.addCue(cue);
    });

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
        captionsBasePath: config.captions.basePath
      },
      'HTTP server listening'
    );
  });

  await streamSession.start();

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down');

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

const fs = require('fs');

require('dotenv').config();

const express = require('express');
const logger = require('./logger');
const { buildConfig } = require('./config');
const { createEngine } = require('./engines');
const RtmpStreamSession = require('./rtmp-stream-session');

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

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true, engine: config.engine });
  });

  app.get('/readyz', (_req, res) => {
    res.status(200).json({ ok: true, source: 'rtmp', engine: config.engine });
  });

  const server = app.listen(config.app.port, () => {
    logger.info({ port: config.app.port }, 'HTTP server listening');
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

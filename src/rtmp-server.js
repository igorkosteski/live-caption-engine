// RTMP server for local dev/testing (not for production)
const NodeMediaServer = require('node-media-server');
const { buildConfig } = require('./config');
const logger = require('./logger');

const config = buildConfig();

const nmsConfig = {
  rtmp: {
    port: process.env.RTMP_PORT || 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60
  },
  http: {
    port: 8000,
    allow_origin: '*'
  }
};

const nms = new NodeMediaServer(nmsConfig);

nms.on('prePublish', async (id, StreamPath, args) => {
  logger.info({ id, StreamPath, args }, '[RTMP] prePublish');
  // Here you would trigger session creation, e.g. startSession({ sessionId: StreamPath, ... })
});

nms.on('donePublish', async (id, StreamPath, args) => {
  logger.info({ id, StreamPath, args }, '[RTMP] donePublish');
  // Here you would trigger session teardown
});

nms.run();

logger.info({ port: nmsConfig.rtmp.port }, '[RTMP] RTMP server started');

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBool = (value, fallback = false) => {
  if (typeof value === 'undefined') {
    return fallback;
  }
  return String(value).toLowerCase() === 'true';
};

function buildConfig() {
  const engine = process.env.ENGINE || 'soniox';

  const config = {
    app: {
      port: toInt(process.env.PORT, 8080),
      logLevel: process.env.LOG_LEVEL || 'info'
    },
    stream: {
      rtmpUrl: requiredEnv('RTMP_URL'),
      sampleRate: toInt(process.env.AUDIO_SAMPLE_RATE, 16000),
      channels: toInt(process.env.AUDIO_CHANNELS, 1),
      ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
      noAudioTimeoutMs: toInt(process.env.NO_AUDIO_TIMEOUT_MS, 15000),
      reconnectDelayMs: toInt(process.env.RECONNECT_DELAY_MS, 3000),
      maxRetries: toInt(process.env.MAX_RETRIES, 0)
    },
    engine,
    soniox: {
      apiKey: requiredEnv('SONIOX_API_KEY'),
      model: process.env.SONIOX_MODEL || 'stt-rt-preview',
      wsUrl:
        process.env.SONIOX_WS_URL ||
        'wss://stt-rt.soniox.com/transcribe-websocket',
      enableTranslation: toBool(process.env.ENABLE_TRANSLATION, false),
      translationType: process.env.TRANSLATION_TYPE || 'one_way',
      translationTargetLanguage: process.env.TRANSLATION_TARGET_LANGUAGE || 'en'
    }
  };

  return config;
}

module.exports = { buildConfig };

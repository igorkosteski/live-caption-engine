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
      rtmpUrl: process.env.RTMP_URL || '',  // optional — provided per-session via POST /sessions
      sampleRate: toInt(process.env.AUDIO_SAMPLE_RATE, 16000),
      channels: toInt(process.env.AUDIO_CHANNELS, 1),
      ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
      noAudioTimeoutMs: toInt(process.env.NO_AUDIO_TIMEOUT_MS, 15000),
      reconnectDelayMs: toInt(process.env.RECONNECT_DELAY_MS, 3000),
      maxRetries: toInt(process.env.MAX_RETRIES, 0)
    },
    captions: {
      enabled: toBool(process.env.CAPTIONS_ENABLED, true),
      segmentDurationMs: toInt(process.env.CAPTIONS_SEGMENT_DURATION_MS, 6000),
      windowSegments: toInt(process.env.CAPTIONS_WINDOW_SEGMENTS, 5),
      basePath: process.env.CAPTIONS_BASE_PATH || '/captions'
    },
    mediapackage: {
      // Base egress URL used by the manifest proxy to fetch and re-serve the MPv2 master manifest
      // with EXT-X-MEDIA subtitle tracks injected. Leave empty to disable the proxy.
      // e.g. https://<group>.egress.<id>.mediapackagev2.<region>.amazonaws.com/out/v1/<group>/<ch>/<ep>
      originUrl: (process.env.MEDIAPACKAGE_ORIGIN_URL || '').replace(/\/+$/, '')
    },
    dubbing: {
      enabled: toBool(process.env.DUBBING_ENABLED, false),
      // 'gemini' uses Gemini Live audio-in/audio-out; 'polly' uses AWS Polly TTS on translated captions.
      engine: process.env.DUBBING_ENGINE || 'gemini',
      // Defaults to the same languages as translation if not specified separately.
      targetLanguages: (process.env.DUBBING_TARGET_LANGUAGES || process.env.TRANSLATION_TARGET_LANGUAGES || process.env.TRANSLATION_TARGET_LANGUAGE || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      // Gemini-specific: voice name applied to all dubbed languages.
      // Voices: Aoede, Charon, Fenrir, Kore, Puck
      geminiVoice: process.env.DUBBING_GEMINI_VOICE || 'Aoede',
      // Gemini dubbing API config — loaded regardless of the main transcription engine
      // so that DUBBING_ENGINE=gemini works with ENGINE=soniox too.
      geminiApiKey: process.env.GEMINI_API_KEY || '',
      geminiModel: process.env.GEMINI_DUBBING_MODEL || process.env.GEMINI_MODEL || 'gemini-2.0-flash-live-001',
      geminiSourceLanguage: process.env.TRANSLATION_SOURCE_LANGUAGE || '',
      // AWS region for Polly TTS synthesis.
      awsRegion: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
      // Polly-specific: comma-separated overrides e.g. "en:Matthew,de:Hans"
      pollyVoices: Object.fromEntries(
        (process.env.POLLY_VOICES || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((pair) => pair.split(':').map((p) => p.trim()))
          .filter(([lang, voice]) => lang && voice)
      ),
      // Sub-path prefix under ingestUrl for audio HLS segments, e.g. "dub-audio".
      // Each language gets "<audioPath>-<lang>/audio.m3u8" and "<audioPath>-<lang>/seg-N.aac".
      audioPath: process.env.DUBBING_AUDIO_PATH || 'dub-audio'
    },
    engine,
    soniox: engine === 'soniox' ? {
      apiKey: requiredEnv('SONIOX_API_KEY'),
      model: process.env.SONIOX_MODEL || 'stt-rt-preview',
      wsUrl:
        process.env.SONIOX_WS_URL ||
        'wss://stt-rt.soniox.com/transcribe-websocket',
      enableTranslation: toBool(process.env.ENABLE_TRANSLATION, false),
      translationType: process.env.TRANSLATION_TYPE || 'one_way',
      // Comma-separated BCP-47 codes, e.g. "en,de,fr"
      translationTargetLanguages: (process.env.TRANSLATION_TARGET_LANGUAGES || process.env.TRANSLATION_TARGET_LANGUAGE || 'en')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      // BCP-47 code of the spoken source language; leave empty to let Soniox auto-detect.
      translationSourceLanguage: process.env.TRANSLATION_SOURCE_LANGUAGE || '',
      // When true, requests speaker tags from Soniox and encodes them as WebVTT <v> voice spans.
      enableDiarization: toBool(process.env.SONIOX_ENABLE_DIARIZATION, false)
    } : null,
    gemini: engine === 'gemini' ? {
      apiKey: requiredEnv('GEMINI_API_KEY'),
      // Model name without the "models/" prefix, e.g. gemini-2.0-flash-live-001
      model: process.env.GEMINI_MODEL || 'gemini-2.0-flash-live-001',
      enableTranslation: toBool(process.env.ENABLE_TRANSLATION, false),
      targetLanguages: (process.env.TRANSLATION_TARGET_LANGUAGES || process.env.TRANSLATION_TARGET_LANGUAGE || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      sourceLanguage: process.env.TRANSLATION_SOURCE_LANGUAGE || ''
    } : null
  };

  return config;
}

module.exports = { buildConfig };

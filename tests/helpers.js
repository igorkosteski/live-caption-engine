'use strict';

/** Minimal silent pino-compatible logger for tests. */
const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  child: () => logger
};

function makeStreamConfig(overrides = {}) {
  return {
    sampleRate: 16000,
    channels: 1,
    rtmpUrl: 'rtmp://localhost/live/test',
    ffmpegPath: 'ffmpeg',
    noAudioTimeoutMs: 15000,
    reconnectDelayMs: 100,
    maxRetries: 0,
    ...overrides
  };
}

function makeSonioxConfig(overrides = {}) {
  return {
    apiKey: 'test-key',
    model: 'stt-rt-preview',
    wsUrl: 'wss://stt-rt.soniox.com/transcribe-websocket',
    enableTranslation: false,
    translationType: 'one_way',
    translationTargetLanguages: ['en'],
    translationSourceLanguage: '',
    enableDiarization: false,
    ...overrides
  };
}

function makeGeminiConfig(overrides = {}) {
  return {
    apiKey: 'test-key',
    model: 'gemini-2.0-flash-live-001',
    enableTranslation: false,
    targetLanguages: [],
    sourceLanguage: '',
    ...overrides
  };
}

/** Builds a fake Express response that records written data. */
function makeFakeRes() {
  const written = [];
  const listeners = {};
  const res = {
    written,
    write: jest.fn((data) => written.push(data)),
    on: (event, cb) => { listeners[event] = cb; },
    emit: (event, ...args) => { if (listeners[event]) listeners[event](...args); }
  };
  return res;
}

module.exports = { logger, makeStreamConfig, makeSonioxConfig, makeGeminiConfig, makeFakeRes };

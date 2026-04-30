'use strict';

const { logger, makeSonioxConfig, makeGeminiConfig } = require('./helpers');

// ── config ──────────────────────────────────────────────────────────────────

describe('buildConfig', () => {
  const requiredEnvBase = {
    RTMP_URL: 'rtmp://localhost/live/test',
    ENGINE: 'soniox',
    SONIOX_API_KEY: 'sk-test'
  };

  function withEnv(vars, fn) {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  beforeEach(() => {
    // Clear cached module so buildConfig re-reads env on each test.
    jest.resetModules();
  });

  test('builds soniox config with defaults', () => {
    withEnv(requiredEnvBase, () => {
      const { buildConfig } = require('../src/config');
      const cfg = buildConfig();
      expect(cfg.engine).toBe('soniox');
      expect(cfg.soniox.apiKey).toBe('sk-test');
      expect(cfg.soniox.model).toBe('stt-rt-preview');
      expect(cfg.gemini).toBeNull();
    });
  });

  test('builds gemini config', () => {
    withEnv({ ...requiredEnvBase, ENGINE: 'gemini', GEMINI_API_KEY: 'gk-test' }, () => {
      const { buildConfig } = require('../src/config');
      const cfg = buildConfig();
      expect(cfg.engine).toBe('gemini');
      expect(cfg.gemini.apiKey).toBe('gk-test');
      expect(cfg.soniox).toBeNull();
    });
  });

  test('throws when RTMP_URL missing', () => {
    withEnv({ RTMP_URL: '', ENGINE: 'soniox', SONIOX_API_KEY: 'k' }, () => {
      jest.resetModules();
      const { buildConfig } = require('../src/config');
      expect(() => buildConfig()).toThrow('RTMP_URL');
    });
  });

  test('parses POLLY_VOICES into object', () => {
    withEnv({ ...requiredEnvBase, POLLY_VOICES: 'en:Joanna,de:Daniel' }, () => {
      const { buildConfig } = require('../src/config');
      const cfg = buildConfig();
      expect(cfg.dubbing.pollyVoices).toEqual({ en: 'Joanna', de: 'Daniel' });
    });
  });

  test('enableDiarization defaults to false', () => {
    withEnv(requiredEnvBase, () => {
      const { buildConfig } = require('../src/config');
      const cfg = buildConfig();
      expect(cfg.soniox.enableDiarization).toBe(false);
    });
  });

  test('SONIOX_ENABLE_DIARIZATION=true sets flag', () => {
    withEnv({ ...requiredEnvBase, SONIOX_ENABLE_DIARIZATION: 'true' }, () => {
      const { buildConfig } = require('../src/config');
      const cfg = buildConfig();
      expect(cfg.soniox.enableDiarization).toBe(true);
    });
  });

  test('TRANSLATION_TARGET_LANGUAGES parsed correctly', () => {
    withEnv({ ...requiredEnvBase, TRANSLATION_TARGET_LANGUAGES: 'en,de,fr' }, () => {
      const { buildConfig } = require('../src/config');
      const cfg = buildConfig();
      expect(cfg.soniox.translationTargetLanguages).toEqual(['en', 'de', 'fr']);
    });
  });
});

// ── base-engine ──────────────────────────────────────────────────────────────

describe('BaseEngine', () => {
  const BaseEngine = require('../src/engines/base-engine');

  test('extends EventEmitter', () => {
    const { EventEmitter } = require('events');
    const e = new BaseEngine(logger);
    expect(e).toBeInstanceOf(EventEmitter);
  });

  test('start() throws', async () => {
    const e = new BaseEngine(logger);
    await expect(e.start()).rejects.toThrow('start()');
  });

  test('sendAudio() throws', () => {
    const e = new BaseEngine(logger);
    expect(() => e.sendAudio()).toThrow('sendAudio()');
  });

  test('finalize() throws', async () => {
    const e = new BaseEngine(logger);
    await expect(e.finalize()).rejects.toThrow('finalize()');
  });

  test('stop() throws', async () => {
    const e = new BaseEngine(logger);
    await expect(e.stop()).rejects.toThrow('stop()');
  });
});

// ── engines/index (factory) ──────────────────────────────────────────────────

describe('createEngine', () => {
  const { createEngine } = require('../src/engines');
  const SonioxEngine = require('../src/engines/soniox-engine');
  const SonioxMultiEngine = require('../src/engines/soniox-multi-engine');
  const GeminiEngine = require('../src/engines/gemini-engine');
  const streamConfig = require('./helpers').makeStreamConfig();

  test('returns SonioxEngine for single language', () => {
    const e = createEngine({
      engineName: 'soniox',
      logger,
      sonioxConfig: makeSonioxConfig({ enableTranslation: true, translationTargetLanguages: ['en'] }),
      streamConfig
    });
    expect(e).toBeInstanceOf(SonioxEngine);
  });

  test('returns SonioxMultiEngine for multiple languages', () => {
    const e = createEngine({
      engineName: 'soniox',
      logger,
      sonioxConfig: makeSonioxConfig({ enableTranslation: true, translationTargetLanguages: ['en', 'de'] }),
      streamConfig
    });
    expect(e).toBeInstanceOf(SonioxMultiEngine);
  });

  test('returns GeminiEngine', () => {
    const e = createEngine({
      engineName: 'gemini',
      logger,
      geminiConfig: makeGeminiConfig(),
      streamConfig
    });
    expect(e).toBeInstanceOf(GeminiEngine);
  });

  test('throws for unknown engine', () => {
    expect(() => createEngine({ engineName: 'unknown', logger, streamConfig })).toThrow('Unsupported engine');
  });
});

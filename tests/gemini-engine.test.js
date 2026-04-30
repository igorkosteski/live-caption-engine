'use strict';

const { logger, makeGeminiConfig, makeStreamConfig } = require('./helpers');

// ── WS mock ──────────────────────────────────────────────────────────────────

let lastWs = null;

jest.mock('ws', () => {
  const { EventEmitter } = require('events');

  return class FakeWS extends EventEmitter {
    constructor() {
      super();
      this.readyState = FakeWS.OPEN;
      this.sent = [];
      lastWs = this;
      setImmediate(() => {
        this.emit('open');
        // Immediately reply with setupComplete so start() resolves.
        setImmediate(() => this.serverSend({ setupComplete: {} }));
      });
    }

    send(data) { this.sent.push(data); }
    close() { this.readyState = FakeWS.CLOSED; this.emit('close', 1000, ''); }
    terminate() { this.readyState = FakeWS.CLOSED; }

    serverSend(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
  };
});

const FakeWS = require('ws');
FakeWS.OPEN = 1;
FakeWS.CONNECTING = 0;
FakeWS.CLOSED = 3;

// ── Tests ────────────────────────────────────────────────────────────────────

const GeminiEngine = require('../src/engines/gemini-engine');

function makeEngine(geminiOverrides = {}, streamOverrides = {}) {
  return new GeminiEngine({
    logger,
    geminiConfig: makeGeminiConfig(geminiOverrides),
    streamConfig: makeStreamConfig(streamOverrides)
  });
}

describe('GeminiEngine', () => {
  describe('start()', () => {
    test('resolves after setupComplete', async () => {
      const engine = makeEngine();
      await engine.start();
      expect(engine.connected).toBe(true);
    });

    test('sends setup message with TEXT modality', async () => {
      const engine = makeEngine();
      await engine.start();
      const setup = JSON.parse(lastWs.sent[0]);
      expect(setup.setup.generationConfig.responseModalities).toEqual(['TEXT']);
    });

    test('system instruction is transcription-only when translation disabled', async () => {
      const engine = makeEngine({ enableTranslation: false });
      await engine.start();
      const setup = JSON.parse(lastWs.sent[0]);
      const instruction = setup.setup.systemInstruction.parts[0].text;
      expect(instruction).toMatch(/transcription/i);
      expect(instruction).not.toMatch(/JSON/);
    });

    test('system instruction includes JSON format when translation enabled', async () => {
      const engine = makeEngine({ enableTranslation: true, targetLanguages: ['en', 'de'] });
      await engine.start();
      const setup = JSON.parse(lastWs.sent[0]);
      const instruction = setup.setup.systemInstruction.parts[0].text;
      expect(instruction).toMatch(/JSON/);
      expect(instruction).toMatch(/en/);
      expect(instruction).toMatch(/de/);
    });
  });

  describe('sendAudio()', () => {
    test('sends base64-encoded chunk with correct mimeType', async () => {
      const engine = makeEngine();
      await engine.start();
      const buf = Buffer.alloc(320, 0);
      engine.sendAudio(buf);
      const msg = JSON.parse(lastWs.sent[1]);
      expect(msg.realtimeInput.mediaChunks[0].mimeType).toMatch(/audio\/pcm/);
      expect(msg.realtimeInput.mediaChunks[0].data).toBe(buf.toString('base64'));
    });

    test('advances audioMs', async () => {
      const engine = makeEngine();
      await engine.start();
      const before = engine.audioMs;
      engine.sendAudio(Buffer.alloc(3200, 0)); // 100ms at 16kHz mono s16le
      expect(engine.audioMs).toBeCloseTo(before + 100, 0);
    });

    test('no-ops when not connected', () => {
      const engine = makeEngine();
      // ws is null before start()
      expect(() => engine.sendAudio(Buffer.alloc(64))).not.toThrow();
    });
  });

  describe('final-caption event (transcription only)', () => {
    test('emits on turnComplete', async () => {
      const engine = makeEngine();
      await engine.start();

      const captions = [];
      engine.on('final-caption', (c) => captions.push(c));

      lastWs.serverSend({ serverContent: { modelTurn: { parts: [{ text: 'Hello world' }] } } });
      lastWs.serverSend({ serverContent: { turnComplete: true } });

      expect(captions).toHaveLength(1);
      expect(captions[0].text).toBe('Hello world');
    });

    test('does not emit for empty turn', async () => {
      const engine = makeEngine();
      await engine.start();

      const captions = [];
      engine.on('final-caption', (c) => captions.push(c));

      lastWs.serverSend({ serverContent: { modelTurn: { parts: [{ text: '   ' }] } } });
      lastWs.serverSend({ serverContent: { turnComplete: true } });

      expect(captions).toHaveLength(0);
    });
  });

  describe('translation output parsing', () => {
    async function startWithTranslation(langs = ['en', 'de']) {
      const engine = makeEngine({ enableTranslation: true, targetLanguages: langs });
      await engine.start();
      return engine;
    }

    test('parses valid JSON and emits source + translated captions', async () => {
      const engine = await startWithTranslation();

      const source = [];
      const translated = [];
      engine.on('final-caption', (c) => source.push(c));
      engine.on('final-caption-translated', (c) => translated.push(c));

      const payload = JSON.stringify({
        transcript: 'Guten Tag',
        translations: { en: 'Good day', de: 'Guten Tag' }
      });
      lastWs.serverSend({ serverContent: { modelTurn: { parts: [{ text: payload }] } } });
      lastWs.serverSend({ serverContent: { turnComplete: true } });

      expect(source[0].text).toBe('Guten Tag');
      expect(translated.find((c) => c.language === 'en').text).toBe('Good day');
      expect(translated.find((c) => c.language === 'de').text).toBe('Guten Tag');
    });

    test('strips code fences before parsing', async () => {
      const engine = await startWithTranslation(['en']);

      const source = [];
      engine.on('final-caption', (c) => source.push(c));

      const payload = '```json\n{"transcript":"Hi","translations":{"en":"Hi"}}\n```';
      lastWs.serverSend({ serverContent: { modelTurn: { parts: [{ text: payload }] } } });
      lastWs.serverSend({ serverContent: { turnComplete: true } });

      expect(source[0].text).toBe('Hi');
    });

    test('falls back to plain text when JSON is invalid', async () => {
      const engine = await startWithTranslation(['en']);

      const source = [];
      engine.on('final-caption', (c) => source.push(c));

      lastWs.serverSend({ serverContent: { modelTurn: { parts: [{ text: 'not json at all' }] } } });
      lastWs.serverSend({ serverContent: { turnComplete: true } });

      expect(source[0].text).toBe('not json at all');
    });
  });

  describe('stop()', () => {
    test('closes WS and marks disconnected', async () => {
      const engine = makeEngine();
      await engine.start();
      await engine.stop();
      expect(engine.connected).toBe(false);
    });
  });
});

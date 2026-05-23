'use strict';

/**
 * SonioxEngine tests.
 *
 * The WebSocket is mocked so no real network calls are made.
 * We intercept the ws constructor via jest.mock and expose the server-side
 * handle so tests can push messages to the engine.
 */

const { logger, makeSonioxConfig, makeStreamConfig } = require('./helpers');

// ── WS mock ──────────────────────────────────────────────────────────────────

let lastWs = null;

jest.mock('ws', () => {
  const { EventEmitter } = require('events');

  return class FakeWS extends EventEmitter {
    constructor() {
      super();
      this.readyState = FakeWS.CONNECTING;
      this.sent = [];
      lastWs = this;

      setImmediate(() => {
        this.readyState = FakeWS.OPEN;
        this.emit('open');
      });
    }

    send(data) { this.sent.push(data); }
    close() { this.readyState = FakeWS.CLOSED; this.emit('close', 1000, ''); }
    terminate() { this.readyState = FakeWS.CLOSED; }

    // Helper: push a JSON message from the "server"
    serverSend(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
  };
});

// Apply static constants after the class is defined inside the mock factory.
const FakeWS = require('ws');
FakeWS.CONNECTING = 0;
FakeWS.OPEN = 1;
FakeWS.CLOSED = 3;

// ── Tests ────────────────────────────────────────────────────────────────────

const SonioxEngine = require('../src/engines/soniox-engine');

function makeEngine(sonioxOverrides = {}, streamOverrides = {}) {
  return new SonioxEngine({
    logger,
    sonioxConfig: makeSonioxConfig(sonioxOverrides),
    streamConfig: makeStreamConfig(streamOverrides)
  });
}

describe('SonioxEngine', () => {
  describe('start()', () => {
    test('resolves once WS opens and sends config', async () => {
      const engine = makeEngine();
      await engine.start();
      expect(engine.connected).toBe(true);
      const configMsg = JSON.parse(lastWs.sent[0]);
      expect(configMsg).toMatchObject({ model: 'stt-rt-preview', audio_format: 'pcm_s16le' });
    });

    test('includes language_hints when source language set', async () => {
      const engine = makeEngine({ translationSourceLanguage: 'mk' });
      await engine.start();
      const configMsg = JSON.parse(lastWs.sent[0]);
      expect(configMsg.language_hints).toEqual(['mk']);
    });

    test('includes enable_speaker_tags when diarization enabled', async () => {
      const engine = makeEngine({ enableDiarization: true });
      await engine.start();
      const configMsg = JSON.parse(lastWs.sent[0]);
      expect(configMsg.enable_speaker_tags).toBe(true);
    });

    test('does NOT include enable_speaker_tags when diarization disabled', async () => {
      const engine = makeEngine({ enableDiarization: false });
      await engine.start();
      const configMsg = JSON.parse(lastWs.sent[0]);
      expect(configMsg.enable_speaker_tags).toBeUndefined();
    });

    test('includes translation config when enabled', async () => {
      const engine = makeEngine({
        enableTranslation: true,
        translationTargetLanguages: ['en'],
        translationType: 'one_way'
      });
      await engine.start();
      const configMsg = JSON.parse(lastWs.sent[0]);
      expect(configMsg.translation).toMatchObject({ type: 'one_way', target_language: 'en' });
    });
  });

  describe('sendAudio()', () => {
    test('sends binary buffer when connected', async () => {
      const engine = makeEngine();
      await engine.start();
      const buf = Buffer.from([1, 2, 3]);
      engine.sendAudio(buf);
      // First sent message is the config, second is audio.
      expect(lastWs.sent[1]).toBe(buf);
    });

    test('no-ops when WS not open', () => {
      const engine = makeEngine();
      // Not started, ws is null.
      expect(() => engine.sendAudio(Buffer.from([1]))).not.toThrow();
    });
  });

  describe('final-caption event', () => {
    test('emits final-caption for finalized tokens', async () => {
      const engine = makeEngine();
      await engine.start();

      const captions = [];
      engine.on('final-caption', (cue) => captions.push(cue));

      lastWs.serverSend({
        tokens: [
          { text: 'Hello ', is_final: true, start_ms: 0, end_ms: 500 },
          { text: 'world', is_final: true, start_ms: 500, end_ms: 1000 }
        ]
      });

      expect(captions).toHaveLength(1);
      expect(captions[0].text).toBe('Hello world');
      expect(captions[0].startMs).toBe(0);
      expect(captions[0].endMs).toBe(1000);
    });

    test('does not emit for non-final tokens', async () => {
      const engine = makeEngine();
      await engine.start();

      const captions = [];
      engine.on('final-caption', (cue) => captions.push(cue));

      lastWs.serverSend({
        tokens: [{ text: 'Partial', is_final: false }]
      });

      expect(captions).toHaveLength(0);
    });

    test('skips tokens without valid timing', async () => {
      const engine = makeEngine();
      await engine.start();

      const captions = [];
      engine.on('final-caption', (cue) => captions.push(cue));

      lastWs.serverSend({
        tokens: [{ text: 'No timing', is_final: true }]
      });

      expect(captions).toHaveLength(0);
    });
  });

  describe('final-caption-translated event', () => {
    test('emits translated captions with language', async () => {
      const engine = makeEngine({ enableTranslation: true, translationTargetLanguages: ['en'] });
      await engine.start();

      const translated = [];
      engine.on('final-caption-translated', (cue) => translated.push(cue));

      lastWs.serverSend({
        tokens: [
          { text: 'Hallo', is_final: true, start_ms: 0, end_ms: 500 }
        ],
        translations: [
          {
            language: 'en',
            tokens: [
              { text: 'Hello', is_final: true, start_ms: 0, end_ms: 500 }
            ]
          }
        ]
      });

      expect(translated).toHaveLength(1);
      expect(translated[0].language).toBe('en');
      expect(translated[0].text).toBe('Hello');
    });

    test('falls back to final_audio_proc_ms timing when translated tokens have no timestamps', async () => {
      const engine = makeEngine({ enableTranslation: true, translationTargetLanguages: ['en'] });
      await engine.start();

      const translated = [];
      engine.on('final-caption-translated', (cue) => translated.push(cue));

      lastWs.serverSend({
        tokens: [{ text: 'Извор', is_final: true }],
        translations: [{
          language: 'en',
          tokens: [{ text: 'Source', is_final: true }]
        }],
        final_audio_proc_ms: 204480
      });

      expect(translated).toHaveLength(1);
      expect(translated[0].language).toBe('en');
      expect(translated[0].text).toBe('Source');
      expect(translated[0].startMs).toBe(203280);
      expect(translated[0].endMs).toBe(204480);
    });

    test('emits translated captions from inline translation tokens in message.tokens', async () => {
      const engine = makeEngine({ enableTranslation: true, translationTargetLanguages: ['en'] });
      await engine.start();

      const source = [];
      const translated = [];
      engine.on('final-caption', (cue) => source.push(cue));
      engine.on('final-caption-translated', (cue) => translated.push(cue));

      lastWs.serverSend({
        tokens: [
          { text: 'Извор ', is_final: true, start_ms: 1000, end_ms: 1400, translation_status: 'none' },
          { text: 'текст', is_final: true, start_ms: 1400, end_ms: 2000, translation_status: 'none' },
          { text: 'Source ', is_final: true, language: 'en', translation_status: 'translation' },
          { text: 'text', is_final: true, language: 'en', translation_status: 'translation' }
        ],
        final_audio_proc_ms: 2200
      });

      expect(source).toHaveLength(1);
      expect(source[0].text).toBe('Извор текст');
      expect(translated).toHaveLength(1);
      expect(translated[0].language).toBe('en');
      expect(translated[0].text).toBe('Source text');
      expect(translated[0].startMs).toBe(1000);
      expect(translated[0].endMs).toBe(2000);
    });
  });

  describe('diarization', () => {
    test('emits per-speaker cues with voice spans', async () => {
      const engine = makeEngine({ enableDiarization: true });
      await engine.start();

      const captions = [];
      engine.on('final-caption', (cue) => captions.push(cue));

      lastWs.serverSend({
        tokens: [
          { text: 'Hi ', is_final: true, start_ms: 0, end_ms: 300, speaker: 'S1' },
          { text: 'there', is_final: true, start_ms: 300, end_ms: 600, speaker: 'S1' },
          { text: ' how', is_final: true, start_ms: 600, end_ms: 900, speaker: 'S2' },
          { text: ' are you', is_final: true, start_ms: 900, end_ms: 1200, speaker: 'S2' }
        ]
      });

      expect(captions).toHaveLength(2);
      expect(captions[0].text).toBe('<v S1>Hi there</v>');
      expect(captions[0].speaker).toBe('S1');
      expect(captions[1].text).toBe('<v S2>how are you</v>');
      expect(captions[1].speaker).toBe('S2');
    });
  });

  describe('error handling', () => {
    test('logs Soniox error_code messages', async () => {
      const engine = makeEngine();
      await engine.start();

      lastWs.serverSend({ error_code: 'AUTH_FAILED', error_message: 'bad key' });

      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('stop()', () => {
    test('closes the WebSocket', async () => {
      const engine = makeEngine();
      await engine.start();
      await engine.stop();
      expect(engine.connected).toBe(false);
    });
  });
});

'use strict';

const { EventEmitter } = require('events');
const { logger } = require('./helpers');

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

    send(data) {
      this.sent.push(data);
    }

    close() {
      this.readyState = FakeWS.CLOSED;
      this.emit('close', 1000, '');
    }

    terminate() {
      this.readyState = FakeWS.CLOSED;
    }

    serverSend(obj) {
      this.emit('message', Buffer.from(JSON.stringify(obj)));
    }
  };
});

const FakeWS = require('ws');
FakeWS.CONNECTING = 0;
FakeWS.OPEN = 1;
FakeWS.CLOSED = 3;

const SonioxDubbingEngine = require('../src/engines/soniox-dubbing-engine');

function makeEngine(overrides = {}) {
  const engine = new EventEmitter();
  const dubbing = new SonioxDubbingEngine({
    logger,
    engine,
    targetLanguage: 'en',
    apiKey: 'test-key',
    ...overrides
  });

  return { engine, dubbing };
}

describe('SonioxDubbingEngine', () => {
  test('start() opens ws and sends config + start message', async () => {
    const { dubbing } = makeEngine();
    await dubbing.start();

    expect(dubbing.connected).toBe(true);

    const config = JSON.parse(lastWs.sent[0]);
    expect(config).toMatchObject({
      api_key: 'test-key',
      model: 'tts-rt-v1',
      language: 'en',
      voice: 'Adrian',
      audio_format: 'pcm_s16le',
      sample_rate: 24000
    });

    const startMessage = JSON.parse(lastWs.sent[1]);
    expect(startMessage).toMatchObject({
      stream_id: expect.any(String),
      text: '',
      text_end: false
    });
  });

  test('subscribes to final-caption-translated on start', async () => {
    const { engine, dubbing } = makeEngine();
    await dubbing.start();
    expect(engine.listenerCount('final-caption-translated')).toBe(1);
  });

  test('for matching language sends text chunk to Soniox TTS stream', async () => {
    const { engine, dubbing } = makeEngine();
    await dubbing.start();

    engine.emit('final-caption-translated', { language: 'en', text: 'Hello world' });

    const textMsg = JSON.parse(lastWs.sent[2]);
    expect(textMsg.text).toBe('Hello world');
    expect(textMsg.text_end).toBe(false);
    expect(textMsg.stream_id).toBeTruthy();
  });

  test('ignores captions for other languages', async () => {
    const { engine, dubbing } = makeEngine();
    await dubbing.start();

    engine.emit('final-caption-translated', { language: 'de', text: 'Hallo' });

    // Initial config + start message only.
    expect(lastWs.sent).toHaveLength(2);
  });

  test('pushes received audio chunks into dubbingStream', async () => {
    const { dubbing } = makeEngine();
    await dubbing.start();

    const received = [];
    dubbing.dubbingStream.on('data', (chunk) => received.push(chunk));

    const audio = Buffer.from([1, 2, 3, 4]);
    lastWs.serverSend({ audio: audio.toString('base64') });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(audio);
  });

  test('stop() removes listener and closes stream', async () => {
    const { engine, dubbing } = makeEngine();
    await dubbing.start();

    await dubbing.stop();

    expect(engine.listenerCount('final-caption-translated')).toBe(0);

    const finalMessage = JSON.parse(lastWs.sent[lastWs.sent.length - 1]);
    expect(finalMessage.text_end).toBe(true);
    expect(dubbing.connected).toBe(false);
  });
});

'use strict';

/**
 * PollyDubbingEngine tests.
 * AWS Polly is mocked so no real calls are made.
 */

const { EventEmitter } = require('events');
const { logger } = require('./helpers');

// ── Polly mock ───────────────────────────────────────────────────────────────

const pollyResponses = [];

jest.mock('@aws-sdk/client-polly', () => {
  class PollyClient {
    async send(command) {
      const bytes = pollyResponses.shift() || Buffer.alloc(16, 0);
      return {
        AudioStream: (async function* () { yield bytes; })()
      };
    }
  }
  class SynthesizeSpeechCommand {
    constructor(params) { this.params = params; }
  }
  return { PollyClient, SynthesizeSpeechCommand };
});

jest.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: jest.fn().mockReturnValue({})
}));

// ── Tests ────────────────────────────────────────────────────────────────────

const PollyDubbingEngine = require('../src/engines/polly-dubbing-engine');
const DubbingStream = require('../src/dubbing/dubbing-stream');

function makeEngine(lang = 'en') {
  const engine = new EventEmitter();  // Stand-in for the main transcription engine.
  const polly = new PollyDubbingEngine({
    logger,
    awsRegion: 'us-east-1',
    targetLanguage: lang,
    engine
  });
  return { polly, engine };
}

describe('PollyDubbingEngine', () => {
  beforeEach(() => pollyResponses.splice(0));

  test('has a DubbingStream', () => {
    const { polly } = makeEngine();
    expect(polly.dubbingStream).toBeInstanceOf(DubbingStream);
    expect(polly.dubbingStream.sampleRate).toBe(16000);
  });

  test('uses default voice for known language', () => {
    const { polly } = makeEngine('de');
    expect(polly._voiceId).toBe('Daniel');
  });

  test('throws for unknown language without voiceId override', () => {
    expect(() => new PollyDubbingEngine({
      logger,
      awsRegion: 'us-east-1',
      targetLanguage: 'xx',
      engine: new EventEmitter()
    })).toThrow(/No default Polly voice/);
  });

  test('uses provided voiceId override', () => {
    const polly = new PollyDubbingEngine({
      logger,
      awsRegion: 'us-east-1',
      targetLanguage: 'xx',
      voiceId: 'Matthew',
      engine: new EventEmitter()
    });
    expect(polly._voiceId).toBe('Matthew');
  });

  test('start() subscribes to final-caption-translated', () => {
    const { polly, engine } = makeEngine();
    polly.start();
    expect(engine.listenerCount('final-caption-translated')).toBe(1);
  });

  test('stop() removes listener', () => {
    const { polly, engine } = makeEngine();
    polly.start();
    polly.stop();
    expect(engine.listenerCount('final-caption-translated')).toBe(0);
  });

  test('ignores captions for other languages', () => {
    const { polly, engine } = makeEngine('en');
    polly.start();
    const spy = jest.spyOn(polly, '_synthesize');
    engine.emit('final-caption-translated', { language: 'de', text: 'Hallo' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('synthesizes audio and pushes to dubbingStream', async () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6]);
    pollyResponses.push(pcm);

    const { polly, engine } = makeEngine('en');
    polly.start();

    const received = [];
    polly.dubbingStream.on('data', (buf) => received.push(buf));

    engine.emit('final-caption-translated', { language: 'en', text: 'Hello' });

    // Drain the serial queue
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(received[0]).toEqual(pcm);
  });

  test('serial queue preserves synthesis order', async () => {
    const a = Buffer.from([1]);
    const b = Buffer.from([2]);
    pollyResponses.push(a, b);

    const { polly, engine } = makeEngine('en');
    polly.start();

    const received = [];
    polly.dubbingStream.on('data', (buf) => received.push(buf));

    engine.emit('final-caption-translated', { language: 'en', text: 'First' });
    engine.emit('final-caption-translated', { language: 'en', text: 'Second' });

    await new Promise((r) => setTimeout(r, 20));

    expect(received[0]).toEqual(a);
    expect(received[1]).toEqual(b);
  });
});

'use strict';

/**
 * MediaPackagePublisher tests.
 *
 * HTTPS PUT requests are intercepted via jest.mock('https') so no real
 * network calls are made.  The mock records every PUT and responds 200.
 */

const { logger } = require('./helpers');

// ── https mock ───────────────────────────────────────────────────────────────

const puts = [];

jest.mock('https', () => ({
  request: jest.fn((opts, cb) => {
    const body = [];
    const req = {
      write: jest.fn((data) => body.push(data)),
      end: jest.fn(() => {
        puts.push({ path: opts.path, headers: opts.headers, body: Buffer.concat(body) });

        const res = Object.assign(require('events').EventEmitter.prototype, {
          statusCode: 200
        });
        const resEmitter = Object.create(res);
        resEmitter._events = {};
        resEmitter._eventsCount = 0;
        resEmitter._maxListeners = undefined;

        cb(resEmitter);
        setImmediate(() => resEmitter.emit('end'));
      }),
      on: jest.fn()
    };
    return req;
  })
}));

// ── SignatureV4 mock ─────────────────────────────────────────────────────────

jest.mock('@aws-sdk/signature-v4', () => ({
  SignatureV4: jest.fn().mockImplementation(() => ({
    sign: jest.fn().mockImplementation(async (req) => ({
      ...req,
      port: req.port || '443'
    }))
  }))
}));

jest.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: jest.fn().mockReturnValue({})
}));

// ── Tests ────────────────────────────────────────────────────────────────────

const MediaPackagePublisher = require('../src/captions/mediapackage-publisher');
const LiveWebVtt = require('../src/captions/live-webvtt');

function makePublisher(overrides = {}) {
  const captions = new LiveWebVtt({
    logger,
    segmentDurationMs: 2000,
    windowSegments: 3,
    basePath: '/captions'
  });
  return {
    captions,
    publisher: new MediaPackagePublisher({
      logger,
      captions,
      ingestUrl: 'https://mp.example.com/in/v1/grp/ch/ep',
      awsRegion: 'us-east-1',
      subtitlePath: 'subtitles',
      ...overrides
    })
  };
}

describe('MediaPackagePublisher', () => {
  beforeEach(() => puts.splice(0));

  test('start() sets up interval and logs', () => {
    jest.useFakeTimers();
    const { publisher } = makePublisher();
    publisher.start();
    expect(publisher.pushTimer).not.toBeNull();
    publisher.stop();
    jest.useRealTimers();
  });

  test('stop() clears interval', () => {
    jest.useFakeTimers();
    const { publisher } = makePublisher();
    publisher.start();
    publisher.stop();
    expect(publisher.pushTimer).toBeNull();
    jest.useRealTimers();
  });

  test('does nothing on tick when no segments exist', async () => {
    const { publisher } = makePublisher();
    await publisher._publishPending();
    expect(puts).toHaveLength(0);
  });

  test('pushes segment VTT and playlist on tick', async () => {
    const { captions, publisher } = makePublisher();
    captions.addCue({ startMs: 0, endMs: 1000, text: 'Hello' });

    await publisher._publishPending();

    const vttPut = puts.find((p) => p.path.includes('.vtt'));
    const m3u8Put = puts.find((p) => p.path.includes('.m3u8'));
    expect(vttPut).toBeDefined();
    expect(m3u8Put).toBeDefined();
  });

  test('completed segment not pushed twice', async () => {
    const { captions, publisher } = makePublisher();
    // Add two cues in different segments.
    captions.addCue({ startMs: 0, endMs: 1000, text: 'Seg 0' });
    captions.addCue({ startMs: 2000, endMs: 3000, text: 'Seg 1' });

    await publisher._publishPending();
    const firstCount = puts.length;
    puts.splice(0);

    await publisher._publishPending();
    // Segment 0 is now "complete" (not latest) — should not be re-pushed.
    const seg0Puts = puts.filter((p) => p.path.includes('seg-0.vtt'));
    expect(seg0Puts).toHaveLength(0);
  });
});

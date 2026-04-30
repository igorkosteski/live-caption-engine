'use strict';

/**
 * AudioSegmentPublisher tests.
 *
 * FFmpeg encoding is mocked so no binary is required.
 * HTTPS PUT calls are mocked to record requests.
 */

const { logger } = require('./helpers');
const DubbingStream = require('../src/dubbing/dubbing-stream');

// ── FFmpeg mock (returns silent PCM-sized AAC) ───────────────────────────────

jest.mock('child_process', () => {
  const { EventEmitter } = require('events');
  const { Writable } = require('stream');
  return {
    spawn: jest.fn(() => {
      const proc = new EventEmitter();
      const chunks = [];
      proc.stdin = new Writable({
        write(chunk, _enc, cb) { chunks.push(chunk); cb(); }
      });
      proc.stdin.on('finish', () => {});
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();

      setImmediate(() => {
        // Emit a tiny fake AAC payload so the publisher has something to PUT.
        proc.stdout.emit('data', Buffer.alloc(64, 0xff));
        proc.emit('close', 0);
      });

      return proc;
    })
  };
});

// ── HTTPS mock ───────────────────────────────────────────────────────────────

const puts = [];

jest.mock('https', () => ({
  request: jest.fn((opts, cb) => {
    const body = [];
    const req = {
      write: jest.fn((d) => body.push(d)),
      end: jest.fn(() => {
        puts.push({ path: opts.path, body: Buffer.concat(body) });
        const { EventEmitter } = require('events');
        const res = new EventEmitter();
        res.statusCode = 200;
        cb(res);
        setImmediate(() => res.emit('end'));
      }),
      on: jest.fn()
    };
    return req;
  })
}));

jest.mock('@aws-sdk/signature-v4', () => ({
  SignatureV4: jest.fn().mockImplementation(() => ({
    sign: jest.fn().mockImplementation(async (req) => ({ ...req, port: '443' }))
  }))
}));

jest.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: jest.fn().mockReturnValue({})
}));

// ── Tests ────────────────────────────────────────────────────────────────────

const AudioSegmentPublisher = require('../src/dubbing/audio-segment-publisher');

function makePub(overrides = {}) {
  const ds = new DubbingStream({ logger, language: 'en', sampleRate: 16000, channels: 1 });
  const pub = new AudioSegmentPublisher({
    logger,
    dubbingStream: ds,
    ingestUrl: 'https://mp.example.com/in/v1/g/c/e',
    awsRegion: 'us-east-1',
    audioPath: 'dub-audio-en',
    segmentDurationMs: 1000,
    windowSegments: 3,
    ...overrides
  });
  return { ds, pub };
}

describe('AudioSegmentPublisher', () => {
  beforeEach(() => puts.splice(0));

  test('subscribes to dubbingStream data event on start()', () => {
    const { ds, pub } = makePub();
    pub.start();
    expect(ds.listenerCount('data')).toBe(1);
    pub.stop();
  });

  test('unsubscribes on stop()', () => {
    const { ds, pub } = makePub();
    pub.start();
    pub.stop();
    expect(ds.listenerCount('data')).toBe(0);
  });

  test('accumulates PCM until a full segment and encodes', async () => {
    const { ds, pub } = makePub({ segmentDurationMs: 500 });
    pub.start();

    // 500ms of s16le at 16kHz mono = 16000 * 1 * 2 * 0.5 = 16000 bytes
    const segBytes = 16000;
    ds.push(Buffer.alloc(segBytes, 0));

    // Wait for FFmpeg close + PUT
    await new Promise((r) => setTimeout(r, 50));

    const aacPut = puts.find((p) => p.path.includes('.aac'));
    expect(aacPut).toBeDefined();
    pub.stop();
  });

  test('does not encode before a full segment is buffered', async () => {
    const { ds, pub } = makePub({ segmentDurationMs: 5000 });
    pub.start();

    ds.push(Buffer.alloc(100, 0));  // Way less than a full segment
    await new Promise((r) => setImmediate(r));

    const aacPut = puts.find((p) => p.path.includes('.aac'));
    expect(aacPut).toBeUndefined();
    pub.stop();
  });

  test('pushes HLS playlist after segment', async () => {
    const { ds, pub } = makePub({ segmentDurationMs: 500 });
    pub.start();

    ds.push(Buffer.alloc(16000, 0));
    await new Promise((r) => setTimeout(r, 50));

    const m3u8Put = puts.find((p) => p.path.includes('.m3u8'));
    expect(m3u8Put).toBeDefined();
    const playlist = m3u8Put.body.toString();
    expect(playlist).toMatch('#EXTM3U');
    expect(playlist).toMatch('seg-0.aac');
    pub.stop();
  });

  test('sliding window limits playlist entries', async () => {
    const { ds, pub } = makePub({ segmentDurationMs: 500, windowSegments: 2 });
    pub.start();

    // Push 3 full segments.
    const segBytes = 16000;
    ds.push(Buffer.alloc(segBytes * 3, 0));
    await new Promise((r) => setTimeout(r, 100));

    const m3u8Puts = puts.filter((p) => p.path.includes('.m3u8'));
    const lastPlaylist = m3u8Puts[m3u8Puts.length - 1]?.body.toString() || '';
    // Should only reference at most 2 segments.
    const segMatches = lastPlaylist.match(/seg-\d+\.aac/g) || [];
    expect(segMatches.length).toBeLessThanOrEqual(2);
    pub.stop();
  });
});

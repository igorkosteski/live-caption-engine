'use strict';

/**
 * RtmpStreamSession tests.
 *
 * FFmpeg is mocked via jest.mock('child_process') so no real process is spawned.
 */

const { EventEmitter } = require('events');
const { logger, makeStreamConfig } = require('./helpers');

// ── child_process mock ───────────────────────────────────────────────────────

let fakeProcess = null;

jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    const proc = new (require('events').EventEmitter)();
    proc.killed = false;
    proc.stdout = new (require('events').EventEmitter)();
    proc.stderr = new (require('events').EventEmitter)();
    proc.kill = jest.fn((sig) => {
      proc.killed = true;
      setImmediate(() => proc.emit('close', 0, sig || null));
    });
    fakeProcess = proc;
    return proc;
  })
}));

// ── Minimal engine stub ───────────────────────────────────────────────────────

function makeEngineStub() {
  const stub = new EventEmitter();
  stub.connected = true;
  stub.start = jest.fn().mockResolvedValue(undefined);
  stub.sendAudio = jest.fn();
  stub.finalize = jest.fn().mockResolvedValue(undefined);
  stub.stop = jest.fn().mockResolvedValue(undefined);
  return stub;
}

// ── Tests ────────────────────────────────────────────────────────────────────

const RtmpStreamSession = require('../src/rtmp-stream-session');

function makeSession(streamOverrides = {}) {
  const engine = makeEngineStub();
  const session = new RtmpStreamSession({
    logger,
    streamConfig: makeStreamConfig(streamOverrides),
    engine
  });
  return { session, engine };
}

describe('RtmpStreamSession', () => {
  describe('start()', () => {
    test('starts the engine', async () => {
      const { session, engine } = makeSession();
      await session.start();
      expect(engine.start).toHaveBeenCalledTimes(1);
      session.stop();
    });

    test('spawns FFmpeg', async () => {
      const { spawn } = require('child_process');
      const { session } = makeSession();
      await session.start();
      expect(spawn).toHaveBeenCalled();
      session.stop();
    });
  });

  describe('audio forwarding', () => {
    test('calls engine.sendAudio on FFmpeg stdout data', async () => {
      const { session, engine } = makeSession();
      await session.start();
      const chunk = Buffer.from([1, 2, 3]);
      fakeProcess.stdout.emit('data', chunk);
      expect(engine.sendAudio).toHaveBeenCalledWith(chunk);
      session.stop();
    });

    test('emits audio event on FFmpeg stdout data', async () => {
      const { session } = makeSession();
      await session.start();
      const received = [];
      session.on('audio', (buf) => received.push(buf));
      const chunk = Buffer.from([4, 5]);
      fakeProcess.stdout.emit('data', chunk);
      expect(received).toEqual([chunk]);
      session.stop();
    });

    test('updates audioBytes counter', async () => {
      const { session } = makeSession();
      await session.start();
      fakeProcess.stdout.emit('data', Buffer.alloc(100));
      fakeProcess.stdout.emit('data', Buffer.alloc(200));
      expect(session.audioBytes).toBe(300);
      session.stop();
    });
  });

  describe('stop()', () => {
    test('kills FFmpeg and stops engine', async () => {
      const { session, engine } = makeSession();
      await session.start();
      await session.stop();
      expect(fakeProcess.kill).toHaveBeenCalled();
      expect(engine.stop).toHaveBeenCalled();
    });

    test('sets stopping flag to prevent reconnect', async () => {
      const { session } = makeSession();
      await session.start();
      await session.stop();
      expect(session.stopping).toBe(true);
    });
  });

  describe('reconnect', () => {
    test('restarts pipeline on FFmpeg close when not stopping', async () => {
      const { session, engine } = makeSession({ reconnectDelayMs: 1, maxRetries: 0 });
      await session.start();
      const firstCallCount = engine.start.mock.calls.length;

      fakeProcess.emit('close', 1, null);
      // Wait long enough for the 1ms setTimeout + engine.start() to execute.
      await new Promise((r) => setTimeout(r, 50));

      expect(engine.start.mock.calls.length).toBeGreaterThan(firstCallCount);
      await session.stop();
    });

    test('does not restart when stopping=true', async () => {
      const { session, engine } = makeSession({ reconnectDelayMs: 1 });
      await session.start();
      session.stopping = true;
      const callCount = engine.start.mock.calls.length;

      fakeProcess.emit('close', 1, null);
      await new Promise((r) => setTimeout(r, 30));

      expect(engine.start.mock.calls.length).toBe(callCount);
      await session.stop();
    });

    test('exits when maxRetries exceeded', async () => {
      const { session } = makeSession({ maxRetries: 1, reconnectDelayMs: 10 });
      await session.start();

      // Reach max retries.
      session.retries = 1;
      fakeProcess.emit('close', 1, null);

      await Promise.resolve();
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;  // Reset for other tests.
    });
  });

  describe('EventEmitter', () => {
    test('is an EventEmitter', () => {
      const { session } = makeSession();
      expect(session).toBeInstanceOf(EventEmitter);
    });
  });
});

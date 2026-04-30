'use strict';

const DubbingStream = require('../src/dubbing/dubbing-stream');
const { logger, makeFakeRes } = require('./helpers');

function make(overrides = {}) {
  return new DubbingStream({ logger, language: 'en', sampleRate: 16000, channels: 1, ...overrides });
}

describe('DubbingStream', () => {
  test('stores metadata', () => {
    const ds = make({ language: 'de', sampleRate: 24000, channels: 2 });
    expect(ds.language).toBe('de');
    expect(ds.sampleRate).toBe(24000);
    expect(ds.channels).toBe(2);
  });

  test('starts with no subscribers', () => {
    expect(make().subscriberCount).toBe(0);
  });

  test('push emits data event', () => {
    const ds = make();
    const received = [];
    ds.on('data', (buf) => received.push(buf));
    const buf = Buffer.from([1, 2, 3]);
    ds.push(buf);
    expect(received).toEqual([buf]);
  });

  test('push writes to HTTP subscribers', () => {
    const ds = make();
    const res = makeFakeRes();
    ds.pipe(res);
    const buf = Buffer.from([4, 5, 6]);
    ds.push(buf);
    expect(res.write).toHaveBeenCalledWith(buf);
  });

  test('pipe increases subscriberCount', () => {
    const ds = make();
    ds.pipe(makeFakeRes());
    ds.pipe(makeFakeRes());
    expect(ds.subscriberCount).toBe(2);
  });

  test('subscriber removed on close event', () => {
    const ds = make();
    const res = makeFakeRes();
    ds.pipe(res);
    expect(ds.subscriberCount).toBe(1);
    res.emit('close');
    expect(ds.subscriberCount).toBe(0);
  });

  test('subscriber removed on error event', () => {
    const ds = make();
    const res = makeFakeRes();
    ds.pipe(res);
    res.emit('error', new Error('net'));
    expect(ds.subscriberCount).toBe(0);
  });

  test('write error on subscriber removes it silently', () => {
    const ds = make();
    const res = makeFakeRes();
    res.write.mockImplementation(() => { throw new Error('broken pipe'); });
    ds.pipe(res);
    expect(() => ds.push(Buffer.from([1]))).not.toThrow();
    expect(ds.subscriberCount).toBe(0);
  });

  test('push to multiple subscribers', () => {
    const ds = make();
    const r1 = makeFakeRes();
    const r2 = makeFakeRes();
    ds.pipe(r1);
    ds.pipe(r2);
    const buf = Buffer.from([7]);
    ds.push(buf);
    expect(r1.write).toHaveBeenCalledWith(buf);
    expect(r2.write).toHaveBeenCalledWith(buf);
  });
});

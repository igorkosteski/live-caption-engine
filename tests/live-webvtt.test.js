'use strict';

const LiveWebVtt = require('../src/captions/live-webvtt');
const { logger } = require('./helpers');

function make(overrides = {}) {
  return new LiveWebVtt({
    logger,
    segmentDurationMs: 6000,
    windowSegments: 3,
    basePath: '/captions',
    ...overrides
  });
}

describe('LiveWebVtt', () => {
  describe('constructor', () => {
    test('clamps segmentDurationMs to minimum 1000', () => {
      const vtt = make({ segmentDurationMs: 500 });  // 500 < 1000, gets clamped
      expect(vtt.segmentDurationMs).toBe(1000);
    });

    test('clamps windowSegments to minimum 1', () => {
      // The constructor uses `windowSegments || 5`, so we pass a real number < 1.
      // Passing -1 is falsy-free and triggers Math.max(-1, 1) = 1.
      const vtt = new (require('../src/captions/live-webvtt'))({
        logger,
        segmentDurationMs: 6000,
        windowSegments: -1,
        basePath: '/captions'
      });
      expect(vtt.windowSegments).toBe(1);
    });

    test('latestSegmentIndex starts at -1', () => {
      expect(make().latestSegmentIndex).toBe(-1);
    });
  });

  describe('addCue', () => {
    test('ignores invalid cues', () => {
      const vtt = make();
      vtt.addCue(null);
      vtt.addCue({ startMs: 100, endMs: 50, text: 'bad' });  // endMs < startMs
      vtt.addCue({ startMs: 100, endMs: 200, text: '' });     // empty text
      expect(vtt.latestSegmentIndex).toBe(-1);
    });

    test('adds a valid cue and updates latestSegmentIndex', () => {
      const vtt = make();
      vtt.addCue({ startMs: 1000, endMs: 2000, text: 'Hello' });
      expect(vtt.latestSegmentIndex).toBe(0);
      expect(vtt.cues).toHaveLength(1);
    });

    test('cue spanning two segments appears in both', () => {
      const vtt = make({ segmentDurationMs: 3000 });
      vtt.addCue({ startMs: 2500, endMs: 3500, text: 'Span' });
      expect(vtt.segments.has(0)).toBe(true);
      expect(vtt.segments.has(1)).toBe(true);
    });

    test('normalises whitespace in cue text', () => {
      const vtt = make();
      vtt.addCue({ startMs: 0, endMs: 1000, text: '  hello   world  ' });
      expect(vtt.cues[0].text).toBe('hello world');
    });
  });

  describe('renderSegment', () => {
    test('returns null for missing segment', () => {
      expect(make().renderSegment(99)).toBeNull();
    });

    test('renders valid WEBVTT with correct timestamp map', () => {
      const vtt = make();
      vtt.addCue({ startMs: 0, endMs: 1500, text: 'Test' });
      const rendered = vtt.renderSegment(0);
      expect(rendered).toMatch(/^WEBVTT/);
      expect(rendered).toMatch(/X-TIMESTAMP-MAP/);
      expect(rendered).toMatch('Test');
    });

    test('local timestamps are relative to segment start', () => {
      const vtt = make({ segmentDurationMs: 6000 });
      vtt.addCue({ startMs: 7000, endMs: 8000, text: 'Late' });
      const rendered = vtt.renderSegment(1);
      // localStart = 7000 - 6000 = 1000ms = 00:00:01.000
      expect(rendered).toMatch('00:00:01.000');
    });
  });

  describe('renderPlaylist', () => {
    test('renders empty playlist before any cues', () => {
      const pl = make().renderPlaylist();
      expect(pl).toMatch('#EXTM3U');
      expect(pl).toMatch('#EXT-X-MEDIA-SEQUENCE:0');
    });

    test('playlist contains segment paths after cues', () => {
      const vtt = make();
      vtt.addCue({ startMs: 0, endMs: 1000, text: 'Hi' });
      const pl = vtt.renderPlaylist();
      expect(pl).toMatch('segments/0.vtt');
    });
  });

  describe('renderLiveVtt', () => {
    test('starts with WEBVTT header', () => {
      expect(make().renderLiveVtt()).toMatch(/^WEBVTT/);
    });

    test('includes recent cues', () => {
      const vtt = make();
      vtt.addCue({ startMs: 0, endMs: 1000, text: 'Hello live' });
      expect(vtt.renderLiveVtt()).toMatch('Hello live');
    });
  });

  describe('getFirstSegmentIndex', () => {
    test('returns 0 when nothing pushed', () => {
      expect(make().getFirstSegmentIndex()).toBe(0);
    });

    test('respects windowSegments', () => {
      const vtt = make({ segmentDurationMs: 1000, windowSegments: 2 });
      for (let i = 0; i < 5; i++) {
        vtt.addCue({ startMs: i * 1000, endMs: i * 1000 + 500, text: `Cue ${i}` });
      }
      // latestSegmentIndex = 4; first = max(4 - 2 + 1, 0) = 3
      expect(vtt.getFirstSegmentIndex()).toBe(3);
    });
  });

  describe('prune', () => {
    test('removes old cues beyond window', () => {
      const vtt = make({ segmentDurationMs: 1000, windowSegments: 2 });
      for (let i = 0; i < 5; i++) {
        vtt.addCue({ startMs: i * 1000, endMs: i * 1000 + 500, text: `Cue ${i}` });
      }
      // Only cues within the last 2 segments should remain.
      const earliest = vtt.getFirstSegmentIndex() * 1000;
      expect(vtt.cues.every((c) => c.endMs > earliest)).toBe(true);
    });
  });

  describe('formatTimestamp', () => {
    // Access private method via instance (it's used in rendering)
    test('formats zero correctly', () => {
      const vtt = make();
      expect(vtt.formatTimestamp(0)).toBe('00:00:00.000');
    });

    test('formats hours/minutes/seconds/ms', () => {
      const vtt = make();
      // 3661500ms = 1h 1m 1s 500ms
      expect(vtt.formatTimestamp(3661500)).toBe('01:01:01.500');
    });
  });
});

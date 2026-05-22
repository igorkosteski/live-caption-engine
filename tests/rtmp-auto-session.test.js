'use strict';

const { logger } = require('./helpers');
const {
  buildLoopbackRtmpUrl,
  buildSessionIdFromStreamPath,
  createAutoSessionManager,
  parseLanguageList,
  resolvePublishEvent
} = require('../src/rtmp-auto-session');

describe('rtmp-auto-session', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('parseLanguageList', () => {
    test('parses comma-separated strings', () => {
      expect(parseLanguageList('en, de ,fr')).toEqual(['en', 'de', 'fr']);
    });

    test('flattens arrays with comma-separated entries', () => {
      expect(parseLanguageList(['en,de', 'fr'])).toEqual(['en', 'de', 'fr']);
    });

    test('returns empty array for unsupported values', () => {
      expect(parseLanguageList(undefined)).toEqual([]);
    });
  });

  describe('buildLoopbackRtmpUrl', () => {
    test('builds an RTMP URL from the publish path', () => {
      expect(buildLoopbackRtmpUrl({ streamPath: '/live/primary', rtmpPort: 1935 })).toBe('rtmp://127.0.0.1:1935/live/primary');
    });
  });

  describe('buildSessionIdFromStreamPath', () => {
    test('creates a stable stream-key-like session id', () => {
      expect(buildSessionIdFromStreamPath('/live/primary')).toBe('live-primary');
    });

    test('returns null for invalid stream paths', () => {
      expect(buildSessionIdFromStreamPath('')).toBeNull();
    });
  });

  describe('resolvePublishEvent', () => {
    test('extracts stream info from a NodeMediaServer session object', () => {
      expect(resolvePublishEvent({
        id: 'pub-1',
        streamPath: '/live/primary',
        streamQuery: { languages: 'en,de' }
      })).toEqual({
        id: 'pub-1',
        streamPath: '/live/primary',
        args: { languages: 'en,de' }
      });
    });

    test('normalizes the legacy positional callback signature', () => {
      expect(resolvePublishEvent('pub-1', 'live/primary', { dubbingLanguages: 'fr' })).toEqual({
        id: 'pub-1',
        streamPath: '/live/primary',
        args: { dubbingLanguages: 'fr' }
      });
    });
  });

  describe('createAutoSessionManager', () => {
    test('starts an auto-managed session on prePublish', async () => {
      const sessions = new Map();
      const startSession = jest.fn(async (params) => {
        const session = { sessionId: params.sessionId, rtmpUrl: params.rtmpUrl, endpoints: { manifest: '/manifest.m3u8' } };
        sessions.set(params.sessionId, session);
        return session;
      });

      const manager = createAutoSessionManager({
        logger,
        rtmpPort: 1935,
        startSession,
        getSession: (sessionId) => sessions.get(sessionId),
        deleteSession: jest.fn(),
        findExistingSession: () => null
      });

      await manager.handlePrePublish('pub-1', '/live/primary', {
        sessionId: 'session-1',
        languages: 'en, de',
        dubbingLanguages: 'fr'
      });

      expect(startSession).toHaveBeenCalledWith({
        sessionId: 'session-1',
        rtmpUrl: 'rtmp://127.0.0.1:1935/live/primary',
        languages: ['en', 'de'],
        dubbingLanguages: ['fr'],
        source: 'rtmp-publish'
      });
      expect(manager.sessionIdByStreamPath.get('/live/primary')).toBe('session-1');
    });

    test('uses stream-path based session id when sessionId is not provided', async () => {
      const sessions = new Map();
      const startSession = jest.fn(async (params) => {
        const session = { sessionId: params.sessionId, rtmpUrl: params.rtmpUrl };
        sessions.set(params.sessionId, session);
        return session;
      });

      const manager = createAutoSessionManager({
        logger,
        rtmpPort: 1935,
        startSession,
        getSession: (sessionId) => sessions.get(sessionId),
        deleteSession: jest.fn(),
        findExistingSession: () => null
      });

      await manager.handlePrePublish('pub-1', '/live/primary', {});

      expect(startSession).toHaveBeenCalledWith({
        sessionId: 'live-primary',
        rtmpUrl: 'rtmp://127.0.0.1:1935/live/primary',
        languages: [],
        dubbingLanguages: [],
        source: 'rtmp-publish'
      });
    });

    test('starts an auto-managed session from a NodeMediaServer session object', async () => {
      const sessions = new Map();
      const startSession = jest.fn(async (params) => {
        const session = { sessionId: params.sessionId, rtmpUrl: params.rtmpUrl };
        sessions.set(params.sessionId, session);
        return session;
      });

      const manager = createAutoSessionManager({
        logger,
        rtmpPort: 1935,
        startSession,
        getSession: (sessionId) => sessions.get(sessionId),
        deleteSession: jest.fn(),
        findExistingSession: () => null
      });

      await manager.handlePrePublish({
        id: 'pub-1',
        streamPath: '/live/primary',
        streamQuery: {
          sessionId: 'session-1',
          languages: 'en,de',
          dubbingLanguages: 'fr'
        }
      });

      expect(startSession).toHaveBeenCalledWith({
        sessionId: 'session-1',
        rtmpUrl: 'rtmp://127.0.0.1:1935/live/primary',
        languages: ['en', 'de'],
        dubbingLanguages: ['fr'],
        source: 'rtmp-publish'
      });
    });

    test('does not create duplicate sessions for the same stream path', async () => {
      const sessions = new Map();
      const startSession = jest.fn(async (params) => {
        const session = { sessionId: params.sessionId, rtmpUrl: params.rtmpUrl };
        sessions.set(params.sessionId, session);
        return session;
      });

      const manager = createAutoSessionManager({
        logger,
        rtmpPort: 1935,
        startSession,
        getSession: (sessionId) => sessions.get(sessionId),
        deleteSession: jest.fn(),
        findExistingSession: () => null
      });

      await manager.handlePrePublish('pub-1', '/live/primary', { sessionId: 'session-1' });
      await manager.handlePrePublish('pub-2', '/live/primary', { sessionId: 'session-2' });

      expect(startSession).toHaveBeenCalledTimes(1);
      expect(manager.sessionIdByStreamPath.get('/live/primary')).toBe('session-1');
    });

    test('skips auto-start when a matching session already exists', async () => {
      const existingSession = { sessionId: 'existing-1', rtmpUrl: 'rtmp://127.0.0.1:1935/live/primary' };
      const startSession = jest.fn();

      const manager = createAutoSessionManager({
        logger,
        rtmpPort: 1935,
        startSession,
        getSession: () => existingSession,
        deleteSession: jest.fn(),
        findExistingSession: () => existingSession
      });

      const result = await manager.handlePrePublish('pub-1', '/live/primary', {});

      expect(result).toBe(existingSession);
      expect(startSession).not.toHaveBeenCalled();
      expect(manager.sessionIdByStreamPath.size).toBe(0);
    });

    test('stops the auto-managed session on donePublish', async () => {
      const sessions = new Map();
      const deleteSession = jest.fn(async (sessionId) => {
        sessions.delete(sessionId);
        return true;
      });
      const startSession = jest.fn(async (params) => {
        const session = { sessionId: params.sessionId, rtmpUrl: params.rtmpUrl };
        sessions.set(params.sessionId, session);
        return session;
      });

      const manager = createAutoSessionManager({
        logger,
        rtmpPort: 1935,
        startSession,
        getSession: (sessionId) => sessions.get(sessionId),
        deleteSession,
        findExistingSession: () => null
      });

      await manager.handlePrePublish('pub-1', '/live/primary', { sessionId: 'session-1' });
      const deleted = await manager.handleDonePublish('pub-1', '/live/primary', {});

      expect(deleted).toBe(true);
      expect(deleteSession).toHaveBeenCalledWith('session-1');
      expect(manager.sessionIdByStreamPath.has('/live/primary')).toBe(false);
    });

    test('ignores malformed publish events without a stream path', async () => {
      const manager = createAutoSessionManager({
        logger,
        rtmpPort: 1935,
        startSession: jest.fn(),
        getSession: jest.fn(),
        deleteSession: jest.fn(),
        findExistingSession: jest.fn()
      });

      await expect(manager.handlePrePublish({ id: 'pub-1' })).resolves.toBeNull();
      await expect(manager.handleDonePublish({ id: 'pub-1' })).resolves.toBe(false);
    });
  });
});
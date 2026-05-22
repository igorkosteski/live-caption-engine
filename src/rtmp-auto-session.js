'use strict';

const { randomUUID } = require('crypto');

function parseLanguageList(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => String(entry).split(','))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeStreamPath(streamPath) {
  if (typeof streamPath !== 'string' || !streamPath.trim()) {
    return null;
  }

  return streamPath.startsWith('/') ? streamPath : `/${streamPath}`;
}

function buildLoopbackRtmpUrl({ streamPath, rtmpPort }) {
  const normalizedPath = normalizeStreamPath(streamPath);

  if (!normalizedPath) {
    throw new Error('streamPath is required');
  }

  return `rtmp://127.0.0.1:${rtmpPort}${normalizedPath}`;
}

function resolvePublishEvent(idOrSession, streamPath, args = {}) {
  if (idOrSession && typeof idOrSession === 'object' && !Array.isArray(idOrSession)) {
    return {
      id: idOrSession.id,
      streamPath: normalizeStreamPath(idOrSession.streamPath),
      args: idOrSession.streamQuery || {}
    };
  }

  return {
    id: idOrSession,
    streamPath: normalizeStreamPath(streamPath),
    args: args || {}
  };
}

function createAutoSessionManager({
  logger,
  rtmpPort,
  startSession,
  getSession,
  deleteSession,
  findExistingSession
}) {
  const sessionIdByStreamPath = new Map();
  const pendingSessionsByStreamPath = new Map();

  async function handlePrePublish(idOrSession, streamPath, args = {}) {
    const event = resolvePublishEvent(idOrSession, streamPath, args);
    const { id } = event;
    const publishArgs = event.args;

    logger.info({ id, streamPath: event.streamPath, args: publishArgs }, '[RTMP] prePublish');

    if (!event.streamPath) {
      logger.warn({ id, rawEvent: idOrSession }, 'Skipping RTMP auto session creation because publish event has no streamPath');
      return null;
    }

    streamPath = event.streamPath;

    const rtmpUrl = buildLoopbackRtmpUrl({ streamPath, rtmpPort });
    const existingSession = findExistingSession?.(rtmpUrl);

    if (existingSession) {
      logger.info(
        { id, streamPath, rtmpUrl, sessionId: existingSession.sessionId },
        'Skipping auto session creation because a session already exists for this RTMP stream'
      );
      return existingSession;
    }

    if (sessionIdByStreamPath.has(streamPath) || pendingSessionsByStreamPath.has(streamPath)) {
      const sessionId = sessionIdByStreamPath.get(streamPath) || pendingSessionsByStreamPath.get(streamPath)?.sessionId;

      logger.info({ id, streamPath, sessionId }, 'Skipping duplicate auto session creation for RTMP publish');
      return getSession?.(sessionId) || null;
    }

    const sessionId = typeof publishArgs.sessionId === 'string' && publishArgs.sessionId.trim()
      ? publishArgs.sessionId.trim()
      : randomUUID();

    const pendingEntry = {
      sessionId,
      promise: Promise.resolve()
    };

    pendingEntry.promise = startSession({
      sessionId,
      rtmpUrl,
      languages: parseLanguageList(publishArgs.languages),
      dubbingLanguages: parseLanguageList(publishArgs.dubbingLanguages),
      source: 'rtmp-publish'
    })
      .then((session) => {
        sessionIdByStreamPath.set(streamPath, sessionId);
        logger.info(
          { id, streamPath, sessionId, rtmpUrl, endpoints: session?.endpoints },
          'Auto session started for RTMP publish'
        );
        return session;
      })
      .catch((err) => {
        logger.error({ err, id, streamPath, sessionId, rtmpUrl }, 'Failed to auto-start session for RTMP publish');
        return null;
      })
      .finally(() => {
        pendingSessionsByStreamPath.delete(streamPath);
      });

    pendingSessionsByStreamPath.set(streamPath, pendingEntry);

    return pendingEntry.promise;
  }

  async function handleDonePublish(idOrSession, streamPath, args = {}) {
    const event = resolvePublishEvent(idOrSession, streamPath, args);
    const { id } = event;

    logger.info({ id, streamPath: event.streamPath, args: event.args }, '[RTMP] donePublish');

    if (!event.streamPath) {
      logger.warn({ id, rawEvent: idOrSession }, 'Skipping RTMP auto session teardown because publish event has no streamPath');
      return false;
    }

    streamPath = event.streamPath;

    const pendingEntry = pendingSessionsByStreamPath.get(streamPath);
    if (pendingEntry) {
      await pendingEntry.promise;
    }

    const sessionId = sessionIdByStreamPath.get(streamPath);
    if (!sessionId) {
      logger.info({ id, streamPath }, 'No auto-managed session found for completed RTMP publish');
      return false;
    }

    sessionIdByStreamPath.delete(streamPath);

    const session = getSession?.(sessionId);
    if (!session) {
      logger.info({ id, streamPath, sessionId }, 'Auto-managed session already stopped before RTMP publish ended');
      return false;
    }

    try {
      await deleteSession(sessionId);
      logger.info({ id, streamPath, sessionId }, 'Auto session stopped after RTMP publish ended');
      return true;
    } catch (err) {
      logger.error({ err, id, streamPath, sessionId }, 'Failed to stop auto-managed session after RTMP publish ended');
      return false;
    }
  }

  return {
    handlePrePublish,
    handleDonePublish,
    sessionIdByStreamPath
  };
}

module.exports = {
  buildLoopbackRtmpUrl,
  createAutoSessionManager,
  parseLanguageList,
  resolvePublishEvent
};
'use strict';

/**
 * Multi-subscriber live PCM audio stream.
 * HTTP clients connect and receive raw PCM chunks as they arrive.
 *
 * Consumer example (FFmpeg):
 *   ffmpeg -f s16le -ar <sampleRate> -ac <channels> \
 *          -i http://localhost:8080/dub/<lang>/audio.pcm \
 *          -acodec aac output.aac
 */
class DubbingStream {
  constructor({ logger, language, sampleRate, channels = 1 }) {
    this.logger = logger;
    this.language = language;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this._subscribers = new Set();
  }

  /** Push a PCM Buffer to all connected HTTP subscribers. */
  push(pcmBuffer) {
    for (const res of this._subscribers) {
      try {
        res.write(pcmBuffer);
      } catch {
        this._subscribers.delete(res);
      }
    }
  }

  /**
   * Attach an Express response object as a subscriber.
   * Caller must set Content-Type and other headers before calling pipe().
   * Returns an unsubscribe function.
   */
  pipe(res) {
    this._subscribers.add(res);
    const unsub = () => this._subscribers.delete(res);
    res.on('close', unsub);
    res.on('error', unsub);
    return unsub;
  }

  get subscriberCount() {
    return this._subscribers.size;
  }
}

module.exports = DubbingStream;

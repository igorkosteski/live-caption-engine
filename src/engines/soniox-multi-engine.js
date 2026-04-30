'use strict';

const BaseEngine = require('./base-engine');
const SonioxEngine = require('./soniox-engine');

/**
 * Runs one Soniox WebSocket session per translation target language in parallel.
 * The first session also emits source-language final-caption events.
 * All sessions receive identical audio so transcription timing stays aligned.
 */
class SonioxMultiEngine extends BaseEngine {
  constructor({ logger, sonioxConfig, streamConfig }) {
    super(logger);
    this.sessions = [];

    const { translationTargetLanguages } = sonioxConfig;

    // Primary session — source captions + first target language.
    this.sessions.push(
      new SonioxEngine({
        logger,
        streamConfig,
        suppressSourceCaptions: false,
        sonioxConfig: {
          ...sonioxConfig,
          enableTranslation: translationTargetLanguages.length > 0,
          translationTargetLanguages: translationTargetLanguages.slice(0, 1)
        }
      })
    );

    // One secondary session per additional target language (source captions suppressed).
    for (const lang of translationTargetLanguages.slice(1)) {
      this.sessions.push(
        new SonioxEngine({
          logger,
          streamConfig,
          suppressSourceCaptions: true,
          sonioxConfig: {
            ...sonioxConfig,
            enableTranslation: true,
            translationTargetLanguages: [lang]
          }
        })
      );
    }

    // Bubble all events from every session up through this engine.
    for (const session of this.sessions) {
      session.on('final-caption', (cue) => this.emit('final-caption', cue));
      session.on('final-caption-translated', (cue) => this.emit('final-caption-translated', cue));
    }
  }

  get connected() {
    return this.sessions.every((s) => s.connected);
  }

  async start() {
    await Promise.all(this.sessions.map((s) => s.start()));
  }

  sendAudio(buffer) {
    for (const session of this.sessions) {
      session.sendAudio(buffer);
    }
  }

  async finalize() {
    await Promise.all(this.sessions.map((s) => s.finalize()));
  }

  async stop() {
    await Promise.all(this.sessions.map((s) => s.stop()));
  }
}

module.exports = SonioxMultiEngine;

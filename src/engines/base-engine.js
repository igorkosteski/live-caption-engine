class BaseEngine {
  constructor(logger) {
    this.logger = logger;
  }

  async start() {
    throw new Error('start() must be implemented by engine');
  }

  sendAudio() {
    throw new Error('sendAudio() must be implemented by engine');
  }

  async finalize() {
    throw new Error('finalize() must be implemented by engine');
  }

  async stop() {
    throw new Error('stop() must be implemented by engine');
  }
}

module.exports = BaseEngine;

const SonioxEngine = require('./soniox-engine');

function createEngine({ engineName, logger, sonioxConfig, streamConfig }) {
  if (engineName === 'soniox') {
    return new SonioxEngine({ logger, sonioxConfig, streamConfig });
  }

  throw new Error(`Unsupported engine: ${engineName}`);
}

module.exports = { createEngine };

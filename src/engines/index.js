const SonioxEngine = require('./soniox-engine');
const GeminiEngine = require('./gemini-engine');

function createEngine({ engineName, logger, sonioxConfig, geminiConfig, streamConfig }) {
  if (engineName === 'soniox') {
    return new SonioxEngine({ logger, sonioxConfig, streamConfig });
  }

  if (engineName === 'gemini') {
    return new GeminiEngine({ logger, geminiConfig, streamConfig });
  }

  throw new Error(`Unsupported engine: ${engineName}`);
}

module.exports = { createEngine };

const SonioxEngine = require('./soniox-engine');
const SonioxMultiEngine = require('./soniox-multi-engine');
const GeminiEngine = require('./gemini-engine');

function createEngine({ engineName, logger, sonioxConfig, geminiConfig, streamConfig }) {
  if (engineName === 'soniox') {
    const needsMulti =
      sonioxConfig.enableTranslation && sonioxConfig.translationTargetLanguages.length > 1;

    if (needsMulti) {
      logger.info(
        { languages: sonioxConfig.translationTargetLanguages },
        'Starting multi-language Soniox sessions (one per target language)'
      );
      return new SonioxMultiEngine({ logger, sonioxConfig, streamConfig });
    }

    return new SonioxEngine({ logger, sonioxConfig, streamConfig });
  }

  if (engineName === 'gemini') {
    return new GeminiEngine({ logger, geminiConfig, streamConfig });
  }

  throw new Error(`Unsupported engine: ${engineName}`);
}

module.exports = { createEngine };

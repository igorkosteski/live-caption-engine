'use strict';

const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');
const DubbingStream = require('../dubbing/dubbing-stream');

// Default neural voices per BCP-47 short code.
// Polly VoiceId reference: https://docs.aws.amazon.com/polly/latest/dg/voicelist.html
const DEFAULT_VOICES = {
  ar:  { VoiceId: 'Hala',    Engine: 'neural',    LanguageCode: 'arb' },
  cs:  { VoiceId: 'Jitka',   Engine: 'neural',    LanguageCode: 'cs-CZ' },
  cy:  { VoiceId: 'Gwyneth', Engine: 'standard',  LanguageCode: 'cy-GB' },
  da:  { VoiceId: 'Sofie',   Engine: 'neural',    LanguageCode: 'da-DK' },
  de:  { VoiceId: 'Daniel',  Engine: 'neural',    LanguageCode: 'de-DE' },
  en:  { VoiceId: 'Joanna',  Engine: 'neural',    LanguageCode: 'en-US' },
  es:  { VoiceId: 'Lucia',   Engine: 'neural',    LanguageCode: 'es-ES' },
  fi:  { VoiceId: 'Suvi',    Engine: 'neural',    LanguageCode: 'fi-FI' },
  fr:  { VoiceId: 'Lea',     Engine: 'neural',    LanguageCode: 'fr-FR' },
  hi:  { VoiceId: 'Kajal',   Engine: 'neural',    LanguageCode: 'hi-IN' },
  it:  { VoiceId: 'Bianca',  Engine: 'neural',    LanguageCode: 'it-IT' },
  ja:  { VoiceId: 'Takumi',  Engine: 'neural',    LanguageCode: 'ja-JP' },
  ko:  { VoiceId: 'Seoyeon', Engine: 'neural',    LanguageCode: 'ko-KR' },
  nb:  { VoiceId: 'Ida',     Engine: 'neural',    LanguageCode: 'nb-NO' },
  nl:  { VoiceId: 'Laura',   Engine: 'neural',    LanguageCode: 'nl-NL' },
  pl:  { VoiceId: 'Ola',     Engine: 'neural',    LanguageCode: 'pl-PL' },
  pt:  { VoiceId: 'Camila',  Engine: 'neural',    LanguageCode: 'pt-BR' },
  ro:  { VoiceId: 'Carmen',  Engine: 'standard',  LanguageCode: 'ro-RO' },
  ru:  { VoiceId: 'Tatyana', Engine: 'standard',  LanguageCode: 'ru-RU' },
  sv:  { VoiceId: 'Elin',    Engine: 'neural',    LanguageCode: 'sv-SE' },
  tr:  { VoiceId: 'Burcu',   Engine: 'neural',    LanguageCode: 'tr-TR' },
  zh:  { VoiceId: 'Zhiyu',   Engine: 'neural',    LanguageCode: 'cmn-CN' },
};

// Polly PCM output is always 16-bit signed little-endian, mono.
const OUTPUT_SAMPLE_RATE = 16000;

class PollyDubbingEngine {
  /**
   * @param {object} opts
   * @param {import('pino').Logger} opts.logger
   * @param {string} opts.awsRegion
   * @param {string} opts.targetLanguage  - BCP-47 short code, e.g. 'en'
   * @param {string} [opts.voiceId]       - Override Polly VoiceId, e.g. 'Matthew'
   * @param {EventEmitter} opts.engine    - The main transcription engine (emits final-caption-translated)
   */
  constructor({ logger, awsRegion, targetLanguage, voiceId, engine }) {
    this.logger = logger;
    this.targetLanguage = targetLanguage;
    this._engine = engine;
    this._onCaption = null;

    const voiceConfig = DEFAULT_VOICES[targetLanguage.toLowerCase()];

    if (!voiceConfig && !voiceId) {
      throw new Error(
        `No default Polly voice for language "${targetLanguage}". ` +
        `Set POLLY_VOICES=${targetLanguage}:<VoiceId> to specify one manually.`
      );
    }

    this._voiceId = voiceId || voiceConfig.VoiceId;
    this._engine_type = voiceId ? 'neural' : voiceConfig.Engine;
    this._languageCode = voiceId ? undefined : voiceConfig.LanguageCode;

    this._polly = new PollyClient({
      region: awsRegion,
      credentials: fromNodeProviderChain()
    });

    this.dubbingStream = new DubbingStream({
      logger,
      language: targetLanguage,
      sampleRate: OUTPUT_SAMPLE_RATE,
      channels: 1
    });
  }

  start() {
    this._onCaption = (cue) => {
      if (cue.language !== this.targetLanguage) {
        return;
      }

      this._synthesize(cue.text).catch((err) => {
        this.logger.error(
          { err, language: this.targetLanguage, text: cue.text.slice(0, 80) },
          'Polly synthesis failed'
        );
      });
    };

    this._engine.on('final-caption-translated', this._onCaption);

    this.logger.info(
      { targetLanguage: this.targetLanguage, voiceId: this._voiceId, engine: this._engine_type },
      'Polly dubbing engine started'
    );
  }

  stop() {
    if (this._onCaption) {
      this._engine.removeListener('final-caption-translated', this._onCaption);
      this._onCaption = null;
    }
  }

  async _synthesize(text) {
    const command = new SynthesizeSpeechCommand({
      Text: text,
      OutputFormat: 'pcm',
      SampleRate: String(OUTPUT_SAMPLE_RATE),
      VoiceId: this._voiceId,
      Engine: this._engine_type,
      ...(this._languageCode ? { LanguageCode: this._languageCode } : {})
    });

    const response = await this._polly.send(command);

    const chunks = [];
    for await (const chunk of response.AudioStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const pcm = Buffer.concat(chunks);
    this.logger.debug(
      { language: this.targetLanguage, bytes: pcm.length },
      'Polly synthesized audio'
    );
    this.dubbingStream.push(pcm);
  }
}

module.exports = PollyDubbingEngine;

'use strict';

const WebSocket = require('ws');
const DubbingStream = require('../dubbing/dubbing-stream');

// BCP-47 codes for the Gemini speechConfig language hint.
// Gemini voices are multilingual; the system instruction drives the actual language.
// This map improves accent/dialect selection.
const LANG_TO_BCP47 = {
  af: 'af-ZA', ar: 'ar-XA', bg: 'bg-BG', bn: 'bn-IN', ca: 'ca-ES',
  cs: 'cs-CZ', cy: 'cy-GB', da: 'da-DK', de: 'de-DE', el: 'el-GR',
  en: 'en-US', es: 'es-ES', et: 'et-EE', fa: 'fa-IR', fi: 'fi-FI',
  fil: 'fil-PH', fr: 'fr-FR', gl: 'gl-ES', gu: 'gu-IN', he: 'he-IL',
  hi: 'hi-IN', hr: 'hr-HR', hu: 'hu-HU', id: 'id-ID', is: 'is-IS',
  it: 'it-IT', ja: 'ja-JP', ka: 'ka-GE', kn: 'kn-IN', ko: 'ko-KR',
  lt: 'lt-LT', lv: 'lv-LV', mk: 'mk-MK', ml: 'ml-IN', mr: 'mr-IN',
  ms: 'ms-MY', nb: 'nb-NO', nl: 'nl-NL', pa: 'pa-IN', pl: 'pl-PL',
  pt: 'pt-BR', ro: 'ro-RO', ru: 'ru-RU', sk: 'sk-SK', sl: 'sl-SI',
  sq: 'sq-AL', sr: 'sr-RS', sv: 'sv-SE', sw: 'sw-KE', ta: 'ta-IN',
  te: 'te-IN', th: 'th-TH', tr: 'tr-TR', uk: 'uk-UA', ur: 'ur-IN',
  vi: 'vi-VN', zh: 'zh-CN', zu: 'zu-ZA'
};

function toBcp47(lang) {
  return LANG_TO_BCP47[lang.toLowerCase()] || `${lang.toLowerCase()}-${lang.toUpperCase()}`;
}

// Gemini Live API output sample rate for PCM audio responses.
const GEMINI_OUTPUT_SAMPLE_RATE = 24000;

class GeminiDubbingEngine {
  /**
   * @param {object} opts
   * @param {import('pino').Logger} opts.logger
   * @param {object} opts.geminiConfig
   * @param {string} opts.geminiConfig.apiKey
   * @param {string} opts.geminiConfig.model
   * @param {string} [opts.geminiConfig.sourceLanguage]  - BCP-47 or short code, e.g. 'mk'
   * @param {string} opts.targetLanguage   - BCP-47 or short code, e.g. 'en'
   * @param {string} [opts.voiceName]      - Gemini voice: Aoede | Charon | Fenrir | Kore | Puck
   * @param {object} opts.streamConfig     - { sampleRate, channels } of the PCM input
   */
  constructor({ logger, geminiConfig, streamConfig, targetLanguage, voiceName = 'Aoede' }) {
    this.logger = logger;
    this.geminiConfig = geminiConfig;
    this.streamConfig = streamConfig;
    this.targetLanguage = targetLanguage;
    this.voiceName = voiceName;
    this.ws = null;
    this.connected = false;
    this.closedByClient = false;

    this.dubbingStream = new DubbingStream({
      logger,
      language: targetLanguage,
      sampleRate: GEMINI_OUTPUT_SAMPLE_RATE,
      channels: 1
    });
  }

  async start() {
    this.closedByClient = false;

    return new Promise((resolve, reject) => {
      const url =
        `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta` +
        `/GenerativeService.BidiGenerateContent?key=${this.geminiConfig.apiKey}`;

      const ws = new WebSocket(url);
      this.ws = ws;

      const startupTimeout = setTimeout(() => {
        reject(new Error(`Gemini dubbing WebSocket startup timeout (lang: ${this.targetLanguage})`));
      }, 15000);

      ws.on('open', () => {
        const bcp47 = toBcp47(this.targetLanguage);
        const sourcePart = this.geminiConfig.sourceLanguage
          ? ` The source language is ${this.geminiConfig.sourceLanguage}.`
          : '';

        const setupMsg = {
          setup: {
            model: `models/${this.geminiConfig.model}`,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: this.voiceName }
                },
                languageCode: bcp47
              }
            },
            systemInstruction: {
              parts: [{
                text:
                  `You are a real-time audio interpreter.${sourcePart} ` +
                  `Listen to the audio and immediately speak a natural-sounding translation in ${bcp47}. ` +
                  `Preserve the speaker's pace and tone as closely as possible. ` +
                  `Do not add commentary, greetings, or any text that was not spoken.`
              }]
            }
          }
        };

        ws.send(JSON.stringify(setupMsg));
        this.logger.info(
          { model: this.geminiConfig.model, targetLanguage: this.targetLanguage, voice: this.voiceName },
          'Sent Gemini dubbing setup'
        );
      });

      ws.on('message', (rawData) => {
        let message;
        try {
          message = JSON.parse(rawData.toString());
        } catch {
          return;
        }

        if (message.setupComplete !== undefined) {
          this.connected = true;
          clearTimeout(startupTimeout);
          this.logger.info(
            { targetLanguage: this.targetLanguage },
            'Gemini dubbing session connected'
          );
          resolve();
          return;
        }

        const parts = message.serverContent?.modelTurn?.parts ?? [];
        for (const part of parts) {
          if (part.inlineData?.data) {
            const pcm = Buffer.from(part.inlineData.data, 'base64');
            this.dubbingStream.push(pcm);
          }
        }
      });

      ws.on('error', (error) => {
        clearTimeout(startupTimeout);
        if (!this.connected) {
          reject(error);
          return;
        }
        this.logger.error({ err: error, targetLanguage: this.targetLanguage }, 'Gemini dubbing WebSocket error');
      });

      ws.on('close', (code, reason) => {
        this.connected = false;
        this.logger.warn(
          { code, reason: reason?.toString() || '', targetLanguage: this.targetLanguage },
          'Gemini dubbing WebSocket closed'
        );
      });
    });
  }

  sendAudio(buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          mediaChunks: [{
            mimeType: `audio/pcm;rate=${this.streamConfig.sampleRate}`,
            data: buffer.toString('base64')
          }]
        }
      })
    );
  }

  async stop() {
    this.closedByClient = true;

    if (!this.ws) {
      return;
    }

    if (this.ws.readyState === WebSocket.OPEN) {
      await new Promise((resolve) => {
        this.ws.once('close', resolve);
        this.ws.close();
      });
      return;
    }

    if (this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.terminate();
    }
  }
}

module.exports = GeminiDubbingEngine;

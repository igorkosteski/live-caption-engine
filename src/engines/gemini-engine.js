'use strict';

const WebSocket = require('ws');
const BaseEngine = require('./base-engine');

// Gemini Live API (BidiGenerateContent WebSocket)
// https://ai.google.dev/api/multimodal-live
class GeminiEngine extends BaseEngine {
  constructor({ logger, geminiConfig, streamConfig }) {
    super(logger);
    this.geminiConfig = geminiConfig;
    this.streamConfig = streamConfig;
    this.ws = null;
    this.connected = false;
    this.closedByClient = false;

    // Audio position for cue timing estimation (Gemini does not return token-level timestamps)
    this.audioMs = 0;
    this.pendingCueStartMs = null;
    this.pendingText = '';

    // Bytes consumed per millisecond for the configured PCM format (s16le)
    const bytesPerSample = 2;
    this._bytesPerMs =
      (this.streamConfig.sampleRate * this.streamConfig.channels * bytesPerSample) / 1000;
  }

  // ---------------------------------------------------------------------------
  // Engine contract
  // ---------------------------------------------------------------------------

  async start() {
    this.closedByClient = false;
    this.audioMs = 0;
    this.pendingCueStartMs = null;
    this.pendingText = '';

    return new Promise((resolve, reject) => {
      const url =
        `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta` +
        `/GenerativeService.BidiGenerateContent?key=${this.geminiConfig.apiKey}`;

      const ws = new WebSocket(url);
      this.ws = ws;

      const startupTimeout = setTimeout(() => {
        reject(new Error('Gemini WebSocket startup timeout'));
      }, 15000);

      ws.on('open', () => {
        const setupMsg = {
          setup: {
            model: `models/${this.geminiConfig.model}`,
            generationConfig: {
              responseModalities: ['TEXT']
            },
            systemInstruction: {
              parts: [{ text: this._buildSystemInstruction() }]
            }
          }
        };

        ws.send(JSON.stringify(setupMsg));
        this.logger.info({ model: this.geminiConfig.model }, 'Sent Gemini setup message');
      });

      ws.on('message', (rawData) => {
        let message;
        try {
          message = JSON.parse(rawData.toString());
        } catch {
          this.logger.warn(
            { payload: rawData.toString().slice(0, 200) },
            'Non-JSON message from Gemini'
          );
          return;
        }

        if (message.setupComplete !== undefined) {
          this.connected = true;
          clearTimeout(startupTimeout);
          this.logger.info({ model: this.geminiConfig.model }, 'Connected to Gemini Live API');
          resolve();
          return;
        }

        if (message.serverContent) {
          this._handleServerContent(message.serverContent);
        }
      });

      ws.on('error', (error) => {
        clearTimeout(startupTimeout);
        if (!this.connected) {
          reject(error);
          return;
        }
        this.logger.error({ err: error }, 'Gemini WebSocket error');
      });

      ws.on('close', (code, reason) => {
        this.connected = false;
        const reasonText = reason?.toString() || '';
        this.logger.warn(
          { code, reason: reasonText, closedByClient: this.closedByClient },
          'Gemini WebSocket closed'
        );
      });
    });
  }

  sendAudio(buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // Track position so we can attach approximate timing to emitted cues.
    if (this.pendingCueStartMs === null) {
      this.pendingCueStartMs = this.audioMs;
    }
    this.audioMs += buffer.length / this._bytesPerMs;

    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          mediaChunks: [
            {
              mimeType: `audio/pcm;rate=${this.streamConfig.sampleRate}`,
              data: buffer.toString('base64')
            }
          ]
        }
      })
    );
  }

  async finalize() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
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

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  _buildSystemInstruction() {
    const { sourceLanguage, enableTranslation, targetLanguages } = this.geminiConfig;

    const sourcePart = sourceLanguage
      ? ` The spoken language is ${sourceLanguage}.`
      : '';

    if (!enableTranslation || targetLanguages.length === 0) {
      return (
        `You are a real-time transcription assistant.${sourcePart} ` +
        'Output only the verbatim transcription of the audio. No timestamps, no labels, no extra text.'
      );
    }

    const langList = targetLanguages.join(', ');
    return (
      `You are a real-time transcription and translation assistant.${sourcePart} ` +
      `When you receive audio, output a single-line JSON object with this exact structure:\n` +
      `{"transcript":"<original text>","translations":{"${targetLanguages[0]}":"<text>"}}\n` +
      `Include a key for every target language: ${langList}.\n` +
      'Output ONLY the JSON, no code fences, no extra text.'
    );
  }

  _handleServerContent(serverContent) {
    const parts = serverContent?.modelTurn?.parts ?? [];

    for (const part of parts) {
      if (typeof part.text === 'string' && part.text) {
        this.pendingText += part.text;
      }
    }

    if (!serverContent.turnComplete) {
      return;
    }

    const rawText = this.pendingText.trim();
    this.pendingText = '';

    if (!rawText) {
      this.pendingCueStartMs = null;
      return;
    }

    const startMs = this.pendingCueStartMs ?? 0;
    const endMs = Math.max(this.audioMs, startMs + 100);
    this.pendingCueStartMs = null;

    if (this.geminiConfig.enableTranslation && this.geminiConfig.targetLanguages.length > 0) {
      this._parseTranslationOutput(rawText, startMs, endMs);
    } else {
      this.logger.info({ text: rawText, startMs, endMs }, 'Transcription update');
      this.emit('final-caption', { startMs, endMs, text: rawText });
    }
  }

  _parseTranslationOutput(rawText, startMs, endMs) {
    // Gemini occasionally wraps JSON in code fences despite the instruction.
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // Not JSON — treat the whole output as a plain transcript.
      this.logger.warn(
        { rawText: rawText.slice(0, 200) },
        'Gemini translation output is not valid JSON, treating as plain transcript'
      );
      this.emit('final-caption', { startMs, endMs, text: rawText });
      return;
    }

    if (typeof parsed.transcript === 'string' && parsed.transcript.trim()) {
      const text = parsed.transcript.trim();
      this.logger.info({ text, startMs, endMs }, 'Transcription update');
      this.emit('final-caption', { startMs, endMs, text });
    }

    if (parsed.translations && typeof parsed.translations === 'object') {
      for (const [language, translatedText] of Object.entries(parsed.translations)) {
        if (typeof translatedText === 'string' && translatedText.trim()) {
          this.emit('final-caption-translated', {
            startMs,
            endMs,
            text: translatedText.trim(),
            language
          });
        }
      }
    }
  }
}

module.exports = GeminiEngine;

const WebSocket = require('ws');
const BaseEngine = require('./base-engine');

class SonioxEngine extends BaseEngine {
  constructor({ logger, sonioxConfig, streamConfig, suppressSourceCaptions = false }) {
    super(logger);
    this.sonioxConfig = sonioxConfig;
    this.streamConfig = streamConfig;
    this.suppressSourceCaptions = suppressSourceCaptions;
    this.ws = null;
    this.connected = false;
    this.closedByClient = false;
    this.finalText = '';
    this.partialText = '';
    this.audioChunksSent = 0;
    this.audioBytesSent = 0;
    this.lastTranscriptionLogAt = 0;
    this.sourceCaptionCount = 0;
    this.translatedCaptionCount = 0;
    this.lastSourceTiming = null;
  }

  async start() {
    this.closedByClient = false;
    this.finalText = '';
    this.partialText = '';
    this.audioChunksSent = 0;
    this.audioBytesSent = 0;
    this.lastTranscriptionLogAt = 0;
    this.sourceCaptionCount = 0;
    this.translatedCaptionCount = 0;
    this.lastSourceTiming = null;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.sonioxConfig.wsUrl);
      this.ws = ws;

      const startupTimeout = setTimeout(() => {
        reject(new Error('Soniox WebSocket startup timeout'));
      }, 15000);

      ws.on('open', () => {
        const configMessage = {
          api_key: this.sonioxConfig.apiKey,
          model: this.sonioxConfig.model,
          audio_format: 'pcm_s16le',
          sample_rate: this.streamConfig.sampleRate,
          num_channels: this.streamConfig.channels,
          enable_endpoint_detection: true,
          max_endpoint_delay_ms: 1200
        };

        if (this.sonioxConfig.translationSourceLanguage) {
          configMessage.language_hints = [this.sonioxConfig.translationSourceLanguage];
        }

        if (this.sonioxConfig.enableDiarization) {
          configMessage.enable_speaker_tags = true;
        }

        if (this.sonioxConfig.enableTranslation) {
          // Soniox only accepts a single target_language per session.
          // Use the first configured language; warn if multiple were set.
          const targetLanguage = this.sonioxConfig.translationTargetLanguages[0];

          if (this.sonioxConfig.translationTargetLanguages.length > 1) {
            this.logger.warn(
              { configured: this.sonioxConfig.translationTargetLanguages, using: targetLanguage },
              'Soniox supports one translation target language per session; using first configured language. Use ENGINE=gemini for multi-language translation.'
            );
          }

          configMessage.translation = {
            type: this.sonioxConfig.translationType,
            target_language: targetLanguage
          };
        }

        ws.send(JSON.stringify(configMessage));
        this.connected = true;
        clearTimeout(startupTimeout);
        this.logger.info('Connected to Soniox realtime WebSocket');
        resolve();
      });

      ws.on('message', (rawData) => {
        let message;
        try {
          message = JSON.parse(rawData.toString());
        } catch {
          this.logger.warn({ payload: rawData.toString() }, 'Non-JSON message from Soniox');
          return;
        }

        if (message.error_code) {
          this.logger.error(
            {
              errorCode: message.error_code,
              errorMessage: message.error_message
            },
            'Soniox returned an error'
          );
          return;
        }

        if (Array.isArray(message.tokens)) {
          const finalizedTokens = message.tokens.filter((t) => t.is_final);
          const finalizedSourceTokens = finalizedTokens.filter((token) => !this.isTranslatedToken(token));
          const finalizedInlineTranslatedTokens = finalizedTokens.filter((token) => this.isTranslatedToken(token));

          const finalizedSourceTiming = this.extractTiming(finalizedSourceTokens)
            || this.extractTiming(finalizedTokens);
          if (finalizedSourceTiming) {
            this.lastSourceTiming = finalizedSourceTiming;
          }

          const finalTokens = finalizedSourceTokens.map((t) => t.text).join('');
          const nonFinalTokens = message.tokens
            .filter((t) => !t.is_final)
            .map((t) => t.text)
            .join('');

          if (finalTokens) {
            this.finalText += finalTokens;
            if (!this.suppressSourceCaptions) {
              this.emitFinalCaption(finalizedSourceTokens);
            }
          }

          this.partialText = nonFinalTokens;

          if (finalTokens || nonFinalTokens) {
            const now = Date.now();
            const shouldLogHeartbeat = finalTokens.length > 0 || now - this.lastTranscriptionLogAt >= 15000;

            if (shouldLogHeartbeat) {
              this.lastTranscriptionLogAt = now;
              this.logger.info(
                {
                  finalTextChars: this.finalText.length,
                  partialTextChars: this.partialText.length,
                  sourceCaptionCount: this.sourceCaptionCount,
                  translatedCaptionCount: this.translatedCaptionCount,
                  totalAudioProcessedMs: message.total_audio_proc_ms,
                  finalAudioProcessedMs: message.final_audio_proc_ms
                },
                'Soniox transcription heartbeat'
              );
            }

            this.logger.debug(
              {
                finalDeltaChars: finalTokens.length,
                partialChars: nonFinalTokens.length
              },
              'Soniox transcription token update'
            );

          }

          // Translated tokens arrive alongside source tokens in message.translations.
          // Each entry has a language code and a tokens array structured the same way.
          if (Array.isArray(message.translations)) {
            for (const translation of message.translations) {
              const finalizedTranslated = (translation.tokens ?? []).filter((t) => t.is_final);

              if (finalizedTranslated.length > 0) {
                const fallbackTiming = finalizedSourceTiming
                  || this.lastSourceTiming
                  || this.buildTimingFromAudioProcMs(message.final_audio_proc_ms);

                this.emitFinalCaption(finalizedTranslated, translation.language, {
                  fallbackTokens: finalizedSourceTokens,
                  fallbackTiming
                });
              }
            }
          } else if (finalizedInlineTranslatedTokens.length > 0) {
            const translatedByLanguage = new Map();

            for (const token of finalizedInlineTranslatedTokens) {
              const language = token.language || this.sonioxConfig.translationTargetLanguages?.[0] || 'translated';

              if (!translatedByLanguage.has(language)) {
                translatedByLanguage.set(language, []);
              }

              translatedByLanguage.get(language).push(token);
            }

            const fallbackTiming = finalizedSourceTiming
              || this.lastSourceTiming
              || this.buildTimingFromAudioProcMs(message.final_audio_proc_ms);

            for (const [language, translatedTokens] of translatedByLanguage) {
              this.emitFinalCaption(translatedTokens, language, {
                fallbackTokens: finalizedSourceTokens,
                fallbackTiming
              });
            }
          }
        }

        if (message.finished) {
          this.logger.info(
            {
              finalTextChars: this.finalText.trim().length,
              sourceCaptionCount: this.sourceCaptionCount,
              translatedCaptionCount: this.translatedCaptionCount
            },
            'Soniox stream finished'
          );
        }
      });

      ws.on('error', (error) => {
        clearTimeout(startupTimeout);
        if (!this.connected) {
          reject(error);
          return;
        }
        this.logger.error({ err: error }, 'Soniox WebSocket error');
      });

      ws.on('close', (code, reason) => {
        this.connected = false;
        const reasonText = reason?.toString() || '';
        this.logger.warn(
          {
            code,
            reason: reasonText,
            closedByClient: this.closedByClient
          },
          'Soniox WebSocket closed'
        );
      });
    });
  }

  sendAudio(buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.audioChunksSent += 1;
    this.audioBytesSent += buffer.length;

    if (this.audioChunksSent === 1 || this.audioChunksSent % 100 === 0) {
      this.logger.info(
        {
          audioChunksSent: this.audioChunksSent,
          audioBytesSent: this.audioBytesSent,
          lastChunkBytes: buffer.length
        },
        'Sent audio chunk to Soniox'
      );
    }

    this.ws.send(buffer, { binary: true });
  }

  // language is undefined for source-language captions, a BCP-47 string for translations.
  // fallbackTokens are source tokens and fallbackTiming is an approximate range used
  // when translated tokens arrive without token-level timestamps.
  emitFinalCaption(tokens, language, timingFallback = {}) {
    const rawText = tokens.map((token) => token.text).join('').trim();

    if (!rawText) {
      return;
    }

    const fallbackTokens = Array.isArray(timingFallback)
      ? timingFallback
      : (timingFallback.fallbackTokens ?? []);
    const fallbackTiming = Array.isArray(timingFallback)
      ? null
      : (timingFallback.fallbackTiming ?? null);

    const tokenTiming = this.extractTiming(tokens) || this.extractTiming(fallbackTokens);
    const startMs = tokenTiming?.startMs ?? fallbackTiming?.startMs;
    const endMs = tokenTiming?.endMs ?? fallbackTiming?.endMs;

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      this.logger.warn({ tokens, language }, 'Skipping final caption without valid timing');
      return;
    }

    const eventName = language ? 'final-caption-translated' : 'final-caption';

    if (language) {
      this.translatedCaptionCount += 1;
    } else {
      this.sourceCaptionCount += 1;
    }

    // When diarization is enabled, emit one cue per speaker run so each cue
    // carries a <v SpeakerN>...</v> WebVTT voice span.  Translated tokens
    // don't carry speaker tags so we fall back to a single cue there.
    const hasSpeakerTags =
      this.sonioxConfig.enableDiarization &&
      !language &&
      tokens.some((t) => t.speaker);

    if (hasSpeakerTags) {
      // Group consecutive tokens that share the same speaker label.
      const runs = [];
      for (const token of tokens) {
        const last = runs[runs.length - 1];
        if (last && last.speaker === (token.speaker || last.speaker)) {
          last.tokens.push(token);
        } else {
          runs.push({ speaker: token.speaker || 'S?', tokens: [token] });
        }
      }

      for (const run of runs) {
        const runText = run.tokens.map((t) => t.text).join('').trim();
        if (!runText) continue;

        const runTiming = this.extractTiming(run.tokens) || tokenTiming;
        const runStart = runTiming?.startMs ?? startMs;
        const runEnd = runTiming?.endMs ?? endMs;

        this.emit(eventName, {
          startMs: runStart,
          endMs: runEnd,
          // WebVTT voice span: <v SpeakerN>text</v>
          text: `<v ${run.speaker}>${runText}</v>`,
          speaker: run.speaker,
          language
        });
      }

      return;
    }

    this.emit(eventName, {
      startMs,
      endMs,
      text: rawText,
      language
    });
  }

  extractTiming(tokens) {
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return null;
    }

    const startMs = tokens.find((token) => Number.isFinite(token.start_ms))?.start_ms;
    const endMs = [...tokens].reverse().find((token) => Number.isFinite(token.end_ms))?.end_ms;

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return null;
    }

    return { startMs, endMs };
  }

  buildTimingFromAudioProcMs(finalAudioProcMs) {
    if (!Number.isFinite(finalAudioProcMs)) {
      return null;
    }

    const endMs = Math.max(0, finalAudioProcMs);
    const startMs = Math.max(0, endMs - 1200);

    if (endMs <= startMs) {
      return null;
    }

    return { startMs, endMs };
  }

  isTranslatedToken(token) {
    return token?.translation_status === 'translation';
  }

  async finalize() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send('');
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

module.exports = SonioxEngine;

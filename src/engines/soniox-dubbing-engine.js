'use strict';

const { randomUUID } = require('crypto');
const WebSocket = require('ws');
const DubbingStream = require('../dubbing/dubbing-stream');

const DEFAULT_WS_URL = 'wss://tts-rt.soniox.com/tts-websocket';
const DEFAULT_MODEL = 'tts-rt-v1';
const DEFAULT_VOICE = 'Adrian';
const DEFAULT_SAMPLE_RATE = 24000;

class SonioxDubbingEngine {
  /**
   * @param {object} opts
   * @param {import('pino').Logger} opts.logger
   * @param {EventEmitter} opts.engine
   * @param {string} opts.targetLanguage
   * @param {string} opts.apiKey
   * @param {string} [opts.voice]
   * @param {string} [opts.model]
   * @param {string} [opts.wsUrl]
   * @param {number} [opts.sampleRate]
   * @param {number | undefined} [opts.bitrate]
   */
  constructor({
    logger,
    engine,
    targetLanguage,
    apiKey,
    voice = DEFAULT_VOICE,
    model = DEFAULT_MODEL,
    wsUrl = DEFAULT_WS_URL,
    sampleRate = DEFAULT_SAMPLE_RATE,
    bitrate
  }) {
    this.logger = logger;
    this._engine = engine;
    this.targetLanguage = targetLanguage;
    this.apiKey = apiKey;
    this.voice = voice;
    this.model = model;
    this.wsUrl = wsUrl;
    this.sampleRate = sampleRate;
    this.bitrate = bitrate;

    this.streamId = `dub-${targetLanguage}-${randomUUID()}`;
    this.ws = null;
    this.connected = false;
    this.closedByClient = false;
    this._onCaption = null;
    this._streamStarted = false;
    this._lastStartRetryAt = 0;
    this._startRetryCount = 0;
    this._reconnectInFlight = false;
    this._lastTimeoutWarnAt = 0;

    this.dubbingStream = new DubbingStream({
      logger,
      language: targetLanguage,
      sampleRate,
      channels: 1
    });
  }

  async start() {
    if (!this.apiKey) {
      throw new Error('DUBBING_ENGINE=soniox requires SONIOX_API_KEY');
    }

    this.closedByClient = false;
    await this._connectWebSocket();

    this._onCaption = (cue) => {
      if (cue.language !== this.targetLanguage) {
        return;
      }

      const text = (cue.text || '').trim();
      if (!text || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }

      if (!this._streamStarted) {
        this._sendStartMessage();
      }

      this.ws.send(
        JSON.stringify({
          stream_id: this.streamId,
          text,
          text_end: false
        })
      );
    };

    this._engine.on('final-caption-translated', this._onCaption);
  }

  async _connectWebSocket() {
    this.streamId = `dub-${this.targetLanguage}-${randomUUID()}`;
    this._streamStarted = false;

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;

      const startupTimeout = setTimeout(() => {
        reject(new Error(`Soniox dubbing WebSocket startup timeout (lang: ${this.targetLanguage})`));
      }, 15000);

      ws.on('open', () => {
        const config = {
          api_key: this.apiKey,
          stream_id: this.streamId,
          model: this.model,
          language: this.targetLanguage,
          voice: this.voice,
          audio_format: 'pcm_s16le',
          sample_rate: this.sampleRate
        };

        if (Number.isFinite(this.bitrate)) {
          config.bitrate = this.bitrate;
        }

        ws.send(JSON.stringify(config));
        this._startRetryCount = 0;
        this._lastStartRetryAt = 0;
        this._sendStartMessage();
        this.connected = true;
        clearTimeout(startupTimeout);

        this.logger.info(
          {
            targetLanguage: this.targetLanguage,
            model: this.model,
            voice: this.voice,
            sampleRate: this.sampleRate,
            streamId: this.streamId
          },
          'Soniox dubbing session connected'
        );

        resolve();
      });

      ws.on('message', (rawData) => {
        let message;
        try {
          message = JSON.parse(rawData.toString());
        } catch {
          return;
        }

        if (message.error_code) {
          const isStartMessageError =
            message.error_code === 400 && /start message first/i.test(message.error_message || '');

          if (isStartMessageError) {
            const now = Date.now();
            if (now - this._lastStartRetryAt >= 1000) {
              this._lastStartRetryAt = now;
              this._startRetryCount += 1;
              this._streamStarted = false;
              this.logger.warn(
                {
                  targetLanguage: this.targetLanguage,
                  streamId: this.streamId,
                  retryCount: this._startRetryCount
                },
                'Soniox requested stream start; re-sending start message'
              );
              this._sendStartMessage();
            }

            if (this._startRetryCount >= 3) {
              this._reconnectWebSocket('repeated-start-message-errors');
            }
          }

          if (message.error_code === 408) {
            const now = Date.now();
            if (now - this._lastTimeoutWarnAt >= 10000) {
              this._lastTimeoutWarnAt = now;
              this.logger.warn(
                { targetLanguage: this.targetLanguage, streamId: this.streamId },
                'Soniox dubbing idle timeout (non-fatal); waiting for next translated caption'
              );
            }
            return;
          }

          this.logger.error(
            {
              targetLanguage: this.targetLanguage,
              errorCode: message.error_code,
              errorMessage: message.error_message
            },
            'Soniox dubbing API error'
          );
          return;
        }

        if (message.audio) {
          const pcm = Buffer.from(message.audio, 'base64');
          this.dubbingStream.push(pcm);
        }
      });

      ws.on('error', (error) => {
        clearTimeout(startupTimeout);
        if (!this.connected) {
          reject(error);
          return;
        }
        this.logger.error({ err: error, targetLanguage: this.targetLanguage }, 'Soniox dubbing WebSocket error');
      });

      ws.on('close', (code, reason) => {
        this.connected = false;
        this._streamStarted = false;
        this.logger.warn(
          {
            code,
            reason: reason?.toString() || '',
            targetLanguage: this.targetLanguage,
            closedByClient: this.closedByClient
          },
          'Soniox dubbing WebSocket closed'
        );
      });
    });
  }

  async _reconnectWebSocket(reason) {
    if (this.closedByClient || this._reconnectInFlight) {
      return;
    }

    this._reconnectInFlight = true;

    this.logger.warn(
      { targetLanguage: this.targetLanguage, streamId: this.streamId, reason },
      'Reconnecting Soniox dubbing websocket'
    );

    try {
      const ws = this.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      } else if (ws && ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }

      await this._connectWebSocket();
    } catch (err) {
      this.logger.error(
        { err, targetLanguage: this.targetLanguage },
        'Failed to reconnect Soniox dubbing websocket'
      );
    } finally {
      this._reconnectInFlight = false;
    }
  }

  _sendStartMessage() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(
      JSON.stringify({
        stream_id: this.streamId,
        text: '',
        text_end: false
      })
    );

    this._streamStarted = true;
  }

  async stop() {
    this.closedByClient = true;

    if (this._onCaption) {
      this._engine.removeListener('final-caption-translated', this._onCaption);
      this._onCaption = null;
    }

    if (!this.ws) {
      return;
    }

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          stream_id: this.streamId,
          text: '',
          text_end: true
        })
      );

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

module.exports = SonioxDubbingEngine;

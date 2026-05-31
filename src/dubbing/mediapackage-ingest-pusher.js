'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * Pushes HLS segments and playlists to a MediaPackage V2 ingest endpoint
 * using SigV4-signed HTTP PUT requests.
 *
 * Uses the AWS SDK credential provider chain — works transparently with
 * ECS task role credentials, env vars, or instance profiles.
 */
class MediaPackageIngestPusher {
  /**
   * @param {object} opts
   * @param {string}   opts.ingestBaseUrl  MediaPackage V2 ingest base URL
   *                                       e.g. https://xxx.ingest.yyy.mediapackagev2.amazonaws.com/in/v1/group/1/channel
   * @param {string}   [opts.region]       AWS region, defaults to AWS_REGION env
   * @param {object}   opts.logger         pino-compatible logger
   * @param {number}   [opts.maxRetries]   Number of retry attempts on transient errors (default 3)
   */
  constructor({ ingestBaseUrl, region, logger, maxRetries = 3 }) {
    this.ingestBaseUrl = ingestBaseUrl.replace(/\/$/, '');
    this.region = region || process.env.AWS_REGION || 'us-east-1';
    this.logger = logger;
    this.maxRetries = maxRetries;

    // Lazily initialised AWS signing helpers
    this._signer = null;
    this._credentials = null;

    this.logger.info({ ingestBaseUrl: this.ingestBaseUrl, region: this.region }, '[pusher] initialised');
  }

  async _getSigner() {
    if (this._signer) return this._signer;

    const { SignatureV4 } = require('@smithy/signature-v4');
    const { Sha256 } = require('@aws-crypto/sha256-js');
    const { defaultProvider } = require('@aws-sdk/credential-provider-node');

    this._credentials = defaultProvider();
    this._signer = new SignatureV4({
      credentials: this._credentials,
      region: this.region,
      service: 'mediapackagev2',
      sha256: Sha256
    });

    return this._signer;
  }

  /**
   * PUT a Buffer or string to <ingestBaseUrl>/<trackName>/<filename>.
   *
   * @param {string}          trackName   Sub-path for this track, e.g. "dub-en" or "captions-en"
   * @param {string}          filename    Segment or playlist filename, e.g. "seg-00001.ts" or "audio.m3u8"
   * @param {Buffer|string}   data        Content to PUT
   * @param {string}          contentType MIME type
   */
  async put(trackName, filename, data, contentType) {
    // Build URL: track+file → base/track/file, file only → base/file, neither → base URL (primary manifest)
    const url = trackName
      ? `${this.ingestBaseUrl}/${trackName}/${filename}`
      : filename
        ? `${this.ingestBaseUrl}/${filename}`
        : this.ingestBaseUrl;
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');

    this.logger.debug({ url, bytes: body.length, contentType }, '[pusher] PUT start');

    let attempt = 0;
    while (attempt <= this.maxRetries) {
      try {
        await this._put(url, body, contentType);
        this.logger.debug({ url, attempt }, '[pusher] PUT ok');
        return;
      } catch (err) {
        attempt++;
        if (attempt > this.maxRetries) {
          this.logger.error({ err, url, trackName, filename, attempts: attempt }, '[pusher] PUT failed after retries');
          throw err;
        }
        const delay = Math.min(200 * Math.pow(2, attempt - 1) + Math.random() * 100, 5000);
        this.logger.warn({ err: err.message, url, attempt, delayMs: Math.round(delay) }, '[pusher] PUT failed, retrying');
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  async _put(url, body, contentType) {
    const parsed = new URL(url);
    const signer = await this._getSigner();

    const request = {
      method: 'PUT',
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + (parsed.search || ''),
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(body.length),
        'host': parsed.hostname
      },
      body
    };

    const signed = await signer.sign(request);

    return new Promise((resolve, reject) => {
      const mod = parsed.protocol === 'https:' ? https : http;
      const req = mod.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: request.path,
        method: 'PUT',
        headers: signed.headers
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`MediaPackage PUT ${url} failed! Status: ${res.statusCode}. Body: ${raw.slice(0, 400)}`));
          }
        });
      });

      req.on('error', (err) => {
        this.logger.error({ err: err.message, url }, '[pusher] socket error');
        reject(err);
      });
      req.write(body);
      req.end();
    });
  }
}

module.exports = MediaPackageIngestPusher;

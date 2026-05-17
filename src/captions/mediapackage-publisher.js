'use strict';

const https = require('https');
const { createHash, createHmac } = require('crypto');

const { SignatureV4 } = require('@aws-sdk/signature-v4');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');

// Native SHA-256/HMAC-SHA-256 adapter for @aws-sdk/signature-v4
// Avoids adding @smithy/hash-node as a separate dependency.
class NodeSha256 {
  constructor(secret) {
    this._inner =
      secret !== undefined
        ? createHmac('sha256', Buffer.isBuffer(secret) ? secret : Buffer.from(secret))
        : createHash('sha256');
  }

  update(data) {
    this._inner.update(data);
  }

  digest() {
    return Promise.resolve(this._inner.digest());
  }
}

class MediaPackagePublisher {
  /**
   * @param {object} opts
   * @param {import('pino').Logger} opts.logger
   * @param {import('./live-webvtt')} opts.captions  - shared LiveWebVtt instance
   * @param {string} opts.ingestUrl  - base MediaPackage V2 ingest endpoint URL
   *   e.g. https://xxxx.mediapackagev2.us-east-1.amazonaws.com/in/v1/<group>/<channel>/<endpoint>
   * @param {string} opts.awsRegion  - AWS region, e.g. "us-east-1"
   * @param {string} [opts.subtitlePath] - sub-path under ingestUrl for subtitle files (default "subtitles")
   */
  constructor({ logger, captions, ingestUrl, awsRegion, subtitlePath = 'subtitles' }) {
    this.logger = logger;
    this.captions = captions;
    this.ingestUrl = ingestUrl.replace(/\/$/, '');
    this.subtitlePath = subtitlePath;
    this.publishedSegments = new Set();
    this.pushTimer = null;
    this.successfulPuts = 0;
    this.failedPuts = 0;
    this.lastSuccessLogAt = 0;

    this.signer = new SignatureV4({
      credentials: fromNodeProviderChain(),
      region: awsRegion,
      service: 'mediapackagev2',
      sha256: NodeSha256
    });
  }

  start() {
    const intervalMs = Math.max(Math.floor(this.captions.segmentDurationMs / 2), 1000);
    this.pushTimer = setInterval(() => {
      this._publishPending().catch((err) => {
        this.logger.error({ err }, 'MediaPackage publish tick failed');
      });
    }, intervalMs);

    this.logger.info(
      { ingestUrl: this.ingestUrl, subtitlePath: this.subtitlePath, intervalMs },
      'MediaPackage publisher started'
    );
  }

  stop() {
    if (this.pushTimer) {
      clearInterval(this.pushTimer);
      this.pushTimer = null;
    }
  }

  async _publishPending() {
    const latestIndex = this.captions.latestSegmentIndex;

    if (latestIndex < 0) {
      return;
    }

    const firstIndex = this.captions.getFirstSegmentIndex();

    // Push each segment. Complete segments (< latestIndex) are pushed once and cached.
    // The current segment (= latestIndex) is pushed every tick to keep MediaPackage current.
    for (let index = firstIndex; index <= latestIndex; index += 1) {
      if (this.publishedSegments.has(index) && index !== latestIndex) {
        continue;
      }

      const content = this.captions.renderSegment(index);

      if (!content) {
        continue;
      }

      await this._put(`${this.subtitlePath}/seg-${index}.vtt`, content, 'text/vtt');

      if (index !== latestIndex) {
        this.publishedSegments.add(index);
      }
    }

    // Remove stale segment tracking entries beyond the rolling window.
    for (const index of this.publishedSegments) {
      if (index < firstIndex) {
        this.publishedSegments.delete(index);
      }
    }

    // Always refresh the subtitle playlist so MediaPackage sees new segments immediately.
    await this._put(
      `${this.subtitlePath}/subs.m3u8`,
      this._renderSubtitlePlaylist(),
      'application/vnd.apple.mpegurl'
    );
  }

  _renderSubtitlePlaylist() {
    const firstIndex = this.captions.getFirstSegmentIndex();
    const latestIndex = this.captions.latestSegmentIndex;
    const targetDurationSec = Math.ceil(this.captions.segmentDurationMs / 1000);
    const extinf = (this.captions.segmentDurationMs / 1000).toFixed(3);

    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${targetDurationSec}`,
      `#EXT-X-MEDIA-SEQUENCE:${firstIndex}`
    ];

    for (let index = firstIndex; index <= latestIndex; index += 1) {
      lines.push(`#EXTINF:${extinf},`);
      lines.push(`seg-${index}.vtt`);
    }

    return lines.join('\n');
  }

  async _put(path, body, contentType) {
    const fullUrl = new URL(`${this.ingestUrl}/${path}`);
    const bodyBuffer = Buffer.from(body, 'utf8');

    const requestToSign = {
      method: 'PUT',
      protocol: fullUrl.protocol,
      hostname: fullUrl.hostname,
      port: fullUrl.port || '443',
      path: fullUrl.pathname,
      headers: {
        'content-type': contentType,
        'content-length': String(bodyBuffer.length),
        host: fullUrl.hostname
      },
      body: bodyBuffer
    };

    const signed = await this.signer.sign(requestToSign);

    return new Promise((resolve) => {
      const req = https.request(
        {
          hostname: signed.hostname,
          port: Number(signed.port) || 443,
          path: signed.path,
          method: signed.method,
          headers: signed.headers
        },
        (res) => {
          let responseBody = '';
          res.on('data', (chunk) => {
            responseBody += chunk;
          });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              this.successfulPuts += 1;

              const now = Date.now();
              const shouldLogSuccess =
                this.successfulPuts === 1 ||
                path.endsWith('/subs.m3u8') ||
                now - this.lastSuccessLogAt >= 30000;

              if (shouldLogSuccess) {
                this.lastSuccessLogAt = now;
                this.logger.info(
                  {
                    path,
                    statusCode: res.statusCode,
                    successfulPuts: this.successfulPuts,
                    failedPuts: this.failedPuts,
                    subtitlePath: this.subtitlePath
                  },
                  'MediaPackage PUT succeeded'
                );
              }
            } else {
              this.failedPuts += 1;
              this.logger.error(
                {
                  path,
                  statusCode: res.statusCode,
                  body: responseBody.slice(0, 300),
                  successfulPuts: this.successfulPuts,
                  failedPuts: this.failedPuts,
                  subtitlePath: this.subtitlePath
                },
                'MediaPackage PUT failed'
              );
            }
            resolve();
          });
        }
      );

      req.on('error', (err) => {
        this.failedPuts += 1;
        this.logger.error(
          {
            err,
            path,
            successfulPuts: this.successfulPuts,
            failedPuts: this.failedPuts,
            subtitlePath: this.subtitlePath
          },
          'MediaPackage PUT network error'
        );
        resolve();
      });

      req.write(bodyBuffer);
      req.end();
    });
  }
}

module.exports = MediaPackagePublisher;

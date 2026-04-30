'use strict';

const { spawn } = require('child_process');
const https = require('https');
const { createHash, createHmac } = require('crypto');

const { SignatureV4 } = require('@aws-sdk/signature-v4');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');

// Native SHA-256/HMAC-SHA-256 adapter — avoids adding @smithy/hash-node as a dependency.
class NodeSha256 {
  constructor(secret) {
    this._inner =
      secret !== undefined
        ? createHmac('sha256', Buffer.isBuffer(secret) ? secret : Buffer.from(secret))
        : createHash('sha256');
  }

  update(data) { this._inner.update(data); }
  digest() { return Promise.resolve(this._inner.digest()); }
}

const DEFAULT_SEGMENT_DURATION_MS = 6000;
const DEFAULT_WINDOW_SEGMENTS = 5;

/**
 * Encodes incoming PCM audio from a DubbingStream into fixed-duration AAC segments,
 * then pushes them (plus a rolling HLS audio playlist) to MediaPackage V2.
 *
 * MediaPackage V2 ingest path:  <ingestUrl>/<audioPath>/seg-N.aac
 *                               <ingestUrl>/<audioPath>/audio.m3u8
 *
 * Each dubbed language gets its own AudioSegmentPublisher instance with a unique audioPath,
 * e.g. "dub-audio-en", "dub-audio-de".
 */
class AudioSegmentPublisher {
  /**
   * @param {object} opts
   * @param {import('pino').Logger} opts.logger
   * @param {import('./dubbing-stream')} opts.dubbingStream
   * @param {string} opts.ingestUrl     - MediaPackage V2 ingest endpoint (no trailing slash)
   * @param {string} opts.awsRegion
   * @param {string} opts.audioPath     - sub-path prefix, e.g. "dub-audio-en"
   * @param {number} [opts.segmentDurationMs]  - default 6000
   * @param {number} [opts.windowSegments]     - HLS sliding window, default 5
   */
  constructor({ logger, dubbingStream, ingestUrl, awsRegion, audioPath, segmentDurationMs, windowSegments }) {
    this.logger = logger;
    this.dubbingStream = dubbingStream;
    this.ingestUrl = ingestUrl.replace(/\/$/, '');
    this.audioPath = audioPath;
    this.segmentDurationMs = segmentDurationMs || DEFAULT_SEGMENT_DURATION_MS;
    this.windowSegments = windowSegments || DEFAULT_WINDOW_SEGMENTS;

    const { sampleRate, channels } = dubbingStream;
    this.sampleRate = sampleRate;
    this.channels = channels;

    // Bytes of s16le PCM per segment
    this._bytesPerMs = (sampleRate * channels * 2) / 1000;
    this._segmentBytes = Math.floor(this._bytesPerMs * this.segmentDurationMs);

    this._accum = [];          // Buffer[] — accumulated PCM chunks
    this._accumBytes = 0;
    this._segmentIndex = 0;
    this._segments = [];       // { index, durationSec } — rolling window
    this._onPcm = null;

    this.signer = new SignatureV4({
      credentials: fromNodeProviderChain(),
      region: awsRegion,
      service: 'mediapackagev2',
      sha256: NodeSha256
    });
  }

  start() {
    this._onPcm = (chunk) => this._accumulate(chunk);
    this.dubbingStream.on('data', this._onPcm);

    this.logger.info(
      {
        language: this.dubbingStream.language,
        audioPath: this.audioPath,
        segmentDurationMs: this.segmentDurationMs
      },
      'Audio segment publisher started'
    );
  }

  stop() {
    if (this._onPcm) {
      this.dubbingStream.off('data', this._onPcm);
      this._onPcm = null;
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  _accumulate(chunk) {
    this._accum.push(chunk);
    this._accumBytes += chunk.length;

    // Flush complete segments. A single chunk may produce multiple segments.
    while (this._accumBytes >= this._segmentBytes) {
      const combined = Buffer.concat(this._accum);
      const segPcm = combined.subarray(0, this._segmentBytes);
      const remainder = combined.subarray(this._segmentBytes);

      this._accum = remainder.length > 0 ? [remainder] : [];
      this._accumBytes = remainder.length;

      const index = this._segmentIndex++;

      this._encodeAndPush(index, segPcm).catch((err) => {
        this.logger.error({ err, index }, 'Audio segment encode/push failed');
      });
    }
  }

  async _encodeAndPush(index, pcmBuffer) {
    const aacBuffer = await this._encodeToAAC(pcmBuffer);

    const durationSec = this.segmentDurationMs / 1000;
    this._segments.push({ index, durationSec });

    // Prune segments outside the sliding window.
    while (this._segments.length > this.windowSegments) {
      this._segments.shift();
    }

    // Push segment first so MediaPackage can serve it before the playlist points to it.
    await this._put(`${this.audioPath}/seg-${index}.aac`, aacBuffer, 'audio/aac');
    await this._put(`${this.audioPath}/audio.m3u8`, this._renderPlaylist(), 'application/vnd.apple.mpegurl');

    this.logger.debug(
      { index, bytes: aacBuffer.length, language: this.dubbingStream.language },
      'Audio segment pushed to MediaPackage'
    );
  }

  /** Encode a raw s16le PCM Buffer to ADTS-framed AAC using a short-lived FFmpeg process. */
  _encodeToAAC(pcmBuffer) {
    return new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-f', 's16le',
        '-ar', String(this.sampleRate),
        '-ac', String(this.channels),
        '-i', 'pipe:0',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-f', 'adts',
        'pipe:1'
      ]);

      const chunks = [];
      ff.stdout.on('data', (chunk) => chunks.push(chunk));
      ff.stderr.on('data', () => {});  // suppress FFmpeg progress output

      ff.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`FFmpeg AAC encoder exited with code ${code}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });

      ff.on('error', reject);

      ff.stdin.write(pcmBuffer);
      ff.stdin.end();
    });
  }

  _renderPlaylist() {
    if (this._segments.length === 0) return '#EXTM3U\n';

    const targetDuration = Math.ceil(this.segmentDurationMs / 1000);
    const firstIndex = this._segments[0].index;

    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      `#EXT-X-TARGETDURATION:${targetDuration}`,
      `#EXT-X-MEDIA-SEQUENCE:${firstIndex}`
    ];

    for (const { index, durationSec } of this._segments) {
      lines.push(`#EXTINF:${durationSec.toFixed(3)},`);
      lines.push(`seg-${index}.aac`);
    }

    return lines.join('\n') + '\n';
  }

  async _put(path, body, contentType) {
    const fullUrl = new URL(`${this.ingestUrl}/${path}`);
    const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');

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
          res.on('data', (chunk) => { responseBody += chunk; });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              this.logger.debug({ path, statusCode: res.statusCode }, 'Pushed audio to MediaPackage');
            } else {
              this.logger.error(
                { path, statusCode: res.statusCode, body: responseBody.slice(0, 300) },
                'MediaPackage PUT failed'
              );
            }
            resolve();
          });
        }
      );

      req.on('error', (err) => {
        this.logger.error({ err, path }, 'MediaPackage PUT network error');
        resolve();
      });

      req.write(bodyBuffer);
      req.end();
    });
  }
}

module.exports = AudioSegmentPublisher;

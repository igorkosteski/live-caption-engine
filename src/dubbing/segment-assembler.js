'use strict';

const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');

/**
 * SegmentAssembler
 *
 * Polls the raw MediaPackage channel (MediaLive output) for new video segments.
 * When a new video segment is detected:
 *   - forwards the video segment + variant playlist to the output channel
 *   - pushes any pending caption/audio segments (already buffered) to the output channel
 *   - updates the master manifest on the output channel
 *
 * The video segment clock drives everything — caption and audio segments are
 * pushed in the same PUT batch as the video segment they were ready for,
 * so segment sequence numbers stay aligned.
 */
class SegmentAssembler extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string}   opts.rawEgressBaseUrl       Base URL of the raw MPv2 egress endpoint
   *                                                e.g. https://xxx.egress.yyy.amazonaws.com/out/v1/group/channel/hls
   * @param {object}   opts.pusher                 MediaPackageIngestPusher instance pointing at the output channel
   * @param {object}   opts.logger                 pino-compatible logger
   * @param {number}   [opts.pollIntervalMs]        How often to poll raw channel playlist (default 2000)
   * @param {number}   [opts.segmentDurationSec]   Expected segment duration — used for master manifest (default 6)
   */
  constructor({ rawEgressBaseUrl, pusher, logger, pollIntervalMs = 2000, segmentDurationSec = 6 }) {
    super();
    this.rawEgressBaseUrl = rawEgressBaseUrl.replace(/\/$/, '');
    this.pusher = pusher;
    this.logger = logger;
    this.pollIntervalMs = pollIntervalMs;
    this.segmentDurationSec = segmentDurationSec;

    // Track which video segments we have already forwarded
    this._seenVideoSegments = new Set();
    // Latest video media-sequence number seen
    this._videoMediaSequence = 0;

    // Pending caption segments per lang: Map<lang, {filename, data}[]>
    this._pendingCaptions = new Map();
    // Pending audio segments per lang: Map<lang, {filename, data, contentType}[]>
    this._pendingAudio = new Map();

    // Current caption playlist per lang: Map<lang, string>
    this._captionPlaylists = new Map();
    // Current audio playlist per lang: Map<lang, string>
    this._audioPlaylists = new Map();

    // Track which languages are registered
    this._captionLangs = new Set();
    this._audioLangs = new Set();

    this._pollTimer = null;
    this._running = false;

    // Raw variant URL (resolved after first master manifest fetch)
    this._rawVariantUrl = null;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  start() {
    if (this._running) return;
    this._running = true;
    this.logger.info({ rawEgressBaseUrl: this.rawEgressBaseUrl }, '[assembler] starting');
    this._schedulePoll();
  }

  stop() {
    this._running = false;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    this.logger.info('[assembler] stopped');
  }

  /**
   * Register a caption language track.
   * Call this before start() for each language expected in the session.
   */
  registerCaptionLang(lang) {
    this._captionLangs.add(lang);
    if (!this._pendingCaptions.has(lang)) this._pendingCaptions.set(lang, []);
  }

  /**
   * Register an audio dubbing language track.
   */
  registerAudioLang(lang) {
    this._audioLangs.add(lang);
    if (!this._pendingAudio.has(lang)) this._pendingAudio.set(lang, []);
  }

  /**
   * Queue a caption segment for the next push cycle.
   * Called by LiveWebVtt when it renders a new segment.
   *
   * @param {string} lang       Language code, e.g. "en" or "src"
   * @param {number} index      Segment index
   * @param {string} vttContent WebVTT text content
   */
  enqueueCaptionSegment(lang, index, vttContent) {
    const filename = `${index}.vtt`;
    const list = this._pendingCaptions.get(lang) || [];
    list.push({ filename, data: vttContent, contentType: 'text/vtt' });
    this._pendingCaptions.set(lang, list);
  }

  /**
   * Update the caption playlist for a given language.
   * Called by LiveWebVtt on every playlist re-render.
   *
   * @param {string} lang           Language code
   * @param {string} playlistContent M3U8 text
   */
  updateCaptionPlaylist(lang, playlistContent) {
    this._captionPlaylists.set(lang, playlistContent);
  }

  /**
   * Queue an audio segment for the next push cycle.
   * Called by AudioHlsPublisher when a new TS segment is written to disk.
   *
   * @param {string} lang         Language code, e.g. "en" or "src"
   * @param {string} filename     Segment filename, e.g. "seg-00001.ts"
   * @param {Buffer} data         Segment binary content
   */
  enqueueAudioSegment(lang, filename, data) {
    const list = this._pendingAudio.get(lang) || [];
    list.push({ filename, data, contentType: 'video/mp2t' });
    this._pendingAudio.set(lang, list);
  }

  /**
   * Update the audio HLS playlist for a given language.
   *
   * @param {string} lang           Language code
   * @param {string} playlistContent M3U8 text
   */
  updateAudioPlaylist(lang, playlistContent) {
    this._audioPlaylists.set(lang, playlistContent);
  }

  // ── Polling loop ───────────────────────────────────────────────────────────

  _schedulePoll() {
    if (!this._running) return;
    this._pollTimer = setTimeout(() => this._poll(), this.pollIntervalMs);
  }

  async _poll() {
    try {
      await this._pollOnce();
    } catch (err) {
      this.logger.warn({ err }, '[assembler] poll error');
    } finally {
      this._schedulePoll();
    }
  }

  async _pollOnce() {
    // Step 1: resolve variant URL from raw master manifest if not yet done
    if (!this._rawVariantUrl) {
      const master = await this._fetch(`${this.rawEgressBaseUrl}/index.m3u8`);
      this._rawVariantUrl = this._parseFirstVariantUrl(master, this.rawEgressBaseUrl);
      if (!this._rawVariantUrl) {
        this.logger.debug('[assembler] raw master not ready yet');
        return;
      }
      this.logger.info({ variantUrl: this._rawVariantUrl }, '[assembler] resolved raw variant URL');
    }

    // Step 2: fetch raw media playlist
    const playlist = await this._fetch(this._rawVariantUrl);
    const { mediaSequence, segments } = this._parseMediaPlaylist(playlist, this._rawVariantUrl);

    // Step 3: find new segments we haven't forwarded yet
    const newSegments = segments.filter(s => !this._seenVideoSegments.has(s.url));
    if (newSegments.length === 0) return;

    this._videoMediaSequence = mediaSequence + segments.indexOf(newSegments[0]);

    for (const seg of newSegments) {
      this._seenVideoSegments.add(seg.url);
      await this._forwardVideoSegment(seg);
    }
  }

  async _forwardVideoSegment(seg) {
    this.logger.info({ filename: seg.filename }, '[assembler] forwarding video segment');

    // Download from raw channel
    const videoData = await this._fetchBinary(seg.url);

    // Push video segment to output channel
    await this.pusher.put('video', seg.filename, videoData, 'video/mp2t');

    // Flush pending captions and audio
    await this._flushPending();

    // Push updated playlists after flushing segments
    await this._pushPlaylists();
  }

  async _flushPending() {
    for (const [lang, items] of this._pendingCaptions) {
      for (const item of items) {
        await this.pusher.put(`captions-${lang}`, item.filename, item.data, item.contentType);
      }
      this._pendingCaptions.set(lang, []);
    }

    for (const [lang, items] of this._pendingAudio) {
      for (const item of items) {
        await this.pusher.put(`dub-${lang}`, item.filename, item.data, item.contentType);
      }
      this._pendingAudio.set(lang, []);
    }
  }

  async _pushPlaylists() {
    for (const [lang, playlist] of this._captionPlaylists) {
      if (playlist) {
        await this.pusher.put(`captions-${lang}`, 'index.m3u8', playlist, 'application/vnd.apple.mpegurl');
      }
    }

    for (const [lang, playlist] of this._audioPlaylists) {
      if (playlist) {
        await this.pusher.put(`dub-${lang}`, 'audio.m3u8', playlist, 'application/vnd.apple.mpegurl');
      }
    }

    // Push updated video variant playlist pointing to forwarded segments
    await this._pushVideoPlaylist();

    // Push master manifest
    await this._pushMasterManifest();
  }

  async _pushVideoPlaylist() {
    const seenArr = [...this._seenVideoSegments];
    const windowSize = 5;
    const window = seenArr.slice(-windowSize);
    const firstSeq = Math.max(0, seenArr.length - windowSize);

    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${this.segmentDurationSec}`,
      `#EXT-X-MEDIA-SEQUENCE:${firstSeq}`
    ];

    for (const url of window) {
      const filename = url.split('/').pop();
      lines.push(`#EXTINF:${this.segmentDurationSec}.000,`);
      lines.push(filename);  // relative to the video playlist directory (no video/ prefix)
    }

    await this.pusher.put('video', 'index.m3u8', lines.join('\n'), 'application/vnd.apple.mpegurl');
  }

  async _pushMasterManifest() {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];

    // Audio groups
    for (const lang of this._audioLangs) {
      const isDefault = lang === 'src';
      const name = lang === 'src' ? 'Original' : `Dub ${lang}`;
      lines.push(
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="dub-audio",LANGUAGE="${lang}",NAME="${name}",DEFAULT=${isDefault ? 'YES' : 'NO'},AUTOSELECT=YES,URI="dub-${lang}/audio.m3u8"`
      );
    }

    // Subtitle groups
    for (const lang of this._captionLangs) {
      const isDefault = lang === 'src';
      const name = lang === 'src' ? 'Source' : lang;
      lines.push(
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="${lang}",NAME="${name}",DEFAULT=${isDefault ? 'YES' : 'NO'},AUTOSELECT=${isDefault ? 'YES' : 'NO'},URI="captions-${lang}/index.m3u8"`
      );
    }

    // Stream inf
    const audioAttr = this._audioLangs.size > 0 ? ',AUDIO="dub-audio"' : '';
    const subsAttr  = this._captionLangs.size > 0 ? ',SUBTITLES="subs"' : '';
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=4000000${audioAttr}${subsAttr}`);
    lines.push('video/index.m3u8');

    // PUT primary manifest — no track prefix, filename matches the MPv2 endpoint manifestName ('index')
    await this.pusher.put('', 'index.m3u8', lines.join('\n'), 'application/vnd.apple.mpegurl');
  }

  // ── HTTP helpers ───────────────────────────────────────────────────────────

  _fetch(url) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https:') ? https : http;
      mod.get(url, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`GET ${url} → ${res.statusCode}`));
        }
        let body = '';
        res.on('data', d => { body += d; });
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });
  }

  _fetchBinary(url) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https:') ? https : http;
      mod.get(url, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`GET ${url} → ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
  }

  // ── HLS parsing ────────────────────────────────────────────────────────────

  _parseFirstVariantUrl(masterContent, baseUrl) {
    const lines = masterContent.split('\n').map(l => l.trim());
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF') && lines[i + 1] && !lines[i + 1].startsWith('#')) {
        const variantLine = lines[i + 1];
        if (variantLine.startsWith('http')) return variantLine;
        return `${baseUrl}/${variantLine.replace(/^\//, '')}`;
      }
    }
    return null;
  }

  _parseMediaPlaylist(content, baseUrl) {
    const lines = content.split('\n').map(l => l.trim());
    let mediaSequence = 0;
    const segments = [];
    const base = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSequence = parseInt(lines[i].split(':')[1], 10);
      }
      if (lines[i].startsWith('#EXTINF') && lines[i + 1] && !lines[i + 1].startsWith('#')) {
        const segLine = lines[i + 1];
        const url = segLine.startsWith('http') ? segLine : `${base}${segLine.replace(/^\//, '')}`;
        const filename = segLine.split('/').pop().split('?')[0];
        segments.push({ url, filename });
      }
    }

    return { mediaSequence, segments };
  }
}

module.exports = SegmentAssembler;

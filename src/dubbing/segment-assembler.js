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
  constructor({
    rawEgressBaseUrl,
    pusher,
    logger,
    pollIntervalMs = 2000,
    segmentDurationSec = 6,
    outputDelaySegments = 2,
    sourceAudioEmbedded = true,
    masterManifestVersion = 6
  }) {
    super();
    this.rawEgressBaseUrl = rawEgressBaseUrl.replace(/\/$/, '');
    this.pusher = pusher;
    this.logger = logger;
    this.pollIntervalMs = pollIntervalMs;
    this.segmentDurationSec = segmentDurationSec;
    this.outputDelaySegments = Math.max(0, outputDelaySegments);
    this.sourceAudioEmbedded = !!sourceAudioEmbedded;
    this.masterManifestVersion = Math.max(4, masterManifestVersion || 6);

    // Track which video segments we have already forwarded
    this._seenVideoSegments = new Set();
    // Metadata for forwarded video segments, used to build output index_1.m3u8.
    this._videoSegments = [];
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
    this.logger.info(
      { rawEgressBaseUrl: this.rawEgressBaseUrl, captionLangs: [...this._captionLangs], audioLangs: [...this._audioLangs] },
      '[assembler] starting'
    );
    // Push master manifest once now so players can discover the stream immediately.
    // It will be re-pushed only if registerCaptionLang/registerAudioLang is called later.
    this._pushMasterManifest().catch(err =>
      this.logger.warn({ err }, '[assembler] initial master manifest push failed')
    );
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
    if (this._running) {
      this._pushMasterManifest().catch(err =>
        this.logger.warn({ err, lang }, '[assembler] master manifest re-push failed after registerCaptionLang')
      );
    }
  }

  /**
   * Register an audio dubbing language track.
   */
  registerAudioLang(lang) {
    this._audioLangs.add(lang);
    if (!this._pendingAudio.has(lang)) this._pendingAudio.set(lang, []);
    if (this._running) {
      this._pushMasterManifest().catch(err =>
        this.logger.warn({ err, lang }, '[assembler] master manifest re-push failed after registerAudioLang')
      );
    }
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
      this.logger.debug({ url: `${this.rawEgressBaseUrl}/index.m3u8` }, '[assembler] fetching raw master manifest');
      const master = await this._fetch(`${this.rawEgressBaseUrl}/index.m3u8`);
      this._rawVariantUrl = this._parseFirstVariantUrl(master, this.rawEgressBaseUrl);
      if (!this._rawVariantUrl) {
        this.logger.debug('[assembler] raw master not ready yet (no variant URL found)');
        return;
      }
      this.logger.info({ variantUrl: this._rawVariantUrl }, '[assembler] resolved raw variant URL');
    }

    // Step 2: fetch raw media playlist
    this.logger.debug({ variantUrl: this._rawVariantUrl }, '[assembler] fetching raw variant playlist');
    const playlist = await this._fetch(this._rawVariantUrl);
    const { mediaSequence, segments } = this._parseMediaPlaylist(playlist, this._rawVariantUrl);

    // Step 3: find new segments we haven't forwarded yet
    const newSegments = segments.filter(s => !this._seenVideoSegments.has(s.url));
    this.logger.debug(
      { totalSegments: segments.length, newSegments: newSegments.length, mediaSequence },
      '[assembler] playlist parsed'
    );
    if (newSegments.length === 0) return;

    this._videoMediaSequence = mediaSequence + segments.indexOf(newSegments[0]);

    for (const seg of newSegments) {
      this._seenVideoSegments.add(seg.url);
      await this._forwardVideoSegment(seg);
    }
  }

  async _forwardVideoSegment(seg) {
    this.logger.info({ filename: seg.filename, url: seg.url }, '[assembler] downloading video segment');
    const t0 = Date.now();

    // Download from raw channel
    const videoData = await this._fetchBinary(seg.url);
    this.logger.debug({ filename: seg.filename, bytes: videoData.length, ms: Date.now() - t0 }, '[assembler] video segment downloaded');

    // Push video segment to output channel — flat path, no track subdirectory
    this.logger.debug({ filename: seg.filename, bytes: videoData.length }, '[assembler] pushing video segment to output MPv2');
    await this.pusher.put('', seg.filename, videoData, 'video/mp2t');
    this.logger.info({ filename: seg.filename, ms: Date.now() - t0 }, '[assembler] video segment pushed');

    // Keep a small rolling timeline so the generated playlist mirrors source timing.
    this._videoSegments.push({
      filename: seg.filename,
      duration: seg.duration,
      discontinuity: !!seg.discontinuity,
      programDateTime: seg.programDateTime || null
    });
    if (this._videoSegments.length > 200) this._videoSegments.shift();

    // Flush pending captions and audio
    await this._flushPending();

    // Push updated playlists after flushing segments
    await this._pushPlaylists();

    this.logger.info({ filename: seg.filename, totalMs: Date.now() - t0 }, '[assembler] segment cycle complete');
  }

  async _flushPending() {
    // MPv2 requires flat path structure — no subdirectories.
    // Video segments keep their original name (seg_1_xxx.ts — unique by sequence).
    // Audio/caption segments are prefixed with the track name to avoid collisions.
    // All segment PUTs are fired in parallel — they are independent of each other.
    const puts = [];
    let captionCount = 0;
    let audioCount = 0;

    for (const [lang, items] of this._pendingCaptions) {
      for (const item of items) {
        const flatFilename = `captions-${lang}-${item.filename}`;
        puts.push(this.pusher.put('', flatFilename, item.data, item.contentType));
        captionCount++;
      }
      this._pendingCaptions.set(lang, []);
    }

    for (const [lang, items] of this._pendingAudio) {
      for (const item of items) {
        const flatFilename = `audio-${lang}-${item.filename}`;
        puts.push(this.pusher.put('', flatFilename, item.data, item.contentType));
        audioCount++;
      }
      this._pendingAudio.set(lang, []);
    }

    if (puts.length > 0) {
      this.logger.debug({ captionSegments: captionCount, audioSegments: audioCount }, '[assembler] flushing pending segments');
    }
    await Promise.all(puts);
  }

  async _pushPlaylists() {
    // Caption playlists: regenerate with flat segment URIs (original from LiveWebVtt
    // has absolute /captions/... paths pointing at the Node.js server — unusable here).
    // Audio, caption, and video variant playlists are all independent — fire in parallel.
    // Master manifest is NOT pushed here; it is pushed once at start() and on track changes.
    const puts = [];
    const names = [];

    for (const [lang, playlist] of this._captionPlaylists) {
      if (playlist) {
        const flat = this._rewriteCaptionPlaylist(lang, playlist);
        puts.push(this.pusher.put('', `captions-${lang}.m3u8`, flat, 'application/vnd.apple.mpegurl'));
        names.push(`captions-${lang}.m3u8`);
      }
    }

    // Audio playlists: rewrite segment lines to use prefixed filenames.
    for (const [lang, playlist] of this._audioPlaylists) {
      if (playlist) {
        const flat = this._rewriteAudioPlaylist(lang, playlist);
        puts.push(this.pusher.put('', `audio-${lang}.m3u8`, flat, 'application/vnd.apple.mpegurl'));
        names.push(`audio-${lang}.m3u8`);
      }
    }

    // Video variant playlist — parallel with track playlists (segments already up)
    puts.push(this._pushVideoPlaylist());
    names.push('index_1.m3u8');

    this.logger.debug({ playlists: names }, '[assembler] pushing playlists');
    await Promise.all(puts);
    this.logger.debug({ playlists: names }, '[assembler] playlists pushed ok');
  }

  /**
   * Rewrite an audio HLS playlist (from AudioHlsPublisher) so that each segment
   * filename is prefixed with `audio-{lang}-` to keep the flat MPv2 namespace collision-free.
   */
  _rewriteAudioPlaylist(lang, content) {
    return content.split('\n').map(line => {
      const trimmed = line.trim();
      // Segment lines: non-empty, not a tag, not a comment
      if (trimmed && !trimmed.startsWith('#') && trimmed.endsWith('.ts')) {
        return `audio-${lang}-${trimmed.split('/').pop()}`;
      }
      return line;
    }).join('\n');
  }

  /**
   * Rewrite a caption playlist (from LiveWebVtt) whose segment URIs point at the
   * Node.js server (/captions/src/segments/0.vtt).  Replace each .vtt line with a
   * flat MPv2-compatible filename: `captions-{lang}-{index}.vtt`.
   */
  _rewriteCaptionPlaylist(lang, content) {
    return content.split('\n').map(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.endsWith('.vtt')) {
        // Extract just the filename (last path segment)
        const filename = trimmed.split('/').pop();
        return `captions-${lang}-${filename}`;
      }
      return line;
    }).join('\n');
  }

  async _pushVideoPlaylist() {
    const windowSize = 9;
    const total = this._videoSegments.length;
    const delayedTotal = Math.max(0, total - this.outputDelaySegments);
    const firstSeq = Math.max(0, delayedTotal - windowSize);
    const window = this._videoSegments.slice(firstSeq, delayedTotal);

    if (window.length === 0) return;

    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${this.segmentDurationSec}`,
      `#EXT-X-MEDIA-SEQUENCE:${firstSeq}`
    ];

    // Keep output variant minimal and MPv2-friendly.
    for (const seg of window) {
      lines.push(`#EXTINF:${Number(this.segmentDurationSec).toFixed(3)},`);
      lines.push(seg.filename);  // flat — same level as index_1.m3u8
    }

    // MPv2 convention: video variant playlist is named index_1.m3u8 (matches MediaLive output)
    await this.pusher.put('', 'index_1.m3u8', lines.join('\n'), 'application/vnd.apple.mpegurl');
  }

  async _pushMasterManifest() {
    const lines = ['#EXTM3U', `#EXT-X-VERSION:${this.masterManifestVersion}`, '#EXT-X-INDEPENDENT-SEGMENTS'];

    // Audio renditions — flat URIs required by MPv2 ingest (no subdirectories)
    for (const lang of this._audioLangs) {
      const isDefault = lang === 'src';
      const name = lang === 'src' ? 'Original' : `Dub ${lang}`;
      if (isDefault && this.sourceAudioEmbedded) {
        // Source audio is muxed in the video variant; omit URI for compatibility.
        lines.push(
          `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="dub-audio",LANGUAGE="${lang}",NAME="${name}",DEFAULT=YES,AUTOSELECT=YES`
        );
      } else {
        lines.push(
          `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="dub-audio",LANGUAGE="${lang}",NAME="${name}",DEFAULT=${isDefault ? 'YES' : 'NO'},AUTOSELECT=YES,URI="audio-${lang}.m3u8"`
        );
      }
    }

    // Subtitle renditions — flat URIs
    for (const lang of this._captionLangs) {
      const name = lang === 'src' ? 'Source' : lang;
      lines.push(
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="${lang}",NAME="${name}",DEFAULT=NO,AUTOSELECT=NO,URI="captions-${lang}.m3u8"`
      );
    }

    // Video stream — add a plain video-only fallback first for strict players.
    // Some clients fail when the first variant references alternate AUDIO/SUBTITLES groups.
    const audioAttr = this._audioLangs.size > 0 ? ',AUDIO="dub-audio"' : '';
    const subsAttr  = this._captionLangs.size > 0 ? ',SUBTITLES="subs"' : '';
    lines.push('#EXT-X-STREAM-INF:BANDWIDTH=4000000');
    lines.push('index_1.m3u8');
    if (audioAttr) {
      lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=4000000${audioAttr}`);
      lines.push('index_1.m3u8');
    }
    if (subsAttr) {
      lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=4000000${audioAttr}${subsAttr}`);
      lines.push('index_1.m3u8');
    }

    // PUT to the bare ingest base URL — this IS the primary manifest endpoint.
    // Child playlists and segments go to {ingestBaseUrl}/{filename}.
    await this.pusher.put('', '', lines.join('\n'), 'application/vnd.apple.mpegurl');
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
    let pendingDuration = this.segmentDurationSec;
    let pendingDiscontinuity = false;
    let pendingProgramDateTime = null;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSequence = parseInt(lines[i].split(':')[1], 10);
      }
      if (lines[i].startsWith('#EXT-X-DISCONTINUITY')) {
        pendingDiscontinuity = true;
      }
      if (lines[i].startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
        pendingProgramDateTime = lines[i].split(':').slice(1).join(':');
      }
      if (lines[i].startsWith('#EXTINF')) {
        const parsed = parseFloat(lines[i].split(':')[1]);
        if (!Number.isNaN(parsed)) pendingDuration = parsed;
      }
      if (lines[i].startsWith('#EXTINF') && lines[i + 1] && !lines[i + 1].startsWith('#')) {
        const segLine = lines[i + 1];
        const url = segLine.startsWith('http') ? segLine : `${base}${segLine.replace(/^\//, '')}`;
        const filename = segLine.split('/').pop().split('?')[0];
        segments.push({
          url,
          filename,
          duration: pendingDuration,
          discontinuity: pendingDiscontinuity,
          programDateTime: pendingProgramDateTime
        });
        pendingDuration = this.segmentDurationSec;
        pendingDiscontinuity = false;
        pendingProgramDateTime = null;
      }
    }

    return { mediaSequence, segments };
  }
}

module.exports = SegmentAssembler;

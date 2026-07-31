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

    // MPv2 HLS ingest requires file names to follow the manifestName stem pattern:
    //   master   = <stem>.m3u8
    //   variant  = <stem>_<N>.m3u8
    //   segment  = <stem>_<N>_<seq>.<ext>
    // We allocate stable per-track indices: video=1, audio[lang]=2..., captions[lang]=N+1...
    this._videoTrackIndex = 1;
    this._nextTrackIndex = 2;
    this._audioTrackIndex = new Map();   // lang -> index
    this._captionTrackIndex = new Map(); // lang -> index
    // Per-track sequence counters — seeded from wall-clock time so a fresh SegmentAssembler
    // (created on every RTMP reconnect) never reuses sequence numbers already ingested by a
    // prior instance on the same long-lived output MPv2 channel.
    this._videoSegSeq = Date.now();
    this._audioSegSeq = new Map();        // lang -> next seq
    this._captionSegSeq = new Map();      // lang -> next seq
    // Per-track filename remap (original upstream filename -> ingest filename)
    this._audioSegRename = new Map();     // lang -> Map<origName, newName>
    this._captionSegRename = new Map();   // lang -> Map<origName, newName>
    // Track signature of master manifest contents (avoid spamming MPv2)
    this._lastMasterSignature = null;

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
    // Master manifest is pushed only AFTER variant playlists exist on the channel
    // (see _pushPlaylists). MPv2 will not serve a master that references missing variants.
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
    if (!this._captionTrackIndex.has(lang)) {
      this._captionTrackIndex.set(lang, this._nextTrackIndex++);
      this._captionSegSeq.set(lang, Date.now());
      this._captionSegRename.set(lang, new Map());
    }
    // Master is re-pushed from _pushPlaylists after variants exist; nothing to do here.
  }

  /**
   * Register an audio dubbing language track.
   */
  registerAudioLang(lang) {
    this._audioLangs.add(lang);
    if (!this._pendingAudio.has(lang)) this._pendingAudio.set(lang, []);
    if (!this._audioTrackIndex.has(lang)) {
      this._audioTrackIndex.set(lang, this._nextTrackIndex++);
      this._audioSegSeq.set(lang, Date.now());
      this._audioSegRename.set(lang, new Map());
    }
    // Master is re-pushed from _pushPlaylists after variants exist; nothing to do here.
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

    // Push video segment to output channel using MPv2 egress naming: seg_<videoIdx>_<seq>.ts
    // (master = index.m3u8, variants = index_<N>.m3u8, segments = seg_<N>_<seq>.<ext>
    //  per OriginEndpoint segmentName='seg').
    const seq = this._videoSegSeq++;
    const ingestName = `seg_${this._videoTrackIndex}_${seq}.ts`;
    this.logger.debug({ filename: seg.filename, ingestName, bytes: videoData.length }, '[assembler] pushing video segment to output MPv2');
    await this.pusher.put('', ingestName, videoData, 'video/mp2t');
    this.logger.info({ filename: seg.filename, ingestName, ms: Date.now() - t0 }, '[assembler] video segment pushed');

    // Keep a small rolling timeline so the generated playlist mirrors source timing.
    this._videoSegments.push({
      filename: ingestName,
      seq,
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
    // MPv2 HLS ingest requires file names with manifestName stem prefix:
    //   index_<trackIdx>_<seq>.<ext>
    // We rename upstream filenames here and store the mapping so playlist rewrites
    // can translate references later.
    const puts = [];
    let captionCount = 0;
    let audioCount = 0;

    for (const [lang, items] of this._pendingCaptions) {
      const trackIdx = this._captionTrackIndex.get(lang);
      if (trackIdx === undefined) {
        this._pendingCaptions.set(lang, []);
        continue;
      }
      const renameMap = this._captionSegRename.get(lang);
      for (const item of items) {
        const seq = this._captionSegSeq.get(lang);
        const ingestName = `seg_${trackIdx}_${seq}.vtt`;
        this._captionSegSeq.set(lang, seq + 1);
        renameMap.set(item.filename, ingestName);
        puts.push(this.pusher.put('', ingestName, item.data, item.contentType));
        captionCount++;
      }
      this._pendingCaptions.set(lang, []);
    }

    for (const [lang, items] of this._pendingAudio) {
      const trackIdx = this._audioTrackIndex.get(lang);
      if (trackIdx === undefined) {
        this._pendingAudio.set(lang, []);
        continue;
      }
      const renameMap = this._audioSegRename.get(lang);
      for (const item of items) {
        const seq = this._audioSegSeq.get(lang);
        const ingestName = `seg_${trackIdx}_${seq}.ts`;
        this._audioSegSeq.set(lang, seq + 1);
        renameMap.set(item.filename, ingestName);
        puts.push(this.pusher.put('', ingestName, item.data, item.contentType));
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
    // MPv2 HLS ingest naming: variant playlists must be named index_<trackIdx>.m3u8
    // and reference segments named index_<trackIdx>_<seq>.<ext>.
    const puts = [];
    const names = [];
    const availableCaptionLangs = [];
    const availableAudioLangs = [];

    for (const [lang, playlist] of this._captionPlaylists) {
      if (!playlist) continue;
      const trackIdx = this._captionTrackIndex.get(lang);
      if (trackIdx === undefined) continue;
      const flat = this._rewriteCaptionPlaylist(lang, playlist);
      const variantName = `index_${trackIdx}.m3u8`;
      puts.push(this.pusher.put('', variantName, flat, 'application/vnd.apple.mpegurl'));
      names.push(variantName);
      availableCaptionLangs.push(lang);
    }

    for (const [lang, playlist] of this._audioPlaylists) {
      if (!playlist) continue;
      const trackIdx = this._audioTrackIndex.get(lang);
      if (trackIdx === undefined) continue;
      const flat = this._rewriteAudioPlaylist(lang, playlist);
      const variantName = `index_${trackIdx}.m3u8`;
      puts.push(this.pusher.put('', variantName, flat, 'application/vnd.apple.mpegurl'));
      names.push(variantName);
      availableAudioLangs.push(lang);
    }

    // Video variant playlist — parallel with track playlists (segments already up)
    puts.push(this._pushVideoPlaylist());
    names.push(`index_${this._videoTrackIndex}.m3u8`);

    this.logger.debug({ playlists: names }, '[assembler] pushing playlists');
    await Promise.all(puts);
    this.logger.debug({ playlists: names }, '[assembler] playlists pushed ok');

    // Push (or re-push) the master manifest only when its set of referenced variants
    // has changed AND all referenced variants are now uploaded. MPv2 will 404 the
    // primary playlist if the master references missing variant URIs.
    const signature = JSON.stringify({
      v: true,
      a: availableAudioLangs.sort(),
      c: availableCaptionLangs.sort()
    });
    if (signature !== this._lastMasterSignature) {
      try {
        await this._pushMasterManifest(availableAudioLangs, availableCaptionLangs);
        this._lastMasterSignature = signature;
      } catch (err) {
        this.logger.warn({ err }, '[assembler] master manifest push failed');
      }
    }
  }

  /**
   * Rewrite an audio HLS playlist (from AudioHlsPublisher) so each segment line
   * references the renamed MPv2 ingest filename (index_<trackIdx>_<seq>.ts).
   * Segment renames are populated by _flushPending as we upload.
   */
  _rewriteAudioPlaylist(lang, content) {
    const renameMap = this._audioSegRename.get(lang) || new Map();
    return content.split('\n').map(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.endsWith('.ts')) {
        const orig = trimmed.split('/').pop();
        return renameMap.get(orig) || orig;
      }
      return line;
    }).join('\n');
  }

  /**
   * Rewrite a caption playlist (from LiveWebVtt) so each segment line references
   * the renamed MPv2 ingest filename (index_<trackIdx>_<seq>.vtt).
   */
  _rewriteCaptionPlaylist(lang, content) {
    const renameMap = this._captionSegRename.get(lang) || new Map();
    return content.split('\n').map(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.endsWith('.vtt')) {
        const orig = trimmed.split('/').pop();
        return renameMap.get(orig) || orig;
      }
      return line;
    }).join('\n');
  }

  async _pushVideoPlaylist() {
    const windowSize = 9;
    const total = this._videoSegments.length;
    const delayedTotal = Math.max(0, total - this.outputDelaySegments);
    const firstIdx = Math.max(0, delayedTotal - windowSize);
    const window = this._videoSegments.slice(firstIdx, delayedTotal);

    if (window.length === 0) return;

    // MEDIA-SEQUENCE must reflect each segment's real, monotonic ingest seq — not its
    // position in the local rolling buffer — so it never regresses across reconnects.
    const targetDuration = Math.max(
      this.segmentDurationSec,
      ...window.map(s => Math.ceil(s.duration || this.segmentDurationSec))
    );

    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${targetDuration}`,
      `#EXT-X-MEDIA-SEQUENCE:${window[0].seq}`
    ];

    // Keep output variant minimal and MPv2-friendly.
    for (const seg of window) {
      if (seg.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
      lines.push(`#EXTINF:${Number(seg.duration || this.segmentDurationSec).toFixed(3)},`);
      lines.push(seg.filename);  // flat — same level as index_1.m3u8
    }

    // MPv2 ingest naming: video variant playlist is named index_<videoTrackIdx>.m3u8
    const variantName = `index_${this._videoTrackIndex}.m3u8`;
    await this.pusher.put('', variantName, lines.join('\n'), 'application/vnd.apple.mpegurl');
  }

  async _pushMasterManifest(availableAudioLangs = null, availableCaptionLangs = null) {
    // Only reference variants that have actually been uploaded; MPv2 will reject the
    // primary playlist if it references missing variant URIs.
    const audioLangs = availableAudioLangs !== null
      ? availableAudioLangs
      : [...this._audioLangs];
    const captionLangs = availableCaptionLangs !== null
      ? availableCaptionLangs
      : [...this._captionLangs];

    const lines = ['#EXTM3U', `#EXT-X-VERSION:${this.masterManifestVersion}`, '#EXT-X-INDEPENDENT-SEGMENTS'];

    // Audio renditions — variant URIs follow MPv2 ingest naming: index_<trackIdx>.m3u8
    for (const lang of audioLangs) {
      const isDefault = lang === 'src';
      const name = lang === 'src' ? 'Original' : `Dub ${lang}`;
      const trackIdx = this._audioTrackIndex.get(lang);
      if (isDefault && this.sourceAudioEmbedded) {
        // Source audio is muxed in the video variant; omit URI for compatibility.
        lines.push(
          `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="dub-audio",LANGUAGE="${lang}",NAME="${name}",DEFAULT=YES,AUTOSELECT=YES`
        );
      } else {
        lines.push(
          `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="dub-audio",LANGUAGE="${lang}",NAME="${name}",DEFAULT=${isDefault ? 'YES' : 'NO'},AUTOSELECT=YES,URI="index_${trackIdx}.m3u8"`
        );
      }
    }

    // Subtitle renditions — variant URIs follow MPv2 ingest naming: index_<trackIdx>.m3u8
    for (const lang of captionLangs) {
      const name = lang === 'src' ? 'Source' : lang;
      const trackIdx = this._captionTrackIndex.get(lang);
      lines.push(
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="${lang}",NAME="${name}",DEFAULT=NO,AUTOSELECT=NO,URI="index_${trackIdx}.m3u8"`
      );
    }

    // Video stream — add a plain video-only fallback first for strict players.
    // Some clients fail when the first variant references alternate AUDIO/SUBTITLES groups.
    const videoVariantUri = `index_${this._videoTrackIndex}.m3u8`;
    const audioAttr = audioLangs.length > 0 ? ',AUDIO="dub-audio"' : '';
    const subsAttr  = captionLangs.length > 0 ? ',SUBTITLES="subs"' : '';
    lines.push('#EXT-X-STREAM-INF:BANDWIDTH=4000000');
    lines.push(videoVariantUri);
    if (audioAttr) {
      lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=4000000${audioAttr}`);
      lines.push(videoVariantUri);
    }
    if (subsAttr) {
      lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=4000000${audioAttr}${subsAttr}`);
      lines.push(videoVariantUri);
    }

    // PUT to the bare ingest base URL — this IS the primary manifest endpoint.
    // Child playlists and segments are siblings under {ingestDirUrl}/{filename}.
    await this.pusher.put('', '', lines.join('\n'), 'application/vnd.apple.mpegurl');
    this.logger.info({ audioLangs, captionLangs }, '[assembler] master manifest pushed');
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

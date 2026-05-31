class LiveWebVtt {
  /**
   * @param {object} opts
   * @param {object}   opts.logger
   * @param {number}   [opts.segmentDurationMs]
   * @param {number}   [opts.windowSegments]
   * @param {string}   [opts.basePath]
   * @param {number}   [opts.minCueDurationMs]
   * @param {string}   [opts.lang]             Language code for assembler notifications (e.g. 'en', 'src')
   * @param {object}   [opts.segmentAssembler] SegmentAssembler instance to notify on new segments
   */
  constructor({ logger, segmentDurationMs, windowSegments, basePath = '/captions', minCueDurationMs = 2500, lang = null, segmentAssembler = null }) {
    this.logger = logger;
    this.segmentDurationMs = Math.max(segmentDurationMs || 6000, 1000);
    this.windowSegments = Math.max(windowSegments || 5, 1);
    this.basePath = basePath;
    this.minCueDurationMs = Math.max(minCueDurationMs || 0, 0);
    this.lang = lang;
    this.segmentAssembler = segmentAssembler;
    this.segments = new Map();
    this.cues = [];
    this.latestSegmentIndex = -1;
    this._assemblerNotifiedSegments = new Set();
  }

  addCue(cue) {
    const normalizedCue = this.normalizeCue(cue);

    if (!normalizedCue) {
      return;
    }

    this.cues.push(normalizedCue);

    const startIndex = Math.floor(normalizedCue.startMs / this.segmentDurationMs);
    const endIndex = Math.floor(Math.max(normalizedCue.endMs - 1, normalizedCue.startMs) / this.segmentDurationMs);

    for (let index = startIndex; index <= endIndex; index += 1) {
      const segment = this.getOrCreateSegment(index);
      const segmentStartMs = segment.startMs;
      const localStartMs = Math.max(0, normalizedCue.startMs - segmentStartMs);
      const localEndMs = Math.min(this.segmentDurationMs, normalizedCue.endMs - segmentStartMs);

      if (localEndMs <= localStartMs) {
        continue;
      }

      segment.cues.push({
        startMs: localStartMs,
        endMs: localEndMs,
        text: normalizedCue.text
      });
      segment.cues.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
    }

    this.latestSegmentIndex = Math.max(this.latestSegmentIndex, endIndex);
    this.prune();

    // Notify assembler about newly completed segments (all segments up to endIndex)
    if (this.segmentAssembler && this.lang) {
      for (let idx = Math.max(0, endIndex - 1); idx <= endIndex; idx++) {
        if (!this._assemblerNotifiedSegments.has(idx)) {
          const vttContent = this.renderSegment(idx);
          if (vttContent) {
            this._assemblerNotifiedSegments.add(idx);
            this.segmentAssembler.enqueueCaptionSegment(this.lang, idx, vttContent);
          }
        }
      }
      // Always push the latest playlist state
      this.segmentAssembler.updateCaptionPlaylist(this.lang, this.renderPlaylist());
    }
  }

  renderPlaylist() {
    if (this.latestSegmentIndex < 0) {
      return [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        `#EXT-X-TARGETDURATION:${Math.ceil(this.segmentDurationMs / 1000)}`,
        '#EXT-X-MEDIA-SEQUENCE:0'
      ].join('\n');
    }

    const firstSegmentIndex = this.getFirstSegmentIndex();
    const playlistLines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(this.segmentDurationMs / 1000)}`,
      `#EXT-X-MEDIA-SEQUENCE:${firstSegmentIndex}`
    ];

    for (let index = firstSegmentIndex; index <= this.latestSegmentIndex; index += 1) {
      this.getOrCreateSegment(index);
      playlistLines.push(`#EXTINF:${(this.segmentDurationMs / 1000).toFixed(3)},`);
      playlistLines.push(`${this.basePath}/segments/${index}.vtt`);
    }

    return playlistLines.join('\n');
  }

  renderSegment(index) {
    const segment = this.segments.get(index);

    if (!segment) {
      return null;
    }

    const lines = [
      'WEBVTT',
      `X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:${segment.startMs * 90}`,
      ''
    ];

    const segmentEndMs = segment.startMs + this.segmentDurationMs;

    for (const cue of this.getRenderableCues()) {
      const localStartMs = Math.max(0, cue.startMs - segment.startMs);
      const localEndMs = Math.min(this.segmentDurationMs, cue.endMs - segment.startMs);

      if (cue.endMs <= segment.startMs || cue.startMs >= segmentEndMs || localEndMs <= localStartMs) {
        continue;
      }

      lines.push(`${this.formatTimestamp(localStartMs)} --> ${this.formatTimestamp(localEndMs)}`);
      lines.push(cue.text);
      lines.push('');
    }

    return lines.join('\n');
  }

  renderLiveVtt() {
    const firstSegmentIndex = this.getFirstSegmentIndex();
    const earliestMs = firstSegmentIndex * this.segmentDurationMs;
    const lines = ['WEBVTT', ''];

    for (const cue of this.getRenderableCues()) {
      if (cue.endMs <= earliestMs) {
        continue;
      }

      lines.push(`${this.formatTimestamp(cue.startMs)} --> ${this.formatTimestamp(cue.endMs)}`);
      lines.push(cue.text);
      lines.push('');
    }

    return lines.join('\n');
  }

  getRenderableCues() {
    return this.cues
      .map((cue, index) => {
        const nextCue = this.cues[index + 1];
        const clippedEndMs = nextCue ? Math.min(cue.endMs, nextCue.startMs) : cue.endMs;

        if (clippedEndMs <= cue.startMs) {
          return null;
        }

        return {
          startMs: cue.startMs,
          endMs: clippedEndMs,
          text: cue.text
        };
      })
      .filter(Boolean);
  }

  getFirstSegmentIndex() {
    return Math.max(this.latestSegmentIndex - this.windowSegments + 1, 0);
  }

  getOrCreateSegment(index) {
    if (!this.segments.has(index)) {
      this.segments.set(index, {
        index,
        startMs: index * this.segmentDurationMs,
        cues: []
      });
    }

    return this.segments.get(index);
  }

  normalizeCue(cue) {
    if (!cue || !Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs) || cue.endMs <= cue.startMs) {
      this.logger.warn({ cue }, 'Skipping invalid caption cue');
      return null;
    }

    const text = String(cue.text || '').replace(/\s+/g, ' ').trim();

    if (!text) {
      return null;
    }

    return {
      startMs: cue.startMs,
      endMs: Math.max(cue.endMs, cue.startMs + this.minCueDurationMs),
      text
    };
  }

  prune() {
    const firstSegmentIndex = this.getFirstSegmentIndex();
    const earliestMs = firstSegmentIndex * this.segmentDurationMs;

    for (const index of this.segments.keys()) {
      if (index < firstSegmentIndex) {
        this.segments.delete(index);
      }
    }

    this.cues = this.cues.filter((cue) => cue.endMs > earliestMs);
  }

  formatTimestamp(valueMs) {
    const totalMs = Math.max(0, Math.floor(valueMs));
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const milliseconds = totalMs % 1000;

    return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':') + `.${String(milliseconds).padStart(3, '0')}`;
  }
}

module.exports = LiveWebVtt;

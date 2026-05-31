'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class AudioHlsPublisher {
  constructor({
    logger,
    ffmpegPath,
    dubbingStream,
    sampleRate,
    channels,
    outputRoot,
    sessionId,
    safeLang,
    audioPath,
    segmentDurationSec = 6,
    windowSegments = 5,
    // Optional: SegmentAssembler to push segments to MediaPackage output channel
    segmentAssembler = null
  }) {
    this.logger = logger;
    this.ffmpegPath = ffmpegPath || 'ffmpeg';
    this.dubbingStream = dubbingStream;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.outputRoot = outputRoot;
    this.sessionId = sessionId;
    this.safeLang = safeLang;
    this.audioPath = audioPath;
    this.segmentDurationSec = segmentDurationSec;
    this.windowSegments = windowSegments;
    this.segmentAssembler = segmentAssembler;

    this.outputDir = path.join(this.outputRoot, this.sessionId, `${this.audioPath}-${this.safeLang}`);
    this.playlistFile = path.join(this.outputDir, 'audio.m3u8');

    this._ffmpeg = null;
    this._onData = null;
    this._watcher = null;
    this._watchedSegments = new Set();
  }

  async start() {
    await fs.rm(this.outputDir, { recursive: true, force: true });
    await fs.mkdir(this.outputDir, { recursive: true });

    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-f', 's16le',
      '-ar', String(this.sampleRate),
      '-ac', String(this.channels),
      '-i', 'pipe:0',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-f', 'hls',
      '-hls_segment_type', 'mpegts',
      '-hls_time', String(this.segmentDurationSec),
      '-hls_list_size', String(this.windowSegments),
      '-hls_flags', 'delete_segments+independent_segments',
      '-hls_segment_filename', path.join(this.outputDir, 'seg-%05d.ts'),
      this.playlistFile
    ];

    this._ffmpeg = spawn(this.ffmpegPath, args, {
      stdio: ['pipe', 'ignore', 'pipe']
    });

    this._ffmpeg.stderr.on('data', (chunk) => {
      this.logger.debug({ safeLang: this.safeLang, log: String(chunk).trim() }, 'Dub audio HLS ffmpeg log');
    });

    this._ffmpeg.on('exit', (code, signal) => {
      this.logger.warn({ safeLang: this.safeLang, code, signal }, 'Dub audio HLS ffmpeg exited');
    });

    this._onData = (pcmChunk) => {
      if (!this._ffmpeg || this._ffmpeg.stdin.destroyed || !this._ffmpeg.stdin.writable) {
        return;
      }

      this._ffmpeg.stdin.write(pcmChunk);
    };

    this.dubbingStream.on('data', this._onData);

    // If a SegmentAssembler is attached, watch the output directory for new TS segments
    // and forward them + updated playlist to the assembler.
    if (this.segmentAssembler) {
      this._startWatcher();
    }
  }

  _startWatcher() {
    try {
      this._watcher = fsSync.watch(this.outputDir, (eventType, filename) => {
        if (!filename) return;
        if (filename.endsWith('.ts') && !this._watchedSegments.has(filename)) {
          this._watchedSegments.add(filename);
          // Small delay to ensure the file is fully written before reading
          setTimeout(() => this._pushSegmentToAssembler(filename), 200);
        }
        if (filename === 'audio.m3u8') {
          setTimeout(() => this._pushPlaylistToAssembler(), 200);
        }
      });
    } catch (err) {
      this.logger.warn({ err, safeLang: this.safeLang }, '[audio-hls-publisher] watcher failed to start');
    }
  }

  async _pushSegmentToAssembler(filename) {
    try {
      const data = await fs.readFile(path.join(this.outputDir, filename));
      this.segmentAssembler.enqueueAudioSegment(this.safeLang, filename, data);
    } catch (err) {
      this.logger.warn({ err, filename }, '[audio-hls-publisher] failed to read segment for assembler');
    }
  }

  async _pushPlaylistToAssembler() {
    try {
      const content = await fs.readFile(this.playlistFile, 'utf8');
      this.segmentAssembler.updateAudioPlaylist(this.safeLang, content);
    } catch (err) {
      this.logger.warn({ err }, '[audio-hls-publisher] failed to read playlist for assembler');
    }
  }

  async stop() {
    if (this._watcher) {
      try { this._watcher.close(); } catch { /* ignore */ }
      this._watcher = null;
    }

    if (this._onData) {
      this.dubbingStream.removeListener('data', this._onData);
      this._onData = null;
    }

    const ffmpeg = this._ffmpeg;
    this._ffmpeg = null;

    if (!ffmpeg) {
      return;
    }

    if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
      ffmpeg.stdin.end();
    }

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { ffmpeg.kill('SIGKILL'); } catch { /* ignore */ }
      }, 1500);

      ffmpeg.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

module.exports = AudioHlsPublisher;
'use strict';

const fs = require('fs/promises');
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
    windowSegments = 5
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

    this.outputDir = path.join(this.outputRoot, this.sessionId, `${this.audioPath}-${this.safeLang}`);
    this.playlistFile = path.join(this.outputDir, 'audio.m3u8');

    this._ffmpeg = null;
    this._onData = null;
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
  }

  async stop() {
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
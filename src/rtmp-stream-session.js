const { spawn } = require('child_process');

class RtmpStreamSession {
  constructor({ logger, streamConfig, engine }) {
    this.logger = logger;
    this.streamConfig = streamConfig;
    this.engine = engine;
    this.ffmpeg = null;
    this.stopping = false;
    this.retries = 0;
    this.watchdogInterval = null;
    this.lastAudioAt = 0;
    this.audioBytes = 0;
  }

  buildFfmpegArgs() {
    const { rtmpUrl, sampleRate, channels } = this.streamConfig;

    return [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-i',
      rtmpUrl,
      '-vn',
      '-ac',
      String(channels),
      '-ar',
      String(sampleRate),
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      'pipe:1'
    ];
  }

  async start() {
    this.stopping = false;
    await this.startPipeline();
  }

  async startPipeline() {
    await this.engine.start();
    this.lastAudioAt = Date.now();
    this.audioBytes = 0;

    const args = this.buildFfmpegArgs();
    this.ffmpeg = spawn(this.streamConfig.ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.logger.info(
      {
        ffmpegPath: this.streamConfig.ffmpegPath,
        args
      },
      'Started FFmpeg for RTMP ingest'
    );

    this.ffmpeg.stdout.on('data', (chunk) => {
      this.lastAudioAt = Date.now();
      this.audioBytes += chunk.length;

       if (this.audioBytes === chunk.length || this.audioBytes % (32000 * 10) < chunk.length) {
        this.logger.info(
          {
            chunkBytes: chunk.length,
            totalAudioBytes: this.audioBytes
          },
          'Received PCM audio from FFmpeg'
        );
      }

      this.engine.sendAudio(chunk);
    });

    this.ffmpeg.stderr.on('data', (chunk) => {
      this.logger.warn({ ffmpeg: chunk.toString().trim() }, 'FFmpeg stderr');
    });

    this.startWatchdog();

    this.ffmpeg.on('close', async (code, signal) => {
      this.stopWatchdog();
      this.logger.warn({ code, signal }, 'FFmpeg process closed');
      await this.engine.finalize();

      if (this.stopping) {
        return;
      }

      const { maxRetries, reconnectDelayMs } = this.streamConfig;
      const canRetry = maxRetries === 0 || this.retries < maxRetries;

      if (!canRetry) {
        this.logger.error({ retries: this.retries }, 'Reached max retries, exiting');
        process.exitCode = 1;
        return;
      }

      this.retries += 1;
      this.logger.info(
        {
          retry: this.retries,
          reconnectDelayMs
        },
        'Restarting stream pipeline'
      );

      setTimeout(async () => {
        try {
          await this.startPipeline();
        } catch (error) {
          this.logger.error({ err: error }, 'Failed to restart pipeline');
        }
      }, reconnectDelayMs);
    });

    this.ffmpeg.on('error', (error) => {
      this.logger.error({ err: error }, 'Failed to spawn FFmpeg');
    });
  }

  startWatchdog() {
    this.stopWatchdog();

    const noAudioTimeoutMs = Math.max(this.streamConfig.noAudioTimeoutMs || 15000, 1000);
    this.watchdogInterval = setInterval(() => {
      if (this.stopping || !this.ffmpeg || this.ffmpeg.killed) {
        return;
      }

      if (!this.engine.connected) {
        this.logger.warn('Soniox disconnected, restarting FFmpeg pipeline');
        this.ffmpeg.kill('SIGTERM');
        return;
      }

      const silentForMs = Date.now() - this.lastAudioAt;
      if (silentForMs > noAudioTimeoutMs) {
        this.logger.warn(
          {
            silentForMs,
            noAudioTimeoutMs,
            audioBytes: this.audioBytes
          },
          'No audio received from FFmpeg, restarting pipeline'
        );
        this.ffmpeg.kill('SIGTERM');
      }
    }, 1000);
  }

  stopWatchdog() {
    if (!this.watchdogInterval) {
      return;
    }
    clearInterval(this.watchdogInterval);
    this.watchdogInterval = null;
  }

  async stop() {
    this.stopping = true;
    this.stopWatchdog();

    if (this.ffmpeg && !this.ffmpeg.killed) {
      this.ffmpeg.kill('SIGTERM');
    }

    await this.engine.stop();
  }
}

module.exports = RtmpStreamSession;

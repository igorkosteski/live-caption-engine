# Live Caption Engine

Node.js service that reads audio from an RTMP live stream and transcribes it using pluggable engines.

This initial version includes:
- Engine abstraction for multiple transcription providers
- Soniox realtime WebSocket engine implementation
- RTMP ingest with FFmpeg
- Docker setup for local runs
- ECS-ready Dockerfile and task definition template

## 1. Requirements

- Node.js 20+
- FFmpeg (if running without Docker)
- Soniox API key

## 2. Quick Start (Local Node)

1. Copy environment template and fill values:

```bash
cp .env.example .env
```

2. Install dependencies:

```bash
npm install
```

3. Start app:

```bash
npm start
```

Health endpoint:

```bash
curl http://localhost:8080/healthz
```

## 3. Local Docker

1. Prepare `.env` file:

```bash
cp .env.example .env
```

2. Build and run:

```bash
docker compose up --build
```

For an RTMP server running on the Docker host, set `RTMP_URL` to `rtmp://host.docker.internal/...`.
Inside the container, `localhost` points back to the container itself, so `rtmp://localhost/...` will not reach a host-side RTMP server.
This compose file also maps `host.docker` to the same host gateway if you prefer that alias.

3. Stop:

```bash
docker compose down
```

## 4. ECS Docker and Deploy Flow

1. Build ECS image:

```bash
docker build -f Dockerfile.ecs -t live-caption-engine:ecs .
```

2. Tag and push image to ECR:

```bash
docker tag live-caption-engine:ecs <account-id>.dkr.ecr.<region>.amazonaws.com/live-caption-engine:ecs
docker push <account-id>.dkr.ecr.<region>.amazonaws.com/live-caption-engine:ecs
```

3. Create/Update ECS task definition from template:

- Edit `deploy/ecs-task-definition.template.json`
- Set account id, region, roles, RTMP URL
- Keep `SONIOX_API_KEY` in AWS Secrets Manager

4. Run task or update ECS service with the new task revision.

## 5. Engine Architecture

- `src/engines/base-engine.js`: interface all engines implement
- `src/engines/soniox-engine.js`: Soniox realtime implementation
- `src/engines/index.js`: engine selector by `ENGINE`

To add a new provider later:
1. Create `src/engines/<provider>-engine.js`
2. Implement `start`, `sendAudio`, `finalize`, `stop`
3. Register it in `src/engines/index.js`

## 6. Important Environment Variables

- `ENGINE`: transcription engine (currently `soniox`)
- `RTMP_URL`: source RTMP stream URL
- `SONIOX_API_KEY`: Soniox API key
- `SONIOX_MODEL`: Soniox realtime model
- `SONIOX_WS_URL`: Soniox realtime WebSocket endpoint
- `AUDIO_SAMPLE_RATE`: FFmpeg output sample rate
- `AUDIO_CHANNELS`: FFmpeg output channels
- `NO_AUDIO_TIMEOUT_MS`: restart pipeline if no audio arrives for this duration
- `RECONNECT_DELAY_MS`: delay between retries
- `MAX_RETRIES`: 0 = unlimited retries

## 7. Live Captions Output

When captions are enabled, the service exposes live WebVTT output from the same HTTP server:

- `GET /captions/live.vtt`: rolling WebVTT file with the retained live cue window
- `GET /captions/index.m3u8`: HLS subtitle playlist referencing WebVTT segments
- `GET /captions/segments/<n>.vtt`: individual WebVTT subtitle segment

Useful environment variables:

- `CAPTIONS_ENABLED`: enable or disable WebVTT output
- `CAPTIONS_SEGMENT_DURATION_MS`: subtitle segment duration
- `CAPTIONS_WINDOW_SEGMENTS`: number of recent segments to retain in memory
- `CAPTIONS_BASE_PATH`: HTTP base path for caption endpoints

Example local checks:

```bash
curl http://localhost:8080/captions/live.vtt
curl http://localhost:8080/captions/index.m3u8
```

## 8. Notes

- The service logs partial and finalized transcripts to stdout.
- Finalized Soniox tokens are converted into timed WebVTT cues.
- The Soniox stream is finalized when FFmpeg stream ends.
- Use CloudWatch logs in ECS to consume transcript updates.

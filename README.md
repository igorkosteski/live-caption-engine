# Live Caption Engine

Node.js service that ingests live RTMP audio, transcribes it with pluggable realtime engines, and exposes per-session caption and dubbing endpoints.

This version includes:
- Engine abstraction for multiple transcription providers
- Soniox and Gemini realtime transcription engines
- RTMP ingest with FFmpeg
- Session lifecycle API plus RTMP auto-session management
- Optional per-language live dubbing output (Gemini Live or Polly over translated captions)
- Docker setup for local runs
- ECS-ready Dockerfile and task definition template

## 1. Requirements

- Node.js 20+
- FFmpeg (if running without Docker)
- Soniox API key if `ENGINE=soniox` (default)
- Gemini API key if `ENGINE=gemini` or `DUBBING_ENGINE=gemini`

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

## 4. Local Session Workflows

You can start a session in two ways.

### Local setup checklist

Before starting a session locally, make sure you have:

- a filled `.env` file copied from [.env.example](.env.example)
- `SONIOX_API_KEY` set if you use `ENGINE=soniox`
- `GEMINI_API_KEY` set if you use `ENGINE=gemini` or `DUBBING_ENGINE=gemini`
- a reachable RTMP source URL, usually `rtmp://host.docker.internal/...` when the app runs in Docker

If you want to control translation or dubbing at start time, pass them with the session request or RTMP publish URL.

### A. Start a session with the HTTP API

This is the most explicit option and lets you set translation and dubbing settings per session.

```bash
curl -X POST http://localhost:8080/sessions \
  -H 'Content-Type: application/json' \
  -d '{
    "rtmpUrl": "rtmp://host.docker.internal/live/primary",
    "languages": ["en", "de"],
    "dubbingLanguages": ["fr"]
  }'
```

Supported request fields:

- `rtmpUrl`: RTMP source URL for the session
- `languages`: translation target languages
- `dubbingLanguages`: dubbing target languages

The response includes per-session endpoints for captions, dubbing, and manifest playback.

### B. Start a session by publishing RTMP

When you push to the built-in RTMP server, the app can create and clean up the session automatically.

Example publish URL:

```text
rtmp://localhost:1935/live/primary?languages=en,de&dubbingLanguages=fr&sessionId=primary
```

Supported RTMP query params:

- `languages`: comma-separated translation target languages
- `dubbingLanguages`: comma-separated dubbing target languages
- `sessionId`: optional explicit session id

If `sessionId` is omitted, the app derives a stable id from the stream path. For example, `/live/primary` becomes `live-primary`.

Example with FFmpeg:

```bash
ffmpeg -re -stream_loop -1 -i sample.mp4 \
  -c copy -f flv \
  "rtmp://localhost:1935/live/primary?languages=en,de&dubbingLanguages=fr&sessionId=primary"
```

## 5. ECS Docker and Deploy Flow

1. Build ECS image:

```bash
docker build -f Dockerfile.ecs -t live-caption-engine:latest .
```

2. Tag and push image to ECR:

```bash
docker tag live-caption-engine:latest <account-id>.dkr.ecr.<region>.amazonaws.com/live-caption-engine:latest
docker push <account-id>.dkr.ecr.<region>.amazonaws.com/live-caption-engine:latest
```

3. Create or update ECS task definition from template:

- Edit `deploy/ecs-task-definition.template.json`
- Set account id, region, roles, RTMP URL
- Keep API keys in AWS Secrets Manager

4. Run task or update ECS service with the new task revision.

## 6. Engine Architecture

- `src/engines/base-engine.js`: engine interface
- `src/engines/soniox-engine.js`: single Soniox session
- `src/engines/soniox-multi-engine.js`: one Soniox session per translation target language
- `src/engines/gemini-engine.js`: Gemini realtime transcription
- `src/engines/gemini-dubbing-engine.js`: Gemini realtime dubbing
- `src/engines/polly-dubbing-engine.js`: Polly TTS dubbing from translated captions
- `src/engines/index.js`: transcription engine selector by `ENGINE`

Notes:
- `DUBBING_ENGINE=soniox` currently aliases to the Polly dubbing path (Polly TTS over Soniox translated captions).
- There is no separate Soniox-native TTS dubbing engine implementation in this repository.

## 7. Important Environment Variables

- `ENGINE`: transcription engine (`soniox` or `gemini`; default: `soniox`)
- `RTMP_URL`: source RTMP stream URL
- `SONIOX_API_KEY`: Soniox API key
- `SONIOX_MODEL`: Soniox realtime model
- `SONIOX_WS_URL`: Soniox realtime WebSocket endpoint
- `GEMINI_API_KEY`: Gemini API key
- `ENABLE_TRANSLATION`: enables translation output in the active transcription engine
- `TRANSLATION_TARGET_LANGUAGES`: comma-separated translation target languages
- `TRANSLATION_SOURCE_LANGUAGE`: optional source-language hint
- `DUBBING_ENABLED`: enables dubbing outputs
- `DUBBING_ENGINE`: `gemini`, `polly`, or `soniox` (alias to Polly path)
- `DUBBING_TARGET_LANGUAGES`: comma-separated dubbing target languages
- `DUBBING_GEMINI_VOICE`: Gemini dubbing voice (default `Aoede`)
- `POLLY_VOICES`: per-language Polly voice overrides, for example `en:Joanna,de:Daniel`
- `AUDIO_SAMPLE_RATE`: FFmpeg output sample rate
- `AUDIO_CHANNELS`: FFmpeg output channels
- `NO_AUDIO_TIMEOUT_MS`: restart pipeline if no audio arrives for this duration
- `RECONNECT_DELAY_MS`: delay between retries
- `MAX_RETRIES`: 0 means unlimited retries

## 8. Per-Session Captions and Dubbing Output

When captions are enabled, each active session exposes WebVTT and subtitle playlists:

- `GET /sessions/:sessionId/captions/live.vtt`: rolling source-language WebVTT
- `GET /sessions/:sessionId/captions/index.m3u8`: source-language subtitle playlist
- `GET /sessions/:sessionId/captions/segments/:segmentIndex.vtt`: source-language segment
- `GET /sessions/:sessionId/captions/:lang/live.vtt`: rolling translated WebVTT
- `GET /sessions/:sessionId/captions/:lang/index.m3u8`: translated subtitle playlist
- `GET /sessions/:sessionId/captions/:lang/segments/:segmentIndex.vtt`: translated segment
- `GET /sessions/:sessionId/dub/:lang/audio.pcm`: live dubbed PCM stream
- `GET /sessions/:sessionId/manifest/master.m3u8`: patched MediaPackage manifest with subtitle tracks

Useful caption variables:

- `CAPTIONS_ENABLED`
- `CAPTIONS_SEGMENT_DURATION_MS`
- `CAPTIONS_WINDOW_SEGMENTS`
- `CAPTIONS_MIN_CUE_DURATION_MS`

Example local checks:

```bash
curl http://localhost:8080/sessions
# replace <sessionId> with an active session id
curl http://localhost:8080/sessions/<sessionId>/captions/live.vtt
curl http://localhost:8080/sessions/<sessionId>/captions/en/live.vtt
curl -N http://localhost:8080/sessions/<sessionId>/dub/en/audio.pcm
```

## 9. Notes

- The service logs transcript and session lifecycle events to stdout.
- Finalized tokens are converted into timed WebVTT cues.
- Use CloudWatch logs in ECS to consume runtime updates.

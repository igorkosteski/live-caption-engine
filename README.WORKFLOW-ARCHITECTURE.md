# Live Caption Engine Workflow Architecture

This document describes the runtime workflow architecture for the current local setup and the recommended AWS production setup.

## 1. Current Local Workflow

### Component View

```mermaid
flowchart LR
  SRC[RTMP Source Encoder] -->|rtmp://localhost:1935/live/primary| APP[Live Caption Engine Node Service]

  APP -->|STT audio stream| SONIOX_STT[Soniox STT Realtime]
  SONIOX_STT -->|source + translated captions| APP

  APP -->|translated text| SONIOX_TTS[Soniox TTS Realtime]
  SONIOX_TTS -->|dubbed PCM| APP

  APP -->|HLS video pull| HLS_ORIGIN[FFmpeg HLS Origin]
  HLS_ORIGIN --> HLS_NGINX[Nginx HLS Server :9090]

  APP -->|master manifest patch| PLAYER[HLS Player]
  HLS_NGINX -->|video variant playlist + TS| PLAYER

  APP -->|captions HLS and VTT| PLAYER
  APP -->|audio renditions: src + dub en| PLAYER
```

### Data Flow

```mermaid
sequenceDiagram
  participant Encoder as RTMP Encoder
  participant Engine as Live Caption Engine
  participant STT as Soniox STT
  participant TTS as Soniox TTS
  participant Origin as HLS Origin (FFmpeg)
  participant Player as HLS Player

  Encoder->>Engine: Publish RTMP stream
  Engine->>STT: Send PCM audio chunks
  STT-->>Engine: Source captions + translated captions
  Engine->>TTS: Send translated text cues
  TTS-->>Engine: Dubbed PCM chunks

  Encoder->>Origin: RTMP ingest for video/audio mux path
  Origin-->>Player: Video variant playlist + TS segments (via Nginx)

  Engine-->>Player: Patched master manifest
  Engine-->>Player: Subtitles playlists (src + translated)
  Engine-->>Player: Audio playlists (Original src + Dub en)
```

## 2. Runtime Responsibilities

- Live Caption Engine
  - Session orchestration
  - RTMP ingest processing for STT
  - Translation and dubbing pipeline wiring
  - Captions generation (live and segmented)
  - Audio rendition generation (src and dubbed languages)
  - Master manifest patching

- HLS Origin (FFmpeg + Nginx)
  - Generates video-first HLS variant stream
  - Serves base variant playlist and TS segments

- External AI Providers
  - Soniox STT: transcription and translation
  - Soniox TTS: dubbed audio synthesis

## 3. Recommended AWS Production Architecture

```mermaid
flowchart TD
  ENC[RTMP Encoders] --> INGEST[Ingest Endpoint / RTMP Entry]

  INGEST --> ECS_API[ECS Fargate Service: Session + Manifest API]
  INGEST --> ECS_PROC[ECS Fargate Service: Stream Processor]

  ECS_PROC --> STT[STT Provider]
  ECS_PROC --> TTS[TTS Provider]

  ECS_PROC --> MEDIA[MediaPackage or HLS Origin Service]
  ECS_API --> MEDIA

  ECS_API --> REDIS[(ElastiCache Redis - optional session state)]
  ECS_API --> CW[CloudWatch Logs + Metrics]
  ECS_PROC --> CW

  MEDIA --> CF[CloudFront]
  ECS_API --> CF
  CF --> PLAYER[Web / Mobile Players]

  SECRETS[Secrets Manager] --> ECS_API
  SECRETS --> ECS_PROC
```

## 4. Scaling and Limits Strategy

- There is no strict language count in code, but practical limits come from:
  - Provider concurrency and quota
  - Task CPU and memory
  - Network throughput and end-to-end latency targets

- For AWS scaling:
  - Scale on active sessions + languages per session + CPU and memory
  - Separate session API and stream processors into distinct services
  - Apply admission controls for max languages per session
  - Prefer graceful degradation: preserve source audio/captions first, then optional dubbed tracks

## 5. Operational Checklist

- Define target concurrency and p95 latency SLO
- Set provider quota alarms and budget alarms
- Add per-session correlation IDs in logs
- Implement readiness checks for:
  - STT stream health
  - TTS stream health
  - HLS rendition freshness
- Load test with multi-language fanout before production rollout

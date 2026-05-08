# Live Caption Engine — End-to-End Workflow

This document describes how every component fits together in the AWS deployment,
how audio flows from an encoder to viewers, and what is known to need improvement
before the system is fully synchronised.

---

## 1. High-level architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Your broadcast encoder (OBS / FFmpeg / hardware)                           │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │  RTMP push
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  AWS MediaLive (RTMP_PUSH input)                                            │
│  H.264 720p 3 Mbps + AAC 192 kbps                                          │
│  EXT-X-PROGRAM-DATE-TIME every segment (wall-clock timestamp)               │
│                                                                             │
│  Output group 1 ──► MediaPackage V2  (broadcast video + audio)             │
│  Output group 2 ──► nginx-rtmp (VPC) (caption engine audio tap)            │
└────────────────────────────────────────────────────────────────────────────-┘
         │                                        │
         │  HLS segments (PUT)                    │  RTMP push (LAN)
         ▼                                        ▼
┌─────────────────────────┐          ┌────────────────────────────────────────┐
│  AWS MediaPackage V2    │          │  nginx-rtmp (EC2 / ECS, private subnet)│
│  Channel group: live-   │          │  Live-caption-engine reads from here   │
│  caption                │          └────────────────────┬───────────────────┘
│  HLS endpoint, 6 s segs │                               │  RTMP pull
│  60 s manifest window   │                               ▼
│  2 h DVR startover      │          ┌────────────────────────────────────────┐
│                         │          │  live-caption-engine (ECS Fargate)     │
│  ◄── VTT segments  ─────┼──────────│  POST /sessions { rtmpUrl, languages } │
│  ◄── AAC segments  ─────┼──────────│  FFmpeg → PCM → Soniox / Gemini        │
└──────────┬──────────────┘          │  LiveWebVtt → MediaPackagePublisher    │
           │  Origin pull            │  AudioSegmentPublisher (dubbed audio)  │
           ▼                         └────────────────────────────────────────┘
┌─────────────────────────┐
│  AWS CloudFront         │
│  OAC (SigV4)            │
│  HTTP/2 + HTTP/3        │
│  Price Class 100        │
└──────────┬──────────────┘
           │  HTTPS
           ▼
   Video player (HLS.js,
   Video.js, AVPlayer …)
   renders video + subtitles
   + dubbed audio rendition
```

---

## 2. CDK stacks and the resources they create

### Stack 1 — `LiveCaptionMedia`

Deployed first. Owns the broadcast pipeline.

| Resource | Name / value |
|---|---|
| MediaPackage V2 channel group | `live-caption` |
| MediaPackage V2 channel | `main` (two ingest endpoints) |
| MediaPackage V2 origin endpoint | `hls` — TS container, 6 s segments, PDT every 1 s |
| MediaPackage V2 endpoint policy | Allows CloudFront OAC `mediapackagev2:GetObject` |
| MediaLive input security group | Whitelisted CIDRs for the encoder |
| MediaLive RTMP_PUSH input | One or two destinations (SINGLE_PIPELINE / STANDARD) |
| MediaLive channel | H.264 720p + AAC → HLS → MediaPackage V2 |
| IAM role (MediaLive) | `mediapackagev2:PutObject` + CloudWatch logs |
| CloudFront OAC | `sigv4`, type `mediapackagev2` |
| CloudFront distribution | HTTPS CDN in front of MediaPackage V2 |

**Output values used by other stacks / operators:**

| Output key | What it is |
|---|---|
| `HlsPlaylistUrl` | Master HLS playlist URL for video players |
| `MediaPackageIngestUrl` | Primary ingest URL — live-caption-engine PUTs here |
| `MediaLiveChannelId` | Used to start / stop the channel via CLI |
| `MediaLiveInputId` | Describe to get the RTMP push URL(s) for OBS |
| `CloudFrontDistributionId` | CloudFront distribution ID |

### Stack 2 — `LiveCaptionEngine`

Deployed second (depends on Stack 1 for the ingest URL).

| Resource | Details |
|---|---|
| ECR repository | `live-caption-engine`, scan on push, 10-image lifecycle |
| VPC | 2 AZs, public + private subnets, 1 NAT GW (or imported) |
| ECS cluster | Container Insights V2 |
| ECS Fargate service | 0.5 vCPU / 1 GiB, min 1 / max 10 tasks, circuit breaker |
| Application auto-scaling | CPU > 60 % → scale out; memory > 70 % → scale out |
| Application Load Balancer | Internet-facing, sticky sessions 1 h |
| Secrets Manager | `soniox-api-key` + `gemini-api-key` injected as env vars |
| IAM execution role | ECR pull + Secrets Manager read |
| IAM task role | `mediapackagev2:PutObject`; optionally `polly:SynthesizeSpeech` |
| CloudWatch log group | `/ecs/live-caption-engine`, 30-day retention |

**Output values:**

| Output key | What it is |
|---|---|
| `AlbDnsName` | Base URL for the session REST API |
| `EcrRepositoryUri` | Push Docker images here |
| `SonioxSecretArn` | Set real key after first deploy |
| `GeminiSecretArn` | Set real key after first deploy |

---

## 3. Audio path in detail

### 3a. Broadcast audio (MediaLive → MediaPackage V2)

MediaLive encodes the encoder's audio as AAC 192 kbps, wraps it in MPEG-TS
segments, and PUTs them to MediaPackage V2 using the `hlsBasicPutSettings`
output group. MediaLive stamps every segment with an
`EXT-X-PROGRAM-DATE-TIME` tag at wall-clock time (UTC). This is the timing
anchor for all downstream synchronisation.

### 3b. Caption engine audio (nginx-rtmp tap — Option C)

MediaLive has a **second output group** (`NginxRtmpTap`) that pushes the same
stream via RTMP to a small nginx-rtmp relay running inside the private VPC
subnet. The live-caption-engine reads from that relay URL.

This output group is now supported in CDK. Pass the `nginxRtmpUrl` prop to
`MediaStack` (e.g. `rtmp://10.0.x.x:1935/live/primary`) and CDK will create
both destinations and output groups in the MediaLive channel:

```typescript
new MediaStack(app, 'LiveCaptionMedia', {
  nginxRtmpUrl: 'rtmp://<nginx-rtmp-private-ip>:1935/live/primary',
  // ... other props
});
```

For `STANDARD` channel class a second-pipeline URL is derived automatically
by appending `-b` to the stream-name component
(`rtmp://<host>:1935/live/primary-b`).

Until an nginx-rtmp server is deployed and its IP is known, the operator can
provide any RTMP or HLS URL the engine can reach (see section 5).

### 3c. PCM pipeline inside live-caption-engine

```
FFmpeg (RTMP/HLS input)
  │  raw s16le PCM, 16 kHz mono
  ▼
RtmpStreamSession.sendAudio()  ──► transcription engine (Soniox WS / Gemini WS)
  │                                 emits final-caption / final-caption-translated
  │  emit('audio', pcmChunk)
  ▼
DubbingEngine.sendAudio()      ──► GeminiDubbingEngine or PollyDubbingEngine
                                    emits PCM on DubbingStream
```

### 3d. Subtitle segments pushed to MediaPackage V2

`MediaPackagePublisher` runs on a timer (every `segmentDurationMs`, default 6 s).
It iterates completed `LiveWebVtt` segments and PUTs each one as
`<subtitlePath>/<sessionId>-<lang>/seg-N.vtt` plus a rolling `subs.m3u8`
playlist, using SigV4-signed HTTPS PUT to the MediaPackage V2 ingest URL.

### 3e. Dubbed audio segments pushed to MediaPackage V2

`AudioSegmentPublisher` accumulates PCM from `DubbingStream` until one full
segment's worth of bytes is buffered, then spawns FFmpeg to encode it to AAC
ADTS and PUTs `<audioPath>-<sessionId>-<lang>/seg-N.aac` plus `audio.m3u8`.

---

## 4. Synchronisation — current state and known gap

### What works

- MediaLive emits `EXT-X-PROGRAM-DATE-TIME` (PDT) on the video/audio track —
  configured as `programDateTimeIntervalSeconds: 1` in the CDK origin endpoint.
- MediaPackage V2 preserves PDT and exposes it to CloudFront / players.
- Both subtitle and audio segment durations match the video segment duration
  (both 6 s).

### Known gap — subtitle timestamps are relative, not wall-clock

`LiveWebVtt` stores cue timestamps in **milliseconds since session start**
(e.g. `00:00:12.400`). The VTT HLS playlist does not contain a PDT tag.

When MediaPackage V2 serves the subtitle playlist alongside the video playlist,
a player that supports `EXT-X-PROGRAM-DATE-TIME` correlation (HLS.js, AVPlayer,
ExoPlayer) will try to align subtitle cues to the video timeline using PDT.
Without a matching PDT in the subtitle playlist the player falls back to
sequence-number alignment, which drifts over long streams and breaks after
any reconnection or seek.

### What needs to be implemented to fix this

1. **Record wall-clock epoch at session start** — capture `Date.now()` when
   the first audio chunk arrives from FFmpeg. Every cue's `startMs` is then
   offset from that epoch, giving it an absolute UTC time.

2. **Emit `EXT-X-PROGRAM-DATE-TIME` in `renderPlaylist()`** — the first segment
   in the rolling window gets a PDT header matching the wall-clock time of its
   first cue. Subsequent segments inherit it by incrementing by
   `segmentDurationMs`.

These two changes are isolated to `LiveWebVtt` and `RtmpStreamSession` and do
not affect any other component. They are not yet implemented.

---

## 5. Session REST API

The live-caption-engine exposes a REST API on the ALB. All routes are relative
to `http://<AlbDnsName>`.

### Start a caption session

```
POST /sessions
Content-Type: application/json

{
  "rtmpUrl":          "rtmp://nginx-rtmp.internal/live/primary",
  "languages":        ["de", "fr"],
  "dubbingLanguages": ["de"]
}
```

| Field | Required | Description |
|---|---|---|
| `rtmpUrl` | yes | Any URL FFmpeg can open: `rtmp://`, `rtmps://`, or an HLS `https://` URL |
| `languages` | no | Translation target language codes. Empty = transcription only |
| `dubbingLanguages` | no | Subset of `languages` to also dub audio for |

Response `201`:

```json
{
  "ok": true,
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "endpoints": {
    "captions": "/sessions/<id>/captions/live.vtt",
    "translatedCaptions": [
      { "lang": "de", "url": "/sessions/<id>/captions/de/live.vtt" },
      { "lang": "fr", "url": "/sessions/<id>/captions/fr/live.vtt" }
    ],
    "dub": [
      { "lang": "de", "url": "/sessions/<id>/dub/de/audio.pcm" }
    ]
  }
}
```

### Other session endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/sessions` | List all active sessions |
| `DELETE` | `/sessions/:id` | Stop and tear down a session |
| `GET` | `/sessions/:id/captions/live.vtt` | Rolling source-language WebVTT |
| `GET` | `/sessions/:id/captions/index.m3u8` | Source-language HLS subtitle playlist |
| `GET` | `/sessions/:id/captions/:lang/live.vtt` | Translated WebVTT for `:lang` |
| `GET` | `/sessions/:id/captions/:lang/index.m3u8` | Translated HLS subtitle playlist |
| `GET` | `/sessions/:id/dub/:lang/audio.pcm` | Chunked raw s16le PCM stream |
| `GET` | `/healthz` | `{ ok: true, engine }` |
| `GET` | `/readyz` | `{ ok: true, activeSessions }` |

---

## 6. Step-by-step operational runbook

### Step 1 — Deploy both stacks

```bash
cd deploy/cdk
npm install
npx cdk bootstrap aws://<ACCOUNT>/<REGION>
npx cdk deploy --all
```

Save all the output values — you will need them below.

### Step 2 — Set real API key secrets

```bash
aws secretsmanager put-secret-value \
  --secret-id <SonioxSecretArn> \
  --secret-string '{"value":"sk-your-key"}'

aws secretsmanager put-secret-value \
  --secret-id <GeminiSecretArn> \
  --secret-string '{"value":"AIzaSy-your-key"}'
```

### Step 3 — Build and push the Docker image

```bash
aws ecr get-login-password --region <REGION> | \
  docker login --username AWS --password-stdin <EcrRepositoryUri>

docker build -t live-caption-engine:latest .
docker tag  live-caption-engine:latest <EcrRepositoryUri>:latest
docker push <EcrRepositoryUri>:latest

aws ecs update-service \
  --cluster live-caption-engine \
  --service live-caption-engine \
  --force-new-deployment
```

### Step 4 — Get the RTMP push URL for your encoder

```bash
aws medialive describe-input \
  --input-id <MediaLiveInputId> \
  --query 'Destinations[*].Url' \
  --output text
```

Configure OBS:
- **Server**: everything up to and including the last `/`
- **Stream Key**: the part after the last `/`

### Step 5 — Start the MediaLive channel

MediaLive charges by the hour. Only start it when you are about to stream.

```bash
aws medialive start-channel --channel-id <MediaLiveChannelId>

# Wait ~30 s then confirm it is RUNNING
aws medialive describe-channel \
  --channel-id <MediaLiveChannelId> \
  --query 'State'
```

### Step 6 — Start your encoder

Push RTMP from OBS / FFmpeg to the URL from Step 4.

### Step 7 — Start the caption engine session

If `nginxRtmpUrl` was passed to `MediaStack` during deploy, MediaLive is
already pushing an RTMP tap to that relay. Use the `NginxRtmpTapUrl` CDK
output as the `rtmpUrl`:

```bash
curl -X POST http://<AlbDnsName>/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "rtmpUrl": "<NginxRtmpTapUrl>",
    "languages": ["de", "fr"],
    "dubbingLanguages": ["de"]
  }'
```

If the nginx-rtmp tap is not yet deployed, fall back to one of these options:

- **HLS URL** (works today, ~6–12 s extra latency):
  use `HlsPlaylistUrl` from CDK output as `rtmpUrl`.
- **Direct RTMP** (lower latency): run the encoder dual-push: one to MediaLive,
  one to a URL the engine can connect to.

### Step 8 — Verify playback

```bash
# HLS master playlist in VLC
vlc "<HlsPlaylistUrl>"

# Or check segments are flowing
curl -s "<HlsPlaylistUrl>" | head -20
```

### Step 9 — Stop the session and channel when done

```bash
# Stop the caption session
curl -X DELETE http://<AlbDnsName>/sessions/<sessionId>

# Stop MediaLive (stops billing)
aws medialive stop-channel --channel-id <MediaLiveChannelId>
```

---

## 7. Cost notes

| Service | Billed when | Approx cost |
|---|---|---|
| MediaLive | Channel is RUNNING | ~$0.75–$1.50 / hr (SINGLE_PIPELINE, HD) |
| MediaPackage V2 | Ingested GB + egress GB | ~$0.03 / GB ingested |
| CloudFront | Requests + egress | ~$0.0085 / GB transfer |
| ECS Fargate | Tasks are RUNNING | ~$0.02 / hr (0.5 vCPU / 1 GiB) |
| NAT Gateway | Data processed | ~$0.045 / GB |

Stop the MediaLive channel (`aws medialive stop-channel`) whenever you are not
actively streaming — it is the largest cost driver.

---

## 8. Known limitations and future work

| Item | Status |
|---|---|
| nginx-rtmp VPC relay (Option C second output group) | Pass `nginxRtmpUrl` prop to `MediaStack` |
| `EXT-X-PROGRAM-DATE-TIME` in subtitle playlists | Not yet implemented |
| Wall-clock epoch alignment in `LiveWebVtt` | Not yet implemented |
| HTTPS listener on ALB (ACM certificate) | Not yet in CDK |
| Per-session IAM scoping for MediaPackage PUT | Currently `*` resource |
| MediaLive input security group locked to encoder IP | Defaults to `0.0.0.0/0` — tighten in production |

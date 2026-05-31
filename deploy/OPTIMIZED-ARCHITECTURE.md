# Architecture

Two workflows are documented here:

1. **Current** — ECS serves tracks locally, a manifest proxy stitches them into the MediaPackage master manifest.
2. **Target** — ECS pushes all tracks directly to MediaPackage V2 ingest; the player talks to a single CloudFront origin with no proxy hop.

---

# Current Architecture — ECS as RTMP Entry Point (deployed)

`NginxRtmpStack` EC2 relay is **removed**.
MediaLive uses `RTMP_PUSH` input — ECS relays the stream via ffmpeg.
Auto-session trigger uses the native NMS `prePublish` event — no HTTP callback needed.
Captions and dubbed audio are served as HLS directly from ECS; a manifest proxy stitches
them into the MediaPackage master manifest so the player sees a single playable URL.

## Current deployed state

| Component | Value |
|---|---|
| ECS service | `live-caption-engine` |
| ECS task definition | `live-caption-engine:23` |
| MediaLive input ID | `9787399` (RTMP_PUSH) |
| MediaPackage origin | `https://p01vso.egress.ahg76l.mediapackagev2.eu-central-1.amazonaws.com/out/v1/live-caption/main/hls` |
| MediaPackage ingest | `https://p01vso-1.ingest.ahg76l.mediapackagev2.eu-central-1.amazonaws.com/in/v1/live-caption/1/main/index` |
| Player master manifest | `http://<ALB>/sessions/<sessionId>/manifest/master.m3u8` |
| Dubbing in production | disabled (`DUBBING_ENABLED=false`) — enable per session via `dubbingLanguages` in API |
| CloudFront | not in front of MediaPackage yet (direct egress URL) |

## Diagram

```mermaid
flowchart TD
    ENC([Encoder\nOBS / ffmpeg])

    subgraph AWS
        NLB[Network Load Balancer\nTCP :1935]
        ALB[Application Load Balancer\nHTTP :80]

        subgraph ECS["ECS — live-caption-engine"]
            NMS[NodeMediaServer\n:1935]
            ASM[AutoSessionManager\nprePublish → auto-start]
            SESSION[RtmpStreamSession\nloopback RTMP pull\nrtmp://127.0.0.1:1935/...]
            RELAY[ffmpeg relay\nrtmpUrl → MediaLive push URL]
            CAPTIONS[LiveWebVtt\nVTT segments served\n/sessions/:id/captions/...]
            DUBBING[AudioHlsPublisher\nAAC+TS segments served\n/sessions/:id/dub/...]
            PROXY[Manifest Proxy\npatches MP master manifest\n/sessions/:id/manifest/master.m3u8]
        end

        subgraph MEDIA["Media pipeline"]
            ML[MediaLive\nRTMP_PUSH input\ninputId=9787399]
            MP[MediaPackage V2\negress HLS]
        end
    end

    PLAYER([Player])

    ENC -->|RTMP push :1935| NLB
    NLB -->|TCP passthrough| NMS

    NMS -->|prePublish event| ASM
    ASM -->|startSession loopback URL| SESSION
    SESSION -->|reads audio via loopback| NMS

    SESSION -->|audio PCM| RELAY
    RELAY -->|RTMP push\nDescribeInput at startup| ML

    SESSION -->|final-caption events| CAPTIONS
    SESSION -->|audio PCM| DUBBING

    ML -->|HLS segments\nvideo + source audio| MP

    PLAYER -->|GET master.m3u8| ALB
    ALB --> PROXY
    PROXY -->|fetches upstream| MP
    PROXY -->|injects EXT-X-MEDIA audio group\n+ subtitle group| PLAYER

    PLAYER -->|GET audio*.m3u8 + seg*.ts| ALB
    ALB --> DUBBING

    PLAYER -->|GET captions/*.m3u8 + *.vtt| ALB
    ALB --> CAPTIONS
```

## Track assembly in the master manifest

The manifest proxy (`/sessions/:id/manifest/master.m3u8`) fetches the raw MediaPackage
master manifest and injects:

```
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="dub-audio",NAME="Original",LANGUAGE="src",DEFAULT=YES,URI="<ALB>/sessions/:id/dub/src/audio.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="dub-audio",NAME="Dub en",LANGUAGE="en",DEFAULT=NO,URI="<ALB>/sessions/:id/dub/en/audio.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Source",LANGUAGE="src",URI="<ALB>/sessions/:id/captions/index.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="en",LANGUAGE="en",URI="<ALB>/sessions/:id/captions/en/index.m3u8"
...
#EXT-X-STREAM-INF:...,AUDIO="dub-audio",SUBTITLES="subs"
<MediaPackage video variant URL>
```

The player switches audio tracks and subtitle tracks entirely within a single manifest URL.

## Key design decisions

| Decision | Reason |
|---|---|
| ECS serves audio/subtitle HLS locally | No dependency on MediaPackage track ingest; works with standard MP V2 HLS endpoint |
| Manifest proxy stitches tracks | Single playable URL for the player regardless of how many languages are active |
| ffmpeg relay to MediaLive | ECS gets the stream first (for transcription), then pushes a copy to MediaLive for packaging |
| NMS loopback RTMP pull | Session reads audio from the same NMS that received the encoder push; no separate RTMP pull source needed |
| `MEDIALIVE_INPUT_ID` env var | ECS calls `DescribeInput` at startup to resolve the push URL dynamically — survives IP changes |

## SINGLE_PIPELINE (default) vs STANDARD channel class

For `SINGLE_PIPELINE` (default, cheaper): one NLB + one ECS task handles everything.

For `STANDARD` (dual-pipeline, HA), two redundant ECS tasks each relay to one MediaLive pipeline:

```mermaid
flowchart TD
    ENC_A([Encoder A\nprimary])
    ENC_B([Encoder B\nbackup])

    NLB_A[NLB A\nTCP :1935]
    NLB_B[NLB B\nTCP :1936]

    subgraph ECS_A["ECS Task A"]
        direction TB
        NMS_A[NMS :1935] --> SESSION_A[RtmpStreamSession]
        NMS_A --> RELAY_A[ffmpeg relay]
    end

    subgraph ECS_B["ECS Task B"]
        direction TB
        NMS_B[NMS :1935] --> SESSION_B[RtmpStreamSession]
        NMS_B --> RELAY_B[ffmpeg relay]
    end

    ML[MediaLive STANDARD\n2-pipeline RTMP_PUSH]
    MP[MediaPackage V2]

    ENC_A --> NLB_A --> NMS_A
    ENC_B --> NLB_B --> NMS_B

    RELAY_A -->|pipeline 0| ML
    RELAY_B -->|pipeline 1| ML

    SESSION_A -->|captions + audio HLS| MP
    SESSION_B -->|captions + audio HLS| MP
    ML --> MP
```

Deploy with: `npx cdk deploy --all -c channelClass=STANDARD`

---

# Target Architecture — All Tracks via MediaPackage V2 Ingest

ECS pushes every generated track (captions, dubbed audio) directly to MediaPackage V2
over HTTP PUT — the same ingest endpoint MediaLive already uses for video.
MediaPackage assembles a single complete manifest served via CloudFront.
The ALB manifest proxy endpoint is **removed** from the player path entirely.

## Diagram

```mermaid
flowchart TD
    ENC([Encoder\nOBS / ffmpeg])

    subgraph AWS
        NLB[Network Load Balancer\nTCP :1935]

        subgraph ECS["ECS — live-caption-engine"]
            NMS[NodeMediaServer\n:1935]
            ASM[AutoSessionManager\nprePublish → auto-start]
            SESSION[RtmpStreamSession\nloopback RTMP pull]
            RELAY[ffmpeg relay → MediaLive RTMP_PUSH]
            CAPTIONS[LiveWebVtt\ngenerate .vtt segments]
            DUBBING[AudioHlsPublisher\ngenerate .aac/.ts segments]
            PUSHER[MediaPackageIngestPusher\nHTTP PUT segments → MPv2 ingest]
        end

        subgraph MEDIA["Media pipeline"]
            ML[MediaLive\nRTMP_PUSH input]
            MP[MediaPackage V2\nmulti-track ingest\nvideo + audio renditions + WebVTT]
            CF[CloudFront\nHTTPS CDN]
        end
    end

    PLAYER([Player])

    ENC -->|RTMP push :1935| NLB
    NLB -->|TCP passthrough| NMS

    NMS -->|prePublish event| ASM
    ASM -->|startSession loopback URL| SESSION
    SESSION -->|reads audio via loopback| NMS

    SESSION -->|audio PCM| RELAY
    RELAY -->|RTMP push| ML

    SESSION -->|final-caption events| CAPTIONS
    SESSION -->|audio PCM| DUBBING

    CAPTIONS -->|.vtt segments + playlist| PUSHER
    DUBBING -->|.aac segments + playlist| PUSHER

    PUSHER -->|PUT /in/v1/.../captions-{lang}/seg-N.vtt| MP
    PUSHER -->|PUT /in/v1/.../dub-{lang}/seg-N.aac| MP

    ML -->|HLS segments\nvideo + source audio| MP

    MP -->|assembles complete master manifest\nvideo + all audio renditions + subtitles| CF
    CF -->|single HLS master\nno proxy hop| PLAYER
```

## Ingest path layout

Each track type gets its own named ingest sub-path inside the MediaPackage channel:

| Track | PUT path pattern |
|---|---|
| Video + source audio | `index` (pushed by MediaLive — unchanged) |
| Source captions (WebVTT) | `captions-src` |
| Translated captions — e.g. `en` | `captions-en` |
| Original audio rendition (AAC HLS) | `dub-src` |
| Dubbed audio — e.g. `en` | `dub-en` |

Full ingest base URL (current account):
```
https://p01vso-1.ingest.ahg76l.mediapackagev2.eu-central-1.amazonaws.com/in/v1/live-caption/1/main/<track-name>/
```

## Segment timing alignment requirement

This is the key constraint that does not exist in the current proxy approach:

- Audio TS segments pushed to MediaPackage **must share segment boundaries** with the
  MediaLive video segments (same `EXT-X-TARGETDURATION`, same `EXT-X-MEDIA-SEQUENCE` numbering).
- `AudioHlsPublisher` needs to be driven by MediaLive segment clock, not by its own
  FFmpeg internal clock. Concretely: segment cuts happen when MediaLive cuts them, so
  FFmpeg must use `-segment_time` aligned to `CAPTIONS_SEGMENT_DURATION_MS` (currently 6 s)
  and the sequence counter must match.
- WebVTT is self-timestamped (cue start/end) so it is tolerant of minor sequence skew,
  but segment file intervals should still match.

## What changes in code

| Component | Current | Target |
|---|---|---|
| `AudioHlsPublisher` | writes segments to local `/tmp`, serves via Express | additionally PUT each segment + playlist to MPv2 ingest after writing |
| `LiveWebVtt` | serves `.vtt` segments via Express routes | additionally PUT each segment + playlist to MPv2 ingest |
| `src/index.js` | starts manifest proxy route | manifest proxy route removed or kept as fallback only |
| `manifest-proxy.js` | patches MP master manifest on every player request | no longer in the player hot path |
| New: `MediaPackageIngestPusher` | — | thin HTTP client that PUTs a file path or buffer to a given MPv2 ingest URL, with retry |

## What changes in CDK / infra

- MediaPackage V2 `OriginEndpoint` needs `hlsManifests` configured with WebVTT subtitle
  rendition group and audio rendition group declarations matching the ingest track names.
- ECS task role already has `mediapackagev2:PutObject` — no IAM change needed.
- `MEDIAPACKAGE_INGEST_URL` already injected into the container — no env change needed.
- ALB listener on port 80 can stay for the session API; manifest proxy route optional.
- CloudFront distribution in front of MediaPackage egress should be enabled so
  the player URL is stable and CDN-cached.

## What stays the same

- RTMP ingest flow (NLB → NMS → auto-session → relay → MediaLive) — no change
- Transcription and dubbing engine pipeline — no change
- Session lifecycle API (`POST /sessions`, `DELETE /sessions/:id`) — no change
- `MEDIALIVE_INPUT_ID` DescribeInput startup resolution — no change

## Comparison

| | Current (proxy) | Target (direct ingest) |
|---|---|---|
| Player origin | ALB (manifest) + MediaPackage (video) | CloudFront only |
| Track latency to player | real-time from ECS memory | one segment delay (push → MPv2 → CDN) |
| ECS restart impact | live captions/audio drop immediately | already-pushed segments remain in MPv2 |
| Segment alignment | not required (manifest stitching) | required for audio; tolerant for WebVTT |
| CloudFront needed | optional | recommended (stable URL + caching) |
| ALB in player path | yes (every segment request) | no (API only) |
| Engineering lift | done | `MediaPackageIngestPusher` + alignment logic |

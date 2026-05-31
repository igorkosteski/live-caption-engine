# Optimized Architecture — ECS as RTMP Entry Point

Eliminates the `NginxRtmpStack` EC2 relay entirely.
MediaLive switches from `RTMP_PULL` to `RTMP_PUSH` (its native/recommended input type).
Auto-session trigger is identical to local — no HTTP callback hack needed.

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
            RELAY[ffmpeg relay\nre-push to MediaLive]
        end

        subgraph MEDIA["Media pipeline"]
            ML[MediaLive\nRTMP_PUSH input]
            MP[MediaPackage V2\nmulti-track ingest]
            CF[CloudFront]
        end
    end

    PLAYER([Player])

    ENC -->|RTMP push| NLB
    NLB -->|TCP passthrough :1935| NMS

    NMS -->|prePublish event| ASM
    ASM -->|startSession| SESSION
    SESSION -->|loopback RTMP pull\nrtmp://127.0.0.1:1935/...| NMS

    NMS -->|stream passthrough| RELAY
    RELAY -->|RTMP push| ML

    SESSION -->|PUT WebVTT segments| MP
    SESSION -->|PUT dubbed AAC segments| MP
    ML -->|HLS ingest\nvideo + source audio| MP

    MP --> CF
    CF -->|HLS master\nvideo + all audio tracks + captions| PLAYER
```

## What changes vs current

| | Current | This |
|---|---|---|
| `NginxRtmpStack` EC2 | Required | **Removed** |
| MediaLive input type | `RTMP_PULL` | `RTMP_PUSH` |
| Auto-session trigger | nginx `on_publish` HTTP callback (not built) | Native `prePublish` event |
| Matches local dev flow | No | **Yes, exactly** |
| Entry point infra | EC2 + EIP | NLB (TCP) |

## STANDARD channel class (dual pipeline)

For `STANDARD` MediaLive class two redundant pipelines are needed.
Each pipeline expects its own RTMP push stream.

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

    SESSION_A --> MP
    SESSION_B --> MP
    ML --> MP
```

For `SINGLE_PIPELINE` (default, cheaper) only Task A / NLB A is needed.

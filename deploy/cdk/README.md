# Live Caption Engine — CDK Deployment

AWS CDK v2 (TypeScript) that provisions the full live captioning pipeline:

```
Encoder (OBS/FFMPEG)
  │  RTMP push (:1935)
  ▼
NLB "live-caption-rtmp" ──► ECS Fargate (node-media-server)
                              ├── ffmpeg relay ──► MediaLive (RTMP_PUSH) ──► MediaPackage V2 "raw" channel
                              │                                                       │
                              │                                          SegmentAssembler polls raw HLS
                              │                                                       ▼
                              └── Session API (ALB :80) ◄──────────────  pushes video + VTT captions +
                                                                          dubbed audio tracks to
                                                                          MediaPackage V2 "output" channel
                                                                                     │
                                                                                     ▼
                                                                         Players (output channel egress)
```

A caption session auto-starts as soon as the encoder publishes to the RTMP NLB — no API call is
required for the default workflow. `POST /sessions` remains available for pulling from an external
`rtmpUrl` instead of pushing directly.

## Stacks

Only two stacks are actually wired up in [`bin/app.ts`](./bin/app.ts):

| Stack | Description |
|---|---|
| `LiveCaptionMedia` | MediaLive channel (RTMP_PUSH) + two MediaPackage V2 channel groups (raw + output) |
| `LiveCaptionEngine` | ECR repo + ECS Fargate service (RTMP ingest + HTTP API) + ALB + NLB + Secrets Manager + IAM |

> **Note:** [`lib/nginx-rtmp-stack.ts`](./lib/nginx-rtmp-stack.ts) still exists in this directory but is
> **not instantiated** by `bin/app.ts` — it's leftover from an earlier architecture where an EC2
> nginx-rtmp relay pulled into MediaLive. The current pipeline has ECS's own `node-media-server`
> receive the RTMP push and relay to MediaLive directly, so this file is dead code. Delete it or wire
> it back in deliberately if you still need it.

---

## Prerequisites

| Tool | Min version | Install |
|---|---|---|
| Node.js | 20 | https://nodejs.org |
| AWS CDK CLI | 2.x | `npm i -g aws-cdk` |
| AWS CLI | 2.x | https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html |
| Docker | any | https://docs.docker.com/get-docker/ |

Configure AWS credentials before running any CDK command:

```bash
aws configure           # or export AWS_PROFILE=my-profile
aws sts get-caller-identity   # verify
```

---

## 1. Install dependencies

```bash
cd deploy/cdk
npm install
```

---

## 2. Bootstrap (once per account/region)

CDK bootstrap creates an S3 bucket and IAM roles used internally by CDK.
Only needs to be run once per AWS account + region pair.

```bash
npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>
# e.g.
npx cdk bootstrap aws://123456789012/us-east-1
```

---

## 3. Deploy

### Deploy all stacks (recommended)

```bash
npx cdk deploy --all
```

CDK deploys stacks in dependency order:
1. `LiveCaptionMedia`
2. `LiveCaptionEngine` (depends on `LiveCaptionMedia` for the MediaPackage ingest/egress URLs)

### Deploy a single stack

```bash
npx cdk deploy LiveCaptionMedia    # media pipeline only
npx cdk deploy LiveCaptionEngine   # ECS service only
```

### Preview changes without deploying

```bash
npx cdk diff --all
```

---

## 4. Context flags

Pass any of these with `-c key=value` to override defaults without editing code.

| Flag | Default | Description |
|---|---|---|
| `engine` | `soniox` | Transcription engine: `soniox` or `gemini` |
| `channelClass` | `SINGLE_PIPELINE` | MediaLive pipeline redundancy: `STANDARD` (2 pipelines, HA) or `SINGLE_PIPELINE` |
| `dubbingPollyEnabled` | `false` | Add `polly:SynthesizeSpeech` to the ECS task role |
| `vpcId` | _(create new)_ | Import an existing VPC by ID instead of creating one |
| `repositoryName` | _(create new)_ | Import an existing ECR repository by name instead of creating one |

Examples:

```bash
# Use Gemini engine + dual MediaLive pipelines
npx cdk deploy --all -c engine=gemini -c channelClass=STANDARD

# Enable Polly dubbing
npx cdk deploy LiveCaptionEngine -c dubbingPollyEnabled=true

# Reuse existing VPC
npx cdk deploy --all -c vpcId=vpc-0abc123def456
```

---

## 5. Post-deploy steps

After `cdk deploy --all` finishes, the CLI prints stack outputs.
Work through them in order:

### 5a. Set API key secrets

The deploy creates placeholder secrets. Replace them with real values:

```bash
# Soniox (always required when ENGINE=soniox)
aws secretsmanager put-secret-value \
  --secret-id <SonioxSecretArn from output> \
  --secret-string '{"value":"sk-your-soniox-key"}'

# Gemini (required when ENGINE=gemini or DUBBING_ENGINE=gemini)
aws secretsmanager put-secret-value \
  --secret-id <GeminiSecretArn from output> \
  --secret-string '{"value":"AIzaSy-your-gemini-key"}'
```

The ECS task will automatically pick up the new values on the next deployment
or task restart.  Force a fresh deployment immediately:

```bash
aws ecs update-service \
  --cluster live-caption-engine \
  --service live-caption-engine \
  --force-new-deployment
```

### 5b. Push the Docker image to ECR

```bash
# Authenticate Docker to ECR
aws ecr get-login-password --region <REGION> | \
  docker login --username AWS --password-stdin <EcrRepositoryUri from output>

# Build and push from the project root
docker build -t live-caption-engine:latest .
docker tag  live-caption-engine:latest <EcrRepositoryUri>:latest
docker push <EcrRepositoryUri>:latest
```

After pushing, force a new ECS deployment so Fargate pulls the new image:

```bash
aws ecs update-service \
  --cluster live-caption-engine \
  --service live-caption-engine \
  --force-new-deployment
```

### 5c. Get the RTMP push URL for your encoder

```bash
# Use the LiveCaptionEngine stack output:
#   RtmpNlbDnsName = live-caption-rtmp-xxxxxxxx.elb.<region>.amazonaws.com
```

Configure OBS (or any RTMP encoder) to push directly to the NLB in front of ECS's own
`node-media-server`:
- **Server**: `rtmp://<RtmpNlbDnsName>:1935/live`
- **Stream Key**: any value, e.g. `primary`

MediaLive is configured as `RTMP_PUSH`. ECS discovers MediaLive's actual push endpoint at runtime
via `medialive:DescribeInput` and relays the incoming stream to it with an internal ffmpeg process
— the encoder never talks to MediaLive directly.

As soon as the encoder starts publishing, a caption session **auto-starts** (see
`src/rtmp-auto-session.js`) — no `POST /sessions` call is required for this workflow. Stopping the
encoder stream automatically tears the session down.

### 5d. Start the MediaLive channel

MediaLive channels are **not** started automatically (they incur cost while running).

```bash
aws medialive start-channel \
  --channel-id <MediaLiveChannelId from output>
```

Wait ~30 seconds, then check the state:

```bash
aws medialive describe-channel \
  --channel-id <MediaLiveChannelId from output> \
  --query 'State'
```

### 5e. Verify playback

Two MediaPackage V2 channels exist — always play from the **output** channel, which is where ECS's
`SegmentAssembler` pushes the fully assembled video + captions + dubbed-audio tracks:

```bash
# Media stack output: MediaPackageOutputOriginUrl (base URL, player-facing).
curl -s "<MediaPackageOutputOriginUrl from output>/index.m3u8" | head -20

# Optional: play in VLC
vlc "<MediaPackageOutputOriginUrl from output>/index.m3u8"
```

`MediaPackageOriginUrl` (the **raw** channel fed directly by MediaLive — video + source audio only,
no captions/dubbing) is only useful for isolating MediaLive-side issues; it's not the player-facing URL.

### 5f. (Optional) Start a caption session manually

Only needed if you want to pull from an external `rtmpUrl` instead of pushing to the RTMP NLB
(step 5c already auto-starts a session on publish). The ECS service exposes a REST API on the ALB.
Use the `AlbDnsName` output:

```bash
BASE=http://<AlbDnsName from output>

# Start captioning. rtmpUrl is optional when RTMP_URL is set from CDK default wiring.
curl -s -X POST "$BASE/sessions" \
  -H "Content-Type: application/json" \
  -d '{
    "languages": ["de", "fr"],
    "dubbingLanguages": ["de"]
  }' | jq .

# List active sessions
curl -s "$BASE/sessions" | jq .

# Stop a session
curl -s -X DELETE "$BASE/sessions/<sessionId>"

# Fetch patched master manifest with subtitle/audio groups for this session
curl -s "$BASE/sessions/<sessionId>/manifest/master.m3u8" | head -40
```

The response from `POST /sessions` includes per-session VTT and PCM endpoints:

```json
{
  "ok": true,
  "sessionId": "uuid",
  "endpoints": {
    "captions": "/sessions/uuid/captions/live.vtt",
    "translatedCaptions": [
      { "lang": "de", "url": "/sessions/uuid/captions/de/live.vtt" },
      { "lang": "fr", "url": "/sessions/uuid/captions/fr/live.vtt" }
    ],
    "dub": [
      { "lang": "de", "url": "/sessions/uuid/dub/de/audio.pcm" }
    ]
  }
}
```

---

## 6. Architecture details

### LiveCaptionMedia stack

**Raw channel** (`live-caption` / `main`) — receives HLS directly from MediaLive:

| Resource | Details |
|---|---|
| `MediaPackageV2::ChannelGroup` | Group name `live-caption` |
| `MediaPackageV2::Channel` | Channel `main`; two ingest endpoints for pipeline redundancy |
| `MediaPackageV2::OriginEndpoint` | HLS, 6 s segments, 60 s manifest window, 2 h DVR startover |
| `MediaPackageV2::OriginEndpointPolicy` | Allows anonymous `mediapackagev2:GetObject` (open policy) |
| `MediaPackageV2::ChannelPolicy` | Allows `mediapackagev2:PutObject` scoped to the MediaLive role |

**Output channel** (`live-caption-output` / `main`) — player-facing; ECS's `SegmentAssembler`
pushes assembled video + WebVTT caption tracks + dubbed audio tracks here:

| Resource | Details |
|---|---|
| `MediaPackageV2::ChannelGroup` | Group name `live-caption-output` |
| `MediaPackageV2::Channel` | Channel `main` |
| `MediaPackageV2::OriginEndpoint` | Same HLS/segment/manifest settings as the raw channel |
| `MediaPackageV2::OriginEndpointPolicy` | Allows anonymous `mediapackagev2:GetObject` (open policy) |
| `MediaPackageV2::ChannelPolicy` | Allows `mediapackagev2:PutObject` scoped to the ECS task role |

**MediaLive:**

| Resource | Details |
|---|---|
| `MediaLive::Input` | `RTMP_PUSH`; ECS discovers the push endpoint at runtime via `DescribeInput` |
| `MediaLive::Channel` | H.264 720p 3 Mbps + AAC 192 kbps → HLS → MediaPackage V2 (raw channel) |
| `IAM::Role` | MediaLive role: `mediapackagev2:PutObject` (raw channel only) + CloudWatch logs |

Note: CloudFront resources (OAC + distribution + endpoint policy) are fully commented out in
`media-stack.ts` — no CloudFront distribution is currently deployed; playback goes straight to the
MediaPackage V2 output channel egress URL.

### LiveCaptionEngine stack

| Resource | Details |
|---|---|
| `ECR::Repository` | `live-caption-engine`; scan on push; 10-image lifecycle (or imported via `repositoryName`) |
| `EC2::Vpc` | 2 AZs, public + private subnets, 1 NAT gateway (or imported via `vpcId`) |
| `ECS::Cluster` | Container Insights V2 enabled |
| `ECS::FargateService` | 0.5 vCPU / 1 GiB; min 1 / max 10 tasks; circuit breaker + rollback |
| `ApplicationAutoScaling` | Scale on CPU > 60 % and memory > 70 % |
| `ElasticLoadBalancingV2::ALB` | Internet-facing, port 80; sticky sessions (1 h) for long-lived PCM/VTT streams; targets container port 8080 |
| `ElasticLoadBalancingV2::NLB` | Internet-facing, port 1935; forwards RTMP push traffic to the container's `node-media-server` |
| `SecretsManager::Secret` | `soniox-api-key` + `gemini-api-key` injected as env vars |
| `IAM::Role` (execution) | Pulls from ECR; reads secrets |
| `IAM::Role` (task) | `polly:SynthesizeSpeech` (optional); `mediapackagev2:PutObject` (both raw + output channels); `medialive:DescribeInput` |
| `Logs::LogGroup` | `/ecs/live-caption-engine`; 30-day retention |

---

## 7. Updating the ECS service

Any change to `live-caption-stack.ts` or `media-stack.ts` can be applied with:

```bash
npx cdk deploy --all
```

To deploy only when the diff is non-destructive:

```bash
npx cdk diff --all && npx cdk deploy --all
```

---

## 8. Stopping the MediaLive channel

MediaLive charges by the hour while running. Stop when not streaming:

```bash
aws medialive stop-channel \
  --channel-id <MediaLiveChannelId>
```

---

## 9. Teardown

```bash
# Stop all ECS tasks first (avoids dangling connections)
aws ecs update-service \
  --cluster live-caption-engine \
  --service live-caption-engine \
  --desired-count 0

# Stop MediaLive channel
aws medialive stop-channel --channel-id <MediaLiveChannelId>

# Destroy all CDK stacks
# Note: the ECR repository has RemovalPolicy=RETAIN — delete images manually first
#   aws ecr batch-delete-image --repository-name live-caption-engine --image-ids imageTag=latest
npx cdk destroy --all
```

---

## 10. Project layout

```
deploy/cdk/
├── bin/
│   └── app.ts                  ← CDK app entrypoint + context flags (instantiates 2 stacks)
├── lib/
│   ├── live-caption-stack.ts   ← ECS (RTMP ingest + HTTP API) + ALB + NLB + ECR + Secrets stack
│   ├── media-stack.ts          ← MediaLive + MediaPackage V2 (raw + output channels) stack
│   └── nginx-rtmp-stack.ts     ← NOT wired into bin/app.ts — orphaned from an earlier architecture
├── cdk.json                    ← CDK toolkit config
├── package.json
├── tsconfig.json
└── README.md                   ← this file
```

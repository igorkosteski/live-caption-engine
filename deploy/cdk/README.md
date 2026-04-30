# Live Caption Engine — CDK Deployment

AWS CDK v2 (TypeScript) that provisions the full live captioning pipeline:

```
Encoder (OBS/FFMPEG)
  │  RTMP push
  ▼
AWS MediaLive  ──── HLS segments ────►  AWS MediaPackage V2  ──── CloudFront ────►  Viewers
                                               ▲
                         live-caption-engine (ECS Fargate)
                         pushes .vtt subtitles + .aac dubbed audio
```

## Stacks

| Stack | Description |
|---|---|
| `LiveCaptionMedia` | MediaLive channel + MediaPackage V2 channel group + CloudFront distribution |
| `LiveCaptionEngine` | ECR repo + ECS Fargate service + ALB + Secrets Manager + IAM |

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

### Deploy both stacks (recommended)

```bash
npx cdk deploy --all
```

CDK always deploys `LiveCaptionMedia` first (the ECS stack depends on the
MediaPackage ingest URL output from the media stack).

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
aws medialive describe-input \
  --input-id <MediaLiveInputId from output> \
  --query 'Destinations[*].Url' \
  --output text
```

Configure OBS (or any RTMP encoder):
- **Server**: the URL up to and including the last `/`
  e.g. `rtmp://...medialive.amazonaws.com:1935/live/`
- **Stream Key**: the part after the last `/`
  e.g. `primary`

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

```bash
# HLS master playlist URL is printed as output HlsPlaylistUrl
# Open in VLC:
vlc "<HlsPlaylistUrl from output>"

# Or curl the manifest to confirm segments are flowing:
curl -s "<HlsPlaylistUrl>" | head -20
```

### 5f. Start a caption session

The ECS service exposes a REST API on the ALB. Use the `AlbDnsName` output:

```bash
BASE=http://<AlbDnsName from output>

# Start captioning for a stream (rtmpUrl must match what the encoder is pushing)
curl -s -X POST "$BASE/sessions" \
  -H "Content-Type: application/json" \
  -d '{
    "rtmpUrl": "rtmp://...",
    "languages": ["de", "fr"],
    "dubbingLanguages": ["de"]
  }' | jq .

# List active sessions
curl -s "$BASE/sessions" | jq .

# Stop a session
curl -s -X DELETE "$BASE/sessions/<sessionId>"
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

| Resource | Details |
|---|---|
| `MediaPackageV2::ChannelGroup` | Group name `live-caption` |
| `MediaPackageV2::Channel` | Channel `main`; two ingest endpoints for pipeline redundancy |
| `MediaPackageV2::OriginEndpoint` | HLS, 6 s segments, 60 s manifest window, 2 h DVR startover |
| `MediaPackageV2::OriginEndpointPolicy` | Allows CloudFront OAC `mediapackagev2:GetObject` |
| `MediaLive::Input` | RTMP_PUSH; whitelist via `rtmpAllowedCidrs` context flag |
| `MediaLive::Channel` | H.264 720p 3 Mbps + AAC 192 kbps → HLS → MediaPackage V2 |
| `CloudFront::OriginAccessControl` | SigV4 signed requests to MediaPackage V2 |
| `CloudFront::Distribution` | HTTPS CDN; HTTP/2+3; Price Class 100 |
| `IAM::Role` | MediaLive role: `mediapackagev2:PutObject` + CloudWatch logs |

### LiveCaptionEngine stack

| Resource | Details |
|---|---|
| `ECR::Repository` | `live-caption-engine`; scan on push; 10-image lifecycle |
| `EC2::Vpc` | 2 AZs, public + private subnets, 1 NAT gateway (or imported via `vpcId`) |
| `ECS::Cluster` | Container Insights V2 enabled |
| `ECS::FargateService` | 0.5 vCPU / 1 GiB; min 1 / max 10 tasks; circuit breaker + rollback |
| `ApplicationAutoScaling` | Scale on CPU > 60 % and memory > 70 % |
| `ElasticLoadBalancingV2::ALB` | Internet-facing; sticky sessions (1 h) for long-lived PCM streams |
| `SecretsManager::Secret` | `soniox-api-key` + `gemini-api-key` injected as env vars |
| `IAM::Role` (execution) | Pulls from ECR; reads secrets |
| `IAM::Role` (task) | `polly:SynthesizeSpeech` (optional); `mediapackagev2:PutObject` |
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
│   └── app.ts                  ← CDK app entrypoint + context flags
├── lib/
│   ├── live-caption-stack.ts   ← ECS + ALB + ECR + Secrets stack
│   └── media-stack.ts          ← MediaLive + MediaPackage V2 + CloudFront stack
├── cdk.json                    ← CDK toolkit config
├── package.json
├── tsconfig.json
└── README.md                   ← this file
```

# Live Caption Engine - End-to-End Workflow

This document reflects the current deployment and runtime flow.

## 1. Current architecture

1. Your encoder pushes RTMP to nginx-rtmp (EC2, public EIP).
2. MediaLive uses RTMP_PULL to read from nginx-rtmp.
3. MediaLive outputs HLS to MediaPackage V2 ingest.
4. live-caption-engine runs on ECS Fargate and pulls audio from RTMP.
5. live-caption-engine sends subtitles and dubbed audio to MediaPackage V2 ingest.
6. Viewers play from MediaPackage/CloudFront.

## 2. CDK stacks and responsibilities

### LiveCaptionNginxRtmp

Creates an EC2 relay with nginx-rtmp.

Outputs:
- NginxRtmpPublicIp
- NginxRtmpUrl
- SsmConnectCommand

### LiveCaptionMedia

Creates MediaLive + MediaPackage V2 resources.

Important current behavior:
- MediaLive input is RTMP_PULL.
- MediaLive pulls from nginxRtmpBaseUrl/nginxRtmpStreamName.
- MediaLive has a single output destination/group to MediaPackage V2 (no second RTMP output destination).

Outputs:
- MediaPackageIngestUrl
- MediaLiveChannelId
- MediaLiveInputId
- MediaLiveInputArn
- NginxRtmpTapUrl (the RTMP URL MediaLive pulls from)

### LiveCaptionEngine

Creates ECS Fargate service + ALB for the caption engine API.

Important current behavior:
- defaultRtmpUrl is wired from LiveCaptionMedia.nginxRtmpTapUrl.
- RTMP_URL is injected into the container environment from that value.
- POST /sessions can omit rtmpUrl and will use RTMP_URL.

Outputs:
- AlbDnsName
- EcrRepositoryUri
- SonioxSecretArn
- GeminiSecretArn
- EcsClusterName
- EcsServiceName

## 3. Runtime API behavior

### Start session

Endpoint:
- POST /sessions

Request body:
- rtmpUrl: optional
- languages: optional string[]
- dubbingLanguages: optional string[]

Behavior:
- If rtmpUrl is provided, that URL is used.
- If rtmpUrl is omitted, service falls back to RTMP_URL (already wired from NginxRtmpTapUrl in CDK).
- If neither exists, request fails with 400.

## 4. Operational runbook

### Step 1 - Deploy infrastructure

```bash
cd deploy/cdk
npm install
npx cdk bootstrap aws://<ACCOUNT>/<REGION>
npx cdk deploy --all
```

### Step 2 - Set API keys

```bash
aws secretsmanager put-secret-value \
  --secret-id <SonioxSecretArn> \
  --secret-string '{"value":"sk-your-key"}'

aws secretsmanager put-secret-value \
  --secret-id <GeminiSecretArn> \
  --secret-string '{"value":"AIzaSy-your-key"}'
```

### Step 3 - Build and push app image

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

### Step 4 - Start MediaLive channel

```bash
aws medialive start-channel --channel-id <MediaLiveChannelId>

aws medialive describe-channel \
  --channel-id <MediaLiveChannelId> \
  --query 'State'
```

### Step 5 - Start your encoder to nginx-rtmp

Push your encoder stream to NginxRtmpUrl from stack output.

Example URL format:
- rtmp://<NginxRtmpPublicIp>:1935/live/primary

### Step 6 - Start caption session

You can now start a session without rtmpUrl, because default RTMP_URL is already wired from CDK.

```bash
curl -X POST http://<AlbDnsName>/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "languages": ["de", "fr"],
    "dubbingLanguages": ["de"]
  }'
```

If you need to override per session, provide rtmpUrl explicitly.

### Step 7 - Stop session and channel

```bash
curl -X DELETE http://<AlbDnsName>/sessions/<sessionId>

aws medialive stop-channel --channel-id <MediaLiveChannelId>
```

## 5. Notes

- MediaLiveInputId is now useful for operational inspection, not for obtaining encoder push URLs.
- The encoder should push to nginx-rtmp, not directly to MediaLive.
- No second MediaLive RTMP output destination is configured anymore.

## 6. Manifest merging and captions

- MediaLive sends video/audio (HLS) to MediaPackage V2 ingest endpoint.
- live-caption-engine uploads WebVTT caption segments and a subtitle playlist (subs.m3u8) to the same MediaPackage V2 endpoint under the /subtitles/ path.
- MediaPackage V2 OriginEndpoint is now configured (via CDK) to include a WebVTT subtitle group in the HLS manifest.
- Viewers receive a single HLS manifest from MediaPackage/CloudFront that references both the video/audio and the captions.
- No external manifest merging is required; MediaPackage handles this automatically.

**If you change subtitle languages or add more tracks, update the CDK configuration accordingly.**

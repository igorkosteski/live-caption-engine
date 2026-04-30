#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { LiveCaptionStack } from '../lib/live-caption-stack';
import { MediaStack } from '../lib/media-stack';

const app = new cdk.App();

// ── Shared env ────────────────────────────────────────────────────────────────
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region:  process.env.CDK_DEFAULT_REGION ?? 'us-east-1'
};

// ── Context flags (override at deploy time) ───────────────────────────────────
//   cdk deploy -c engine=gemini -c channelClass=STANDARD
const engine             = (app.node.tryGetContext('engine')      ?? 'soniox') as 'soniox' | 'gemini';
const channelClass       = (app.node.tryGetContext('channelClass') ?? 'SINGLE_PIPELINE') as 'STANDARD' | 'SINGLE_PIPELINE';
const dubbingPollyEnabled = (app.node.tryGetContext('dubbingPollyEnabled') ?? 'false') === 'true';
const vpcId              = app.node.tryGetContext('vpcId') as string | undefined;

// ── Stack 1: MediaLive + MediaPackage V2 + CloudFront ─────────────────────────
const mediaStack = new MediaStack(app, 'LiveCaptionMedia', {
  env,
  channelClass,
  segmentDurationSeconds: 6,
  manifestWindowSeconds:  60,
  startoverWindowSeconds: 7200,
  // Restrict to your encoder's IP in production, e.g. ['203.0.113.10/32']
  rtmpAllowedCidrs: ['0.0.0.0/0'],
  description: 'Live caption engine — MediaLive + MediaPackage V2 + CloudFront',
  tags: { Project: 'live-caption-engine', ManagedBy: 'CDK' }
});

// ── Stack 2: ECS Fargate + ALB (live-caption-engine) ─────────────────────────
// The MediaPackage ingest URL is wired from mediaStack as a cross-stack reference.
const liveCaptionStack = new LiveCaptionStack(app, 'LiveCaptionEngine', {
  env,
  engine,
  // MediaPackage is always enabled — ingest URL comes from MediaStack.
  mediapackageEnabled:  true,
  mediapackageIngestUrl: mediaStack.mediaPackageIngestUrl,
  dubbingPollyEnabled,
  desiredCount:    1,
  minCapacity:     1,
  maxCapacity:     10,
  cpu:             512,
  memoryLimitMiB:  1024,
  publicLoadBalancer: true,
  vpcId,
  ecrMaxImageCount: 10,
  description: 'Live caption engine — ECS Fargate + ALB',
  tags: { Project: 'live-caption-engine', ManagedBy: 'CDK' }
});

// ECS stack references the MediaPackage ingest URL from the media stack.
liveCaptionStack.addDependency(mediaStack);

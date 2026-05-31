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
const vpcId              = app.node.tryGetContext('vpcId')            as string | undefined;
const repositoryName     = app.node.tryGetContext('repositoryName')   as string | undefined;

// ── Stack 1: MediaLive + MediaPackage V2 ──────────────────────────────────────
const mediaStack = new MediaStack(app, 'LiveCaptionMedia', {
  env,
  channelClass,
  segmentDurationSeconds: 6,
  manifestWindowSeconds:  60,
  startoverWindowSeconds: 7200,
  description: 'Live caption engine — MediaLive + MediaPackage V2',
  tags: { Project: 'live-caption-engine', ManagedBy: 'CDK' }
});

// ── Stack 2: ECS Fargate + ALB (live-caption-engine) ─────────────────────────
const liveCaptionStack = new LiveCaptionStack(app, 'LiveCaptionEngine', {
  env,
  engine,
  medialiverInputId: mediaStack.medialiverInputId,
  // MPv2 egress used by manifest proxy and player-facing master flow.
  mediapackageOriginUrl: mediaStack.mediaPackageOriginUrl,
  // Internal fetch path in ECS (same value by default, but explicit for workflow clarity).
  mediapackageOriginInternalUrl: mediaStack.mediaPackageOriginUrl,
  // MPv2 ingest path for direct track publishing workflow.
  mediapackageIngestUrl: mediaStack.mediaPackageIngestUrl,
  // MPv2 output channel — ECS SegmentAssembler pushes assembled tracks here.
  mediapackageOutputIngestUrl: mediaStack.mediaPackageOutputIngestUrl,
  mediapackageOutputOriginUrl: mediaStack.mediaPackageOutputOriginUrl,
  dubbingPollyEnabled,
  desiredCount:    1,
  minCapacity:     1,
  maxCapacity:     10,
  cpu:             512,
  memoryLimitMiB:  1024,
  publicLoadBalancer: true,
  vpcId,
  repositoryName,
  ecrMaxImageCount: 10,
  description: 'Live caption engine — ECS Fargate + ALB',
  tags: { Project: 'live-caption-engine', ManagedBy: 'CDK' }
});

// ECS stack references the MediaPackage ingest URL from the media stack.
liveCaptionStack.addDependency(mediaStack);

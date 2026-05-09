import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as medialive from 'aws-cdk-lib/aws-medialive';
import * as mediapackagev2 from 'aws-cdk-lib/aws-mediapackagev2';
import { Construct } from 'constructs';

export interface MediaStackProps extends cdk.StackProps {
  /**
   * RTMP stream name the encoder pushes to MediaLive, e.g. 'live/primary'.
   * @default 'live/primary'
   */
  rtmpStreamName?: string;

  /**
   * HLS segment duration in seconds.  Must match MediaLive segmentLength.
   * @default 6
   */
  segmentDurationSeconds?: number;

  /**
   * Live manifest window in seconds (number of segments exposed for playback).
   * @default 60
   */
  manifestWindowSeconds?: number;

  /**
   * DVR / startover window in seconds.  0 disables startover.
   * @default 7200  (2 hours)
   */
  startoverWindowSeconds?: number;

  /**
   * SINGLE_PIPELINE = 1 encoder pipeline, cheaper, single point of failure.
   * STANDARD        = 2 redundant pipelines, recommended for production.
   * @default 'SINGLE_PIPELINE'
   */
  channelClass?: 'STANDARD' | 'SINGLE_PIPELINE';

  /**
   * Source CIDR ranges allowed to push RTMP to MediaLive.
   * Restrict to your encoder IPs in production.
   * @default ['0.0.0.0/0']
   */
  rtmpAllowedCidrs?: string[];

  /**
   * Base RTMP URL of the nginx-rtmp relay, WITHOUT the stream name.
   * e.g. `rtmp://<host>:1935/live`
   *
   * When provided together with nginxRtmpStreamName, MediaLive adds a second
   * RTMP output group that pushes the live stream to the relay so the
   * live-caption-engine can pull it at low latency instead of going via HLS.
   *
   * @default undefined — RTMP tap output group is not created
   */
  nginxRtmpBaseUrl?: string;

  /**
   * Stream name MediaLive pushes to the nginx-rtmp relay.
   * e.g. `primary`  →  full URL becomes `<nginxRtmpBaseUrl>/primary`
   *
   * For STANDARD channel class a second-pipeline stream `<name>-b` is
   * derived automatically.
   *
   * @default 'primary'
   */
  nginxRtmpStreamName?: string;
}

export class MediaStack extends cdk.Stack {
  /**
   * MediaPackage V2 primary ingest URL.
   * Pass this to LiveCaptionStack as `mediapackageIngestUrl` so the
   * live-caption-engine can push VTT/AAC segments here.
   */
  public readonly mediaPackageIngestUrl: string;

  /** CloudFront distribution HTTPS root URL. */
  // public readonly playbackUrl: string;

  /** CloudFront HLS master playlist URL ready to plug into a video player. */
  // public readonly hlsPlaylistUrl: string;

  constructor(scope: Construct, id: string, props: MediaStackProps = {}) {
    super(scope, id, props);

    const rtmpStreamName         = props.rtmpStreamName         ?? 'live/primary';
    const segmentDurationSeconds = props.segmentDurationSeconds ?? 6;
    const manifestWindowSeconds  = props.manifestWindowSeconds  ?? 60;
    const startoverWindowSeconds = props.startoverWindowSeconds ?? 7200;
    const channelClass           = props.channelClass           ?? 'SINGLE_PIPELINE';
    const rtmpAllowedCidrs       = props.rtmpAllowedCidrs       ?? ['0.0.0.0/0'];

    const GROUP_NAME    = 'live-caption';
    const CHANNEL_NAME  = 'main';
    const ENDPOINT_NAME = 'hls';
    const MANIFEST_NAME = 'index';   // Used in the HLS manifest config.

    // ── MediaPackage V2 ────────────────────────────────────────────────────────

    const channelGroup = new mediapackagev2.CfnChannelGroup(this, 'ChannelGroup', {
      channelGroupName: GROUP_NAME,
      description: 'Live caption engine — receives HLS from MediaLive + VTT/AAC from the caption engine'
    });

    const mpChannel = new mediapackagev2.CfnChannel(this, 'MpChannel', {
      channelGroupName: GROUP_NAME,
      channelName: CHANNEL_NAME,
      description: 'Main live channel'
    });
    mpChannel.addDependency(channelGroup);

    const originEndpoint = new mediapackagev2.CfnOriginEndpoint(this, 'HlsEndpoint', {
      channelGroupName: GROUP_NAME,
      channelName: CHANNEL_NAME,
      originEndpointName: ENDPOINT_NAME,
      containerType: 'TS',
      segment: {
        segmentDurationSeconds,
        segmentName: 'seg',
        tsUseAudioRenditionGroup: true,
        includeIframeOnlyStreams: false
      },
      hlsManifests: [{
        manifestName: MANIFEST_NAME,
        manifestWindowSeconds,
        programDateTimeIntervalSeconds: 1,
        scteHls: { adMarkerHls: 'DATERANGE' }
      }],
      startoverWindowSeconds
    });
    originEndpoint.addDependency(mpChannel);

    // ── IAM role for MediaLive ─────────────────────────────────────────────────

    const mediaLiveRole = new iam.Role(this, 'MediaLiveRole', {
      roleName: `live-caption-medialive-role-${this.region}`,
      assumedBy: new iam.ServicePrincipal('medialive.amazonaws.com'),
      inlinePolicies: {
        MediaPackageV2Ingest: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            actions: ['mediapackagev2:PutObject'],
            resources: [mpChannel.attrArn]
          })]
        }),
        CloudWatchLogs: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
            resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/medialive/*`]
          })]
        }),
        // MediaLive reads input credentials from SSM Parameter Store.
        SsmRead: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            actions: ['ssm:DescribeParameters', 'ssm:GetParameter', 'ssm:GetParameters'],
            resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/medialive*`]
          })]
        })
      }
    });

    const channelPolicy = new mediapackagev2.CfnChannelPolicy(this, 'ChannelPolicy', {
      channelGroupName: GROUP_NAME,
      channelName: CHANNEL_NAME,
      policy: {
        Version: '2012-10-17',
        Statement: [{
          Sid: 'AllowMediaLivePutObject',
          Effect: 'Allow',
          Principal: { 
            AWS: mediaLiveRole.roleArn 
          },
          Action: 'mediapackagev2:PutObject',
          Resource: mpChannel.attrArn
        }]
      }
    });
    channelPolicy.addDependency(mpChannel);

    // ── MediaLive input security group ─────────────────────────────────────────

    const inputSg = new medialive.CfnInputSecurityGroup(this, 'InputSg', {
      whitelistRules: rtmpAllowedCidrs.map(cidr => ({ cidr }))
    });

    // RTMP_PUSH: one destination per pipeline (SINGLE=1, STANDARD=2).
    const numPipelines   = channelClass === 'STANDARD' ? 2 : 1;
    const rtmpDestinations = Array.from({ length: numPipelines }, (_, i) => ({
      streamName: i === 0 ? rtmpStreamName : `${rtmpStreamName}-b`
    }));

    const rtmpInput = new medialive.CfnInput(this, 'RtmpInput', {
      name: 'live-caption-rtmp',
      type: 'RTMP_PUSH',
      inputSecurityGroups: [inputSg.ref],
      destinations: rtmpDestinations
    });

    // ── MediaLive channel ──────────────────────────────────────────────────────
    // Sends HLS to MediaPackage V2 via SigV4-signed PUT (hlsBasicPutSettings).

    // Get the two MediaPackage V2 ingest endpoints (for dual-pipeline redundancy).
    const mp2Urls = mpChannel.attrIngestEndpointUrls;
    const mp2Url0 = cdk.Fn.select(0, mp2Urls);
    const mp2Url1 = channelClass === 'STANDARD' ? cdk.Fn.select(1, mp2Urls) : mp2Url0;

    const nginxRtmpBaseUrl    = props.nginxRtmpBaseUrl;
    const nginxRtmpStreamName = props.nginxRtmpStreamName ?? 'primary';

    // ── MediaLive destinations ─────────────────────────────────────────────────
    // 'mp2'        → MediaPackage V2 ingest (always present).
    // 'nginx-rtmp' → nginx relay for caption-engine audio tap (optional).
    const mlDestinations: medialive.CfnChannel.OutputDestinationProperty[] = [{
      id: 'mp2',
      settings: [
        { url: mp2Url0 },
        ...(channelClass === 'STANDARD' ? [{ url: mp2Url1 }] : [])
      ]
    }];

    if (nginxRtmpBaseUrl) {
      const nginxStreamNameB = `${nginxRtmpStreamName}-b`;
      mlDestinations.push({
        id: 'nginx-rtmp',
        settings: [
          { url: nginxRtmpBaseUrl, streamName: nginxRtmpStreamName },
          ...(channelClass === 'STANDARD' ? [{ url: nginxRtmpBaseUrl, streamName: nginxStreamNameB }] : [])
        ]
      });
    }

    // ── MediaLive output groups ────────────────────────────────────────────────
    // Group 1 (always): HLS → MediaPackage V2  (broadcast video + audio).
    // Group 2 (optional): RTMP → nginx-rtmp relay (caption-engine audio tap).
    const mlOutputGroups: medialive.CfnChannel.OutputGroupProperty[] = [{
      name: 'MediaPackageV2',
      outputGroupSettings: {
        hlsGroupSettings: {
          destination: { destinationRefId: 'mp2' },
          hlsCdnSettings: {
            hlsBasicPutSettings: {
              connectionRetryInterval: 30,
              filecacheDuration: 300,
              numRetries: 10,
              restartDelay: 15
            }
          },
          inputLossAction: 'EMIT_OUTPUT',
          manifestCompression: 'NONE',
          manifestDurationFormat: 'FLOATING_POINT',
          mode: 'LIVE',
          outputSelection: 'MANIFESTS_AND_SEGMENTS',
          programDateTime: 'INCLUDE',
          programDateTimePeriod: 1,
          segmentLength: segmentDurationSeconds,
          segmentsPerSubdirectory: 10000,
          streamInfResolution: 'INCLUDE',
          timedMetadataId3Frame: 'PRIV',
          timedMetadataId3Period: 10,
          tsFileMode: 'SEGMENTED_FILES'
        }
      },
      outputs: [{
        outputName: 'hls_720p',
        videoDescriptionName: 'video_720p',
        audioDescriptionNames: ['audio_aac'],
        outputSettings: {
          hlsOutputSettings: {
            nameModifier: '_720p',
            hlsSettings: {
              standardHlsSettings: {
                m3U8Settings: {
                  audioFramesPerPes: 4,
                  audioPids: '492-498',
                  ecmPid: '8182',
                  pcrControl: 'PCR_EVERY_PES_PACKET',
                  pmtPid: '480',
                  programNum: 1,
                  scte35Behavior: 'NO_PASSTHROUGH',
                  scte35Pid: '500',
                  timedMetadataBehavior: 'NO_PASSTHROUGH',
                  videoPid: '481'
                }
              }
            }
          }
        }
      }]
    }];

    if (nginxRtmpBaseUrl) {
      // RTMP tap: push the same video+audio to the nginx-rtmp relay so the
      // caption engine can connect at low latency without going through HLS.
      mlOutputGroups.push({
        name: 'NginxRtmpTap',
        outputGroupSettings: {
          rtmpGroupSettings: {
            authenticationScheme: 'COMMON',
            cacheLength: 30,
            cacheFullBehavior: 'DISCONNECT_IMMEDIATELY',
            restartDelay: 15
          }
        },
        outputs: [{
          outputName: 'rtmp_tap',
          videoDescriptionName: 'video_720p',
          audioDescriptionNames: ['audio_aac'],
          outputSettings: {
            rtmpOutputSettings: {
              destination: { destinationRefId: 'nginx-rtmp' },
              connectionRetryInterval: 5,
              numRetries: 10
            }
          }
        }]
      });
    }

    const mlChannel = new medialive.CfnChannel(this, 'MlChannel', {
      name: 'live-caption-channel',
      channelClass,
      roleArn: mediaLiveRole.roleArn,
      inputSpecification: {
        codec: 'AVC',
        maximumBitrate: 'MAX_20_MBPS',
        resolution: 'HD'
      },
      inputAttachments: [{
        inputAttachmentName: 'rtmp-main',
        inputId: rtmpInput.ref,
        inputSettings: {
          sourceEndBehavior: 'CONTINUE',
          inputFilter: 'AUTO',
          filterStrength: 1,
          deblockFilter: 'DISABLED',
          denoiseFilter: 'DISABLED',
          smpte2038DataPreference: 'IGNORE',
          audioSelectors: [],
          captionSelectors: []
        }
      }],
      destinations: mlDestinations,
      encoderSettings: {
        // ── Video ──────────────────────────────────────────────────────────────
        videoDescriptions: [{
          name: 'video_720p',
          width: 1280,
          height: 720,
          respondToAfd: 'NONE',
          sharpness: 50,
          scalingBehavior: 'DEFAULT',
          codecSettings: {
            h264Settings: {
              afdSignaling: 'NONE',
              colorMetadata: 'INSERT',
              adaptiveQuantization: 'HIGH',
              bitrate: 3000000,
              entropyEncoding: 'CABAC',
              flickerAq: 'ENABLED',
              forceFieldPictures: 'DISABLED',
              framerateControl: 'SPECIFIED',
              framerateNumerator: 25,
              framerateDenominator: 1,
              gopBReference: 'DISABLED',
              gopClosedCadence: 1,
              gopNumBFrames: 2,
              gopSize: 90,
              gopSizeUnits: 'FRAMES',
              subgopLength: 'FIXED',
              scanType: 'PROGRESSIVE',
              level: 'H264_LEVEL_AUTO',
              lookAheadRateControl: 'HIGH',
              numRefFrames: 1,
              parControl: 'SPECIFIED',
              parDenominator: 1,
              parNumerator: 1,
              profile: 'HIGH',
              rateControlMode: 'CBR',
              syntax: 'DEFAULT',
              temporalAq: 'ENABLED',
              timecodeInsertion: 'DISABLED'
            }
          }
        }],
        // ── Audio ──────────────────────────────────────────────────────────────
        audioDescriptions: [{
          name: 'audio_aac',
          audioSelectorName: 'default',
          audioTypeControl: 'FOLLOW_INPUT',
          languageCodeControl: 'FOLLOW_INPUT',
          codecSettings: {
            aacSettings: {
              bitrate: 192000,
              codingMode: 'CODING_MODE_2_0',
              inputType: 'NORMAL',
              profile: 'LC',
              rateControlMode: 'CBR',
              rawFormat: 'NONE',
              sampleRate: 48000,
              spec: 'MPEG4'
            }
          }
        }],
        // ── Output groups (built above; includes nginx-rtmp tap when configured) ──
        outputGroups: mlOutputGroups,
        // ── Global ─────────────────────────────────────────────────────────────
        timecodeConfig: { source: 'EMBEDDED' },
        globalConfiguration: {
          inputLossBehavior: {
            inputLossImageType: 'COLOR',
            inputLossImageColor: '000000',
            blackFrameMsec: 1000,
            repeatFrameMsec: 900000
          }
        }
      }
    });

    mlChannel.addDependency(mpChannel);

    // ── CloudFront OAC for MediaPackage V2 ─────────────────────────────────────

    const oac = new cloudfront.CfnOriginAccessControl(this, 'Oac', {
      originAccessControlConfig: {
        name: `${GROUP_NAME}-mp2-oac`,
        originAccessControlOriginType: 'mediapackagev2',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
        description: 'OAC — CloudFront → MediaPackage V2'
      }
    });

    // MediaPackage V2 egress domain follows a predictable pattern.
    const mpOriginDomain = `${GROUP_NAME}.egress.${this.region}.mediapackagev2.amazonaws.com`;
    const mpOriginPath   = `/out/v1/${GROUP_NAME}/${CHANNEL_NAME}/${ENDPOINT_NAME}`;

    // ── CloudFront distribution ────────────────────────────────────────────────
    // Use CfnDistribution directly so the origin config exactly matches the AWS
    // documented pattern for MediaPackage V2 + OAC: CustomOriginConfig with only
    // HTTPSPort + OriginProtocolPolicy, plus OriginAccessControlId.  CDK L2
    // HttpOrigin injects extra fields (OriginSSLProtocols, timeouts) that cause
    // CloudFront to reject the "origin type vs OAC origin type" validation.

    // const cfnDist = new cloudfront.CfnDistribution(this, 'Distribution', {
    //   distributionConfig: {
    //     comment: `${GROUP_NAME} live stream`,
    //     enabled: true,
    //     httpVersion: 'http2and3',
    //     ipv6Enabled: true,
    //     priceClass: 'PriceClass_100',
    //     origins: [{
    //       id: 'MediaPackageV2',
    //       domainName: mpOriginDomain,
    //       originPath: mpOriginPath,
    //       originAccessControlId: oac.attrId,
    //       customOriginConfig: {
    //         httpsPort: 443,
    //         originProtocolPolicy: 'https-only',
    //       },
    //     }],
    //     defaultCacheBehavior: {
    //       targetOriginId: 'MediaPackageV2',
    //       viewerProtocolPolicy: 'redirect-to-https',
    //       // CACHING_DISABLED managed policy ID — ensures live manifests are always fresh.
    //       cachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
    //       allowedMethods: ['GET', 'HEAD'],
    //       compress: false,
    //     },
    //   },
    // });

    // ── MediaPackage V2 endpoint resource policy ───────────────────────────────
    // Allows CloudFront (scoped to this distribution) to call mediapackagev2:GetObject.

    // const distributionArn = `arn:aws:cloudfront::${this.account}:distribution/${cfnDist.ref}`;

    // Using CfnResource directly — safer than assuming the CDK construct name.
    // new cdk.CfnResource(this, 'EndpointPolicy', {
    //   type: 'AWS::MediaPackageV2::OriginEndpointPolicy',
    //   properties: {
    //     ChannelGroupName: GROUP_NAME,
    //     ChannelName: CHANNEL_NAME,
    //     OriginEndpointName: ENDPOINT_NAME,
    //     Policy: {
    //       Version: '2012-10-17',
    //       Statement: [{
    //         Sid: 'AllowCloudFrontOAC',
    //         Effect: 'Allow',
    //         Principal: { Service: 'cloudfront.amazonaws.com' },
    //         Action: 'mediapackagev2:GetObject',
    //         Resource: originEndpoint.attrArn,
    //         Condition: {
    //           StringEquals: { 'AWS:SourceArn': distributionArn }
    //         }
    //       }]
    //     }
    //   }
    // });

    // ── Expose values for cross-stack references ───────────────────────────────

    // Primary ingest URL — the live-caption-engine PUTs VTT/AAC segments here.
    this.mediaPackageIngestUrl = cdk.Fn.select(0, mpChannel.attrIngestEndpointUrls);

    // this.playbackUrl   = `https://${cfnDist.attrDomainName}`;
    // this.hlsPlaylistUrl = `https://${cfnDist.attrDomainName}/${MANIFEST_NAME}/index.m3u8`;

    // ── CloudFormation outputs ─────────────────────────────────────────────────

    // new cdk.CfnOutput(this, 'HlsPlaylistUrl', {
    //   value: this.hlsPlaylistUrl,
    //   description: 'HLS master playlist URL — paste into VLC, Quicktime, or an HLS.js player'
    // });

    new cdk.CfnOutput(this, 'MediaPackageIngestUrl', {
      value: this.mediaPackageIngestUrl,
      description: 'MediaPackage V2 primary ingest URL — used by live-caption-engine for VTT/AAC ingest'
    });

    new cdk.CfnOutput(this, 'MediaLiveChannelId', {
      value: mlChannel.ref,
      description: 'MediaLive channel ID — run: aws medialive start-channel --channel-id <id>'
    });

    new cdk.CfnOutput(this, 'MediaLiveInputId', {
      value: rtmpInput.ref,
      description: 'MediaLive input ID — describe to get the RTMP push URL(s)'
    });

    new cdk.CfnOutput(this, 'MediaLiveInputArn', {
      value: rtmpInput.attrArn,
      description: 'Copy to console or: aws medialive describe-input --input-id <id> to find RTMP URL(s)'
    });

    if (nginxRtmpBaseUrl) {
      new cdk.CfnOutput(this, 'NginxRtmpTapUrl', {
        value: `${nginxRtmpBaseUrl}/${nginxRtmpStreamName}`,
        description: 'nginx-rtmp relay URL that MediaLive pushes to — use this as rtmpUrl when starting a caption session'
      });
    }

    // new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
    //   value: cfnDist.ref,
    //   description: 'CloudFront distribution ID'
    // });
  }
}

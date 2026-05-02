import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as autoscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import { Construct } from 'constructs';

export interface LiveCaptionStackProps extends cdk.StackProps {
  /**
   * Which transcription engine to use: 'soniox' | 'gemini'
   * @default 'soniox'
   */
  engine?: 'soniox' | 'gemini';

  /**
   * Enable MediaPackage V2 subtitle/audio ingest.
   * @default false
   */
  mediapackageEnabled?: boolean;

  /**
   * MediaPackage V2 channel ingest URL (required when mediapackageEnabled=true).
   * e.g. https://<group>.ingest.<region>.mediapackagev2.amazonaws.com/in/v1/<group>/<channel>/<ep>
   */
  mediapackageIngestUrl?: string;

  /**
   * Enable AWS Polly dubbing support (adds polly:SynthesizeSpeech to the task role).
   * @default false
   */
  dubbingPollyEnabled?: boolean;

  /**
   * Desired number of Fargate tasks.
   * @default 1
   */
  desiredCount?: number;

  /**
   * Minimum tasks for auto-scaling.
   * @default 1
   */
  minCapacity?: number;

  /**
   * Maximum tasks for auto-scaling.
   * @default 5
   */
  maxCapacity?: number;

  /**
   * Fargate CPU units (256|512|1024|2048|4096).
   * @default 512
   */
  cpu?: 256 | 512 | 1024 | 2048 | 4096;

  /**
   * Fargate memory in MiB. Must be compatible with cpu setting.
   * @default 1024
   */
  memoryLimitMiB?: number;

  /**
   * If true, the ALB is internet-facing. Set false for internal-only deployments.
   * @default true
   */
  publicLoadBalancer?: boolean;

  /**
   * If provided, import this VPC by ID instead of creating a new one.
   */
  vpcId?: string;

  /**
   * ECR lifecycle: number of image tags to keep.
   * @default 10
   */
  ecrMaxImageCount?: number;

  /**
   * If provided, import this existing ECR repository by name instead of creating a new one.
   * The lifecycle rule and imageScanOnPush settings are not applied to imported repositories.
   */
  repositoryName?: string;
}

export class LiveCaptionStack extends cdk.Stack {
  /** The ECR repository where you push the Docker image. */
  public readonly repository: ecr.Repository;
  /** The ECS cluster. */
  public readonly cluster: ecs.Cluster;
  /** The Fargate service. */
  public readonly service: ecs.FargateService;
  /** The Application Load Balancer. */
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: LiveCaptionStackProps = {}) {
    super(scope, id, props);

    const engine              = props.engine              ?? 'soniox';
    const desiredCount        = props.desiredCount        ?? 1;
    const minCapacity         = props.minCapacity         ?? 1;
    const maxCapacity         = props.maxCapacity         ?? 5;
    const cpu                 = props.cpu                 ?? 512;
    const memoryLimitMiB      = props.memoryLimitMiB      ?? 1024;
    const publicLoadBalancer  = props.publicLoadBalancer  ?? true;
    const ecrMaxImageCount    = props.ecrMaxImageCount    ?? 10;
    const mediapackageEnabled = props.mediapackageEnabled ?? false;
    const dubbingPollyEnabled = props.dubbingPollyEnabled ?? false;
    const repositoryName      = props.repositoryName ?? 'live-caption-engine';

    // ── VPC ────────────────────────────────────────────────────────────────────
    const vpc = props.vpcId
      ? ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId })
      : new ec2.Vpc(this, 'Vpc', {
          maxAzs: 2,
          natGateways: 1,
          subnetConfiguration: [
            { name: 'public',  subnetType: ec2.SubnetType.PUBLIC,           cidrMask: 24 },
            { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 }
          ]
        });

    // ── ECR repository ─────────────────────────────────────────────────────────
    this.repository = props.repositoryName
      ? ecr.Repository.fromRepositoryName(this, 'Repository', repositoryName) as ecr.Repository
      : new ecr.Repository(this, 'Repository', {
          repositoryName,
          removalPolicy: cdk.RemovalPolicy.RETAIN,
          imageScanOnPush: true,
          lifecycleRules: [
            {
              rulePriority: 1,
              description: 'Keep last N images',
              maxImageCount: ecrMaxImageCount,
              tagStatus: ecr.TagStatus.ANY
            }
          ]
        });

    // ── ECS cluster ────────────────────────────────────────────────────────────
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: 'live-caption-engine',
      containerInsightsV2: ecs.ContainerInsights.ENABLED
    });

    // ── CloudWatch log group ───────────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: '/ecs/live-caption-engine',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // ── Secrets ────────────────────────────────────────────────────────────────
    // Create placeholder secrets. After deploying, set the actual values via:
    //   aws secretsmanager put-secret-value --secret-id <arn> --secret-string '{"value":"<key>"}'
    const sonioxSecret = new secretsmanager.Secret(this, 'SonioxApiKey', {
      secretName: 'live-caption-engine/soniox-api-key',
      description: 'Soniox API key for live-caption-engine',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ value: 'REPLACE_ME' }),
        generateStringKey: '_unused'
      }
    });

    const geminiSecret = new secretsmanager.Secret(this, 'GeminiApiKey', {
      secretName: 'live-caption-engine/gemini-api-key',
      description: 'Google Gemini API key for live-caption-engine',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ value: 'REPLACE_ME' }),
        generateStringKey: '_unused'
      }
    });

    // ── Task execution role ────────────────────────────────────────────────────
    // Pulls images from ECR and reads secrets from Secrets Manager.
    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      roleName: 'live-caption-engine-execution-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
      ]
    });

    // Allow reading the two secrets.
    sonioxSecret.grantRead(executionRole);
    geminiSecret.grantRead(executionRole);

    // ── Task role ─────────────────────────────────────────────────────────────
    // Permissions the running container needs at runtime.
    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: 'live-caption-engine-task-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    });

    if (dubbingPollyEnabled) {
      taskRole.addToPolicy(new iam.PolicyStatement({
        sid: 'PollyTts',
        actions: ['polly:SynthesizeSpeech'],
        resources: ['*']
      }));
    }

    if (mediapackageEnabled) {
      taskRole.addToPolicy(new iam.PolicyStatement({
        sid: 'MediaPackageV2Ingest',
        actions: ['mediapackagev2:PutObject'],
        resources: ['*']   // Tighten to your channel ARN in production.
      }));
    }

    // CloudWatch metrics / logs from the container (for custom metrics if added later).
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogs',
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [logGroup.logGroupArn]
    }));

    // ── Task definition ────────────────────────────────────────────────────────
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: 'live-caption-engine',
      cpu,
      memoryLimitMiB,
      executionRole,
      taskRole,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.X86_64
      }
    });

    // ── Container ──────────────────────────────────────────────────────────────
    const container = taskDefinition.addContainer('app', {
      image: ecs.ContainerImage.fromEcrRepository(this.repository, 'latest'),
      containerName: 'live-caption-engine',
      essential: true,
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'ecs'
      }),
      healthCheck: {
        command: ['CMD-SHELL', "node -e \"fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(20)
      },
      environment: {
        NODE_ENV:                'production',
        ENGINE:                  engine,
        PORT:                    '8080',
        LOG_LEVEL:               'info',
        AUDIO_SAMPLE_RATE:       '16000',
        AUDIO_CHANNELS:          '1',
        RECONNECT_DELAY_MS:      '3000',
        MAX_RETRIES:             '0',
        CAPTIONS_ENABLED:        'true',
        CAPTIONS_SEGMENT_DURATION_MS: '6000',
        CAPTIONS_WINDOW_SEGMENTS: '5',
        MEDIAPACKAGE_ENABLED:    mediapackageEnabled ? 'true' : 'false',
        ...(mediapackageEnabled && props.mediapackageIngestUrl
          ? { MEDIAPACKAGE_INGEST_URL: props.mediapackageIngestUrl }
          : {}),
        AWS_REGION:              this.region
      },
      secrets: {
        // The container receives these as plain env vars at runtime.
        SONIOX_API_KEY: ecs.Secret.fromSecretsManager(sonioxSecret, 'value'),
        GEMINI_API_KEY: ecs.Secret.fromSecretsManager(geminiSecret, 'value')
      }
    });

    container.addPortMappings({ containerPort: 8080, protocol: ecs.Protocol.TCP });

    // ── Security groups ────────────────────────────────────────────────────────
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'live-caption-engine ALB',
      allowAllOutbound: true
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80),  'HTTP from internet');
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from internet');

    const serviceSg = new ec2.SecurityGroup(this, 'ServiceSg', {
      vpc,
      description: 'live-caption-engine ECS tasks',
      allowAllOutbound: true   // Needs to reach Soniox/Gemini WS + MediaPackage.
    });
    serviceSg.addIngressRule(albSg, ec2.Port.tcp(8080), 'ALB to container');

    // ── ALB ───────────────────────────────────────────────────────────────────
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: publicLoadBalancer,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      loadBalancerName: 'live-caption-engine'
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: 8080,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/healthz',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3
      },
      deregistrationDelay: cdk.Duration.seconds(15),
      // Sticky sessions keep a client connected to the same task (needed for
      // long-lived chunked PCM streams / VTT polling).
      stickinessCookieDuration: cdk.Duration.hours(1)
    });

    this.loadBalancer.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [targetGroup]
    });

    // ── Fargate service ────────────────────────────────────────────────────────
    this.service = new ecs.FargateService(this, 'Service', {
      cluster: this.cluster,
      taskDefinition,
      desiredCount,
      serviceName: 'live-caption-engine',
      securityGroups: [serviceSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      circuitBreaker: { rollback: true },
      deploymentController: { type: ecs.DeploymentControllerType.ECS },
      enableExecuteCommand: true,   // Allows `aws ecs execute-command` for debugging.
      minHealthyPercent: 100,
      maxHealthyPercent: 200
    });

    this.service.attachToApplicationTargetGroup(targetGroup);

    // ── Auto-scaling ───────────────────────────────────────────────────────────
    const scaling = this.service.autoScaleTaskCount({
      minCapacity,
      maxCapacity
    });

    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(30)
    });

    scaling.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(30)
    });

    // ── Outputs ────────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.loadBalancer.loadBalancerDnsName,
      description: 'ALB DNS — POST http://<this>/sessions to start a stream'
    });

    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      value: this.repository.repositoryUri,
      description: 'ECR URI — docker push <this>:ecs'
    });

    new cdk.CfnOutput(this, 'SonioxSecretArn', {
      value: sonioxSecret.secretArn,
      description: 'Set SONIOX_API_KEY: aws secretsmanager put-secret-value --secret-id <arn> --secret-string \'{"value":"sk-..."}\''
    });

    new cdk.CfnOutput(this, 'GeminiSecretArn', {
      value: geminiSecret.secretArn,
      description: 'Set GEMINI_API_KEY: aws secretsmanager put-secret-value --secret-id <arn> --secret-string \'{"value":"AIza..."}\''
    });

    new cdk.CfnOutput(this, 'EcsClusterName', {
      value: this.cluster.clusterName
    });

    new cdk.CfnOutput(this, 'EcsServiceName', {
      value: this.service.serviceName
    });
  }
}

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface NginxRtmpStackProps extends cdk.StackProps {
  /**
   * Stream name that MediaLive will push (and the caption engine will pull).
   * Must not contain '/'.
   * @default 'primary'
   */
  streamName?: string;

  /**
   * EC2 instance type for the nginx-rtmp relay.
   * t3.micro is enough for a single 3–5 Mbps stream.
   * @default 't3.micro'
   */
  instanceType?: string;

  /**
   * CIDR ranges allowed to push RTMP to this relay on port 1935.
   * MediaLive IPs are not static, so the default opens to all.
   * Restrict if you know your MediaLive VPC CIDR.
   * @default ['0.0.0.0/0']
   */
  rtmpIngressCidrs?: string[];
}

/**
 * Minimal EC2 stack that runs nginx-rtmp inside Docker.
 * MediaLive pushes RTMP here; the live-caption-engine ECS task pulls it.
 *
 * Exports:
 *  - rtmpBaseUrl   e.g. "rtmp://<public-ip>:1935/live"  (CFn token)
 *  - streamName    literal string, e.g. "primary"
 *  - rtmpUrl       full URL = rtmpBaseUrl + "/" + streamName  (CFn token)
 */
export class NginxRtmpStack extends cdk.Stack {
  /** Base URL without stream name: rtmp://<ip>:1935/live */
  public readonly rtmpBaseUrl: string;

  /** Stream name component of the URL, e.g. 'primary' */
  public readonly streamName: string;

  /** Full RTMP URL ready to use in MediaLive output or POST /sessions */
  public readonly rtmpUrl: string;

  constructor(scope: Construct, id: string, props: NginxRtmpStackProps = {}) {
    super(scope, id, props);

    const streamName       = props.streamName       ?? 'primary';
    const instanceType     = props.instanceType     ?? 't3.micro';
    const rtmpIngressCidrs = props.rtmpIngressCidrs ?? ['0.0.0.0/0'];

    // ── VPC ───────────────────────────────────────────────────────────────────
    // Single public subnet — no NAT gateway needed, instance needs only
    // outbound internet to pull the Docker image and receive inbound RTMP.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 28 }
      ]
    });

    // ── Security group ────────────────────────────────────────────────────────
    const sg = new ec2.SecurityGroup(this, 'Sg', {
      vpc,
      description: 'nginx-rtmp relay',
      allowAllOutbound: true
    });

    // RTMP ingest from MediaLive (and optionally your encoder for testing).
    for (const cidr of rtmpIngressCidrs) {
      sg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(1935), 'RTMP ingest');
    }

    // HTTPS required for SSM Session Manager (no need to open SSH port).
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'SSM Session Manager');

    // ── IAM role — SSM access (no SSH key needed) ─────────────────────────────
    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
      ]
    });

    // ── User data — install Docker + run nginx-rtmp ───────────────────────────
    // Uses the tiangolo/nginx-rtmp image which listens on 1935 with
    // application `live` — matching our URL scheme rtmp://host:1935/live/<name>.
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'dnf update -y',
      'dnf install -y docker',
      'systemctl enable --now docker',
      // Wait until Docker is ready before pulling.
      'until docker info &>/dev/null; do sleep 1; done',
      'docker run -d --restart always -p 1935:1935 tiangolo/nginx-rtmp'
    );

    // ── EC2 instance ──────────────────────────────────────────────────────────
    const instance = new ec2.Instance(this, 'Instance', {
      vpc,
      instanceType: new ec2.InstanceType(instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: sg,
      role,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      userData,
      // Elastic IP is NOT used — public IP changes on stop/start.
      // For production, add an EIP or put a domain name in front.
    });

    // ── Elastic IP — stable public IP even after instance reboots ─────────────
    const eip = new ec2.CfnEIP(this, 'Eip', { domain: 'vpc' });
    new ec2.CfnEIPAssociation(this, 'EipAssoc', {
      instanceId: instance.instanceId,
      allocationId: eip.attrAllocationId
    });

    // ── Outputs ───────────────────────────────────────────────────────────────
    this.streamName   = streamName;
    this.rtmpBaseUrl  = `rtmp://${eip.attrPublicIp}:1935/live`;
    this.rtmpUrl      = `${this.rtmpBaseUrl}/${streamName}`;

    new cdk.CfnOutput(this, 'NginxRtmpPublicIp', {
      value: eip.attrPublicIp,
      description: 'Elastic IP of the nginx-rtmp relay — stable across reboots'
    });

    new cdk.CfnOutput(this, 'NginxRtmpUrl', {
      value: this.rtmpUrl,
      description: 'Full RTMP URL — use as rtmpUrl when POSTing to /sessions'
    });

    new cdk.CfnOutput(this, 'SsmConnectCommand', {
      value: `aws ssm start-session --target ${instance.instanceId} --region ${this.region}`,
      description: 'Connect to the instance without SSH'
    });
  }
}

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ProviderType } from '../../contracts.js';
import {
  resolveStaticIacCandidates,
  type ResolveStaticIacOptions,
  type StaticIacResolution
} from '../iac/index.js';
import { resolveLocalReadWithinRoot } from '../utils/resolve-path-within-root.js';
import { findIaCFiles } from './scan.js';

/**
 * Narrow static-IaC options threaded from runtime (no hidden globals / cross-run cache).
 * `resolveStaticIac` is a run-scoped lazy memoized resolver shared with inventory when both run.
 */
export type CollectRepoSignalsStaticIacOptions = Pick<ResolveStaticIacOptions, 's3Client' | 'terraformStatePaths'> & {
  /** Creates at most one Promise on first call; subsequent callers await the same result. */
  resolveStaticIac?: () => Promise<StaticIacResolution>;
};

export interface CollectRepoSignalsOptions {
  staticIac?: CollectRepoSignalsStaticIacOptions;
  /**
   * When false, skip static IaC enrichment entirely (e.g. an explicit/catalog/inventory
   * repo contract was already selected and static IaC work is unnecessary).
   * Defaults to true.
   */
  includeStaticIac?: boolean;
}

async function resolveSignalsStaticIac(
  repoRoot: string,
  staticIac?: CollectRepoSignalsStaticIacOptions
): Promise<StaticIacResolution> {
  if (staticIac?.resolveStaticIac) {
    return staticIac.resolveStaticIac();
  }
  return resolveStaticIacCandidates(repoRoot, {
    maxFiles: 60,
    maxDepth: 6,
    enabledSources: {
      cloudformation: true,
      sam: true,
      cdk: true,
      terraform: true,
      serverless: true
    },
    ...(staticIac?.s3Client ? { s3Client: staticIac.s3Client } : {}),
    ...(staticIac?.terraformStatePaths ? { terraformStatePaths: staticIac.terraformStatePaths } : {})
  });
}

export interface RepoSignals {
  serviceHints: string[];
  explicitGatewayIdHints: string[];
  inferredGatewayIdHints: string[];
  customDomainHints?: string[];
  lambdaUrlHints?: string[];
  evidence: string[];
  /** Providers hinted at by repo contents (IaC files, schema files, etc.). */
  providerHints?: ProviderType[];
}

async function readRepoFile(repoRoot: string, targetPath: string, fieldName: string): Promise<string> {
  const resolved = await resolveLocalReadWithinRoot(repoRoot, targetPath, { fieldName });
  return readFile(resolved.canonicalPath, 'utf8');
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function extractGatewayIds(content: string): string[] {
  const patterns = [
    /https:\/\/([a-z0-9]{10})\.execute-api\.[a-z0-9-]+\.amazonaws\.com/gi,
    /(?:--rest-api-id|--api-id)\s+([a-z0-9]{10})\b/gi,
    /restapis\/([a-z0-9]{10})\b/gi,
    /\b(?:REST_API_ID|HTTP_API_ID|API_GATEWAY_ID)\s*[:=]\s*["']?([a-z0-9]{10})\b/gi
  ];
  const matches: string[] = [];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const value = (match[1] ?? '').trim();
      if (value) {
        matches.push(value);
      }
    }
  }
  return unique(matches);
}

function extractCustomDomainHints(content: string): string[] {
  const matches: string[] = [];
  const urlPattern = /https?:\/\/([a-z0-9][a-z0-9.-]+\.[a-z]{2,})(?:[/:?#]|$)/gi;
  for (const match of content.matchAll(urlPattern)) {
    const host = (match[1] ?? '').trim().toLowerCase();
    if (!host || host.includes('amazonaws.com') || host.includes('example.com') || host.endsWith('.on.aws')) {
      continue;
    }
    matches.push(host);
  }

  const envPattern = /\b(?:API_CUSTOM_DOMAIN|CUSTOM_DOMAIN|API_DOMAIN|DOMAIN_NAME|DomainName|domainName)\s*[:=]\s*["']?([a-z0-9][a-z0-9.-]+\.[a-z]{2,})\b/gi;
  for (const match of content.matchAll(envPattern)) {
    const host = (match[1] ?? '').trim().toLowerCase();
    if (host && !host.includes('amazonaws.com') && !host.includes('example.com') && !host.endsWith('.on.aws')) {
      matches.push(host);
    }
  }

  const hostPattern = /\b(?:host|hostname|domain|domainName)\s*[:=]\s*["']?([a-z0-9][a-z0-9.-]+\.[a-z]{2,})\b/gi;
  for (const match of content.matchAll(hostPattern)) {
    const host = (match[1] ?? '').trim().toLowerCase();
    if (host && !host.includes('amazonaws.com') && !host.includes('example.com') && !host.endsWith('.on.aws')) {
      matches.push(host);
    }
  }

  return unique(matches);
}

function extractLambdaUrlHints(content: string): string[] {
  const matches: string[] = [];
  const urlPattern = /\b([a-z0-9-]+\.lambda-url\.[a-z0-9-]+\.on\.aws)\b/gi;
  for (const match of content.matchAll(urlPattern)) {
    const host = (match[1] ?? '').trim().toLowerCase();
    if (host) {
      matches.push(host);
    }
  }
  return unique(matches);
}

function inferServiceNameFromRepoSlug(repoSlug?: string): string | undefined {
  if (!repoSlug) {
    return undefined;
  }
  const parts = repoSlug.split('/');
  return parts[parts.length - 1]?.trim();
}

const PROVIDER_PATTERNS: { pattern: RegExp; provider: ProviderType }[] = [
  { pattern: /AWS::AppSync::GraphQLApi/i, provider: 'appsync' },
  { pattern: /AWS::Serverless::GraphQLApi/i, provider: 'appsync' },
  { pattern: /appsync/i, provider: 'appsync' },
  { pattern: /AWS::SNS::Topic/i, provider: 'sns' },
  { pattern: /AWS::SNS::Subscription/i, provider: 'sns' },
  { pattern: /\bType\s*:\s*SNS\b/i, provider: 'sns' },
  { pattern: /\bsns\s*:/i, provider: 'sns' },
  { pattern: /arn:aws:sns:/i, provider: 'sns' },
  { pattern: /AWS::Events::EventBus/i, provider: 'eventbridge-schemas' },
  { pattern: /AWS::Events::Rule/i, provider: 'eventbridge-schemas' },
  { pattern: /AWS::Serverless::EventBridgeRule/i, provider: 'eventbridge-schemas' },
  { pattern: /schema_registry|SchemaRegistry/i, provider: 'eventbridge-schemas' },
  { pattern: /AWS::Glue::Schema/i, provider: 'glue' },
  { pattern: /AWS::Glue::Registry/i, provider: 'glue' },
  { pattern: /AWS::ApiGateway::RestApi/i, provider: 'api-gateway' },
  { pattern: /AWS::ApiGatewayV2::Api/i, provider: 'api-gateway' },
  { pattern: /AWS::Serverless::Api\b/i, provider: 'api-gateway' },
  { pattern: /AWS::Serverless::HttpApi/i, provider: 'api-gateway' },

  // Terraform resource types
  { pattern: /resource\s+"aws_api_gateway_rest_api"/i, provider: 'api-gateway' },
  { pattern: /resource\s+"aws_apigatewayv2_api"/i, provider: 'api-gateway' },
  { pattern: /resource\s+"aws_appsync_graphql_api"/i, provider: 'appsync' },
  { pattern: /resource\s+"aws_sns_topic"/i, provider: 'sns' },
  { pattern: /resource\s+"aws_sns_topic_subscription"/i, provider: 'sns' },
  { pattern: /resource\s+"aws_schemas_schema"/i, provider: 'eventbridge-schemas' },
  { pattern: /resource\s+"aws_cloudwatch_event_bus"/i, provider: 'eventbridge-schemas' },
  { pattern: /resource\s+"aws_glue_schema"/i, provider: 'glue' },

  // CDK TypeScript patterns
  { pattern: /aws-cdk-lib\/aws-apigateway/i, provider: 'api-gateway' },
  { pattern: /aws-cdk-lib\/aws-apigatewayv2/i, provider: 'api-gateway' },
  { pattern: /aws_cdk\.aws_apigateway/i, provider: 'api-gateway' },
  { pattern: /aws_cdk.*aws_apigatewayv2/i, provider: 'api-gateway' },
  { pattern: /software\.amazon\.awscdk\.services\.apigateway/i, provider: 'api-gateway' },
  { pattern: /Amazon\.CDK\.AWS\.APIGateway/i, provider: 'api-gateway' },
  { pattern: /new\s+apigateway\.RestApi\s*\(/i, provider: 'api-gateway' },
  { pattern: /new\s+apigatewayv2\.(?:HttpApi|WebSocketApi|Api)\s*\(/i, provider: 'api-gateway' },
  { pattern: /\b(?:RestApi|HttpApi|WebSocketApi|CfnApi)\s*\(/i, provider: 'api-gateway' },
  { pattern: /aws-cdk-lib\/aws-appsync/i, provider: 'appsync' },
  { pattern: /new\s+appsync\.GraphqlApi\s*\(/i, provider: 'appsync' },
  { pattern: /aws-cdk-lib\/aws-sns/i, provider: 'sns' },
  { pattern: /new\s+sns\.Topic\s*\(/i, provider: 'sns' },
  { pattern: /sns\.Topic\.fromTopicArn\s*\(/i, provider: 'sns' },
  { pattern: /SnsEventSource/i, provider: 'sns' },
  { pattern: /aws-cdk-lib\/aws-events/i, provider: 'eventbridge-schemas' },
  { pattern: /new\s+events\.EventBus\s*\(/i, provider: 'eventbridge-schemas' },

  // Pulumi resource constructors (TypeScript/Python/Go)
  { pattern: /aws\.apigateway\.RestApi/i, provider: 'api-gateway' },
  { pattern: /aws\.apigatewayv2\.Api/i, provider: 'api-gateway' },
  { pattern: /aws:apigatewayv2\/api:Api/i, provider: 'api-gateway' },
  { pattern: /Aws\.ApiGatewayV2\.Api/i, provider: 'api-gateway' },
  { pattern: /com\.pulumi\.aws\.apigatewayv2\.Api/i, provider: 'api-gateway' },
  { pattern: /aws\.appsync\.GraphQLApi/i, provider: 'appsync' },
  { pattern: /aws\.sns\.Topic/i, provider: 'sns' },

  // Lambda Function URL patterns
  { pattern: /AWS::Lambda::Url\b/i, provider: 'lambda-url' },
  { pattern: /\bFunctionUrlConfig\s*:/i, provider: 'lambda-url' },
  { pattern: /resource\s+"aws_lambda_function_url"/i, provider: 'lambda-url' },
  { pattern: /\.addFunctionUrl\s*\(/i, provider: 'lambda-url' },
  { pattern: /aws-cdk-lib\/aws-lambda[^"']*FunctionUrl/i, provider: 'lambda-url' },
  { pattern: /\bFunctionUrlAuthType\b/i, provider: 'lambda-url' },
  { pattern: /aws\.lambda\.FunctionUrl/i, provider: 'lambda-url' },
  { pattern: /\.lambda-url\.[a-z0-9-]+\.on\.aws/i, provider: 'lambda-url' },
];

function detectSnsEventBridgeBridgePattern(content: string): boolean {
  const hasSns = /AWS::SNS::Topic|AWS::SNS::Subscription|\bType\s*:\s*SNS\b|arn:aws:sns:|resource\s+"aws_sns_topic"|resource\s+"aws_sns_topic_subscription"|aws-cdk-lib\/aws-sns|SnsEventSource|\bSNS\s+bridge\b|\bSNS[-\s/]+to[-\s/]+EventBridge\b/i.test(
    content
  );
  const hasLambda = /AWS::Lambda::Function|AWS::Serverless::Function|resource\s+"aws_lambda_function"|protocol\s*=\s*"lambda"|SnsEventSource|aws-lambda|\bLambda\b/i.test(
    content
  );
  const hasEventBridge =
    /AWS::Events::EventBus|AWS::Events::Rule|AWS::Serverless::EventBridgeRule|resource\s+"aws_cloudwatch_event_bus"|resource\s+"aws_cloudwatch_event_rule"|resource\s+"aws_schemas_schema"|aws-cdk-lib\/aws-events|new\s+events\.|\bEventBridge\b/i.test(
      content
    );
  return hasSns && hasLambda && hasEventBridge;
}

function detectProviderHints(content: string): ProviderType[] {
  const found = new Set<ProviderType>();
  for (const { pattern, provider } of PROVIDER_PATTERNS) {
    if (pattern.test(content)) {
      found.add(provider);
    }
  }
  return [...found];
}

function toEvidencePath(repoRoot: string, filePath: string): string {
  const relative = path.relative(repoRoot, filePath);
  return relative.startsWith('..') ? filePath : relative;
}

function shouldDetectProviderHintsForFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext !== '.md' && ext !== '.markdown';
}

const FIXED_INSPECT_FILES = [
  '.github/workflows/deploy.yml',
  '.gitlab-ci.yml',
  'template.yaml',
  'template.yml',
  'serverless.yml',
  'serverless.yaml',
  'cdk.json',
  'README.md'
];

function isKnownSignalConfigFile(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
  const basename = path.basename(normalized);
  return (
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(normalized) ||
    normalized === '.gitlab-ci.yml' ||
    normalized === '.circleci/config.yml' ||
    normalized === '.buildkite/pipeline.yml' ||
    /^serverless\.(?:ya?ml|json|ts|js)$/.test(basename) ||
    /(^|\/)template\.(?:ya?ml|json)$/.test(normalized) ||
    basename === 'samconfig.toml' ||
    basename === 'redocly.yaml' ||
    basename === 'redocly.yml' ||
    basename === 'swagger-jsdoc.js' ||
    basename === 'swagger-jsdoc.ts' ||
    basename === 'tsoa.json' ||
    basename === 'openapi-generator.json' ||
    basename === 'openapi-generator.yaml' ||
    basename === 'openapi-generator.yml' ||
    basename === 'pulumi.yaml' ||
    basename === 'docker-compose.yml' ||
    basename === 'docker-compose.yaml' ||
    basename === 'compose.yml' ||
    basename === 'compose.yaml' ||
    basename === 'values.yaml' ||
    basename === 'values.yml' ||
    basename === 'chart.yaml' ||
    basename === 'chart.yml' ||
    basename === 'task-definition.json' ||
    basename === 'ecs-task-definition.json' ||
    basename === 'ecs-service.json' ||
    basename === 'service-definition.json' ||
    basename === 'application.yml' ||
    basename === 'application.yaml' ||
    basename === 'application.properties' ||
    /^appsettings(?:\.[^.]+)?\.json$/.test(basename) ||
    /(^|\/)(?:helm|charts)\/.+\.ya?ml$/.test(normalized) ||
    /(^|\/)(?:k8s|kubernetes|manifests)\/.+\.ya?ml$/.test(normalized) ||
    /(^|\/)ecs\/.+\.json$/.test(normalized)
  );
}

async function collectInspectFiles(repoRoot: string): Promise<string[]> {
  const discovered = await findIaCFiles(repoRoot, ['.yml', '.yaml', '.json', '.ts', '.js', '.toml', '.properties']);
  const discoveredRelative = discovered
    .map((filePath) => path.relative(repoRoot, filePath).replace(/\\/g, '/'))
    .filter(isKnownSignalConfigFile);
  return unique([...FIXED_INSPECT_FILES, ...discoveredRelative]);
}

function isSnsEventContractFile(filePath: string): boolean {
  const lower = path.basename(filePath).toLowerCase();
  return (
    lower === 'asyncapi.yaml' ||
    lower === 'asyncapi.yml' ||
    lower === 'asyncapi.json' ||
    lower.endsWith('.schema.json')
  );
}

export async function collectRepoSignals(
  repoRoot: string,
  repoSlug?: string,
  expectedServiceName?: string,
  expectedGatewayIds: string[] = [],
  options: CollectRepoSignalsOptions = {}
): Promise<RepoSignals> {
  const serviceHints = unique([
    expectedServiceName ?? '',
    inferServiceNameFromRepoSlug(repoSlug) ?? ''
  ]);
  const inferredGatewayHints: string[] = [];
  const customDomainHints: string[] = [];
  const lambdaUrlHints: string[] = [];
  const evidence: string[] = [];
  const providerHintSet = new Set<ProviderType>();
  const snsEvidenceRoots = new Set<string>();

  const inspectFiles = await collectInspectFiles(repoRoot);

  for (const file of inspectFiles) {
    try {
      const content = await readRepoFile(repoRoot, file, 'repo-signal-file');
      const extracted = extractGatewayIds(content);
      if (extracted.length > 0) {
        inferredGatewayHints.push(...extracted);
        evidence.push(`Found gateway ID hints in ${file}`);
      }
      const domains = extractCustomDomainHints(content);
      if (domains.length > 0) {
        customDomainHints.push(...domains);
        evidence.push(`Found API custom domain hints in ${file}`);
      }
      const lambdaHosts = extractLambdaUrlHints(content);
      if (lambdaHosts.length > 0) {
        lambdaUrlHints.push(...lambdaHosts);
        providerHintSet.add('lambda-url');
        evidence.push(`Found Lambda Function URL host hints in ${file}`);
      }
      if (shouldDetectProviderHintsForFile(file)) {
        for (const hint of detectProviderHints(content)) {
          providerHintSet.add(hint);
          evidence.push(`Detected ${hint} provider hint in ${file}`);
          if (hint === 'sns') {
            snsEvidenceRoots.add(path.dirname(path.resolve(repoRoot, file)));
          }
        }
        if (detectSnsEventBridgeBridgePattern(content)) {
          evidence.push(`Detected SNS/EventBridge bridge pattern in ${file}`);
          providerHintSet.add('sns');
          providerHintSet.add('eventbridge-schemas');
        }
      }
      if (!shouldDetectProviderHintsForFile(file) && detectSnsEventBridgeBridgePattern(content)) {
        evidence.push(`Detected SNS/EventBridge bridge pattern in ${file}`);
        providerHintSet.add('sns');
        providerHintSet.add('eventbridge-schemas');
      }
    } catch {
      // Optional file.
    }
  }

  // Check for GraphQL schema files as AppSync hint
  const graphqlFiles = ['schema.graphql', 'schema.gql', 'graphql/schema.graphql', 'src/schema.graphql'];
  for (const file of graphqlFiles) {
    try {
      await readRepoFile(repoRoot, file, 'graphql-schema-file');
      providerHintSet.add('appsync');
      evidence.push(`Found GraphQL schema file: ${file}`);
      break;
    } catch {
      // Optional file.
    }
  }

  const iacFiles = await findIaCFiles(repoRoot, ['.tf']);
  for (const filePath of iacFiles) {
    const content = await readRepoFile(repoRoot, filePath, 'terraform-signal-file').catch(() => '');
    if (!content) continue;
    const extracted = extractGatewayIds(content);
    if (extracted.length > 0) {
      inferredGatewayHints.push(...extracted);
      evidence.push(`Found gateway ID hints in ${filePath}`);
    }
    const domains = extractCustomDomainHints(content);
    if (domains.length > 0) {
      customDomainHints.push(...domains);
      evidence.push(`Found API custom domain hints in ${toEvidencePath(repoRoot, filePath)}`);
    }
    const lambdaHosts = extractLambdaUrlHints(content);
    if (lambdaHosts.length > 0) {
      lambdaUrlHints.push(...lambdaHosts);
      providerHintSet.add('lambda-url');
      evidence.push(`Found Lambda Function URL host hints in ${toEvidencePath(repoRoot, filePath)}`);
    }
    for (const hint of detectProviderHints(content)) {
      providerHintSet.add(hint);
      evidence.push(`Detected ${hint} provider hint in ${toEvidencePath(repoRoot, filePath)}`);
      if (hint === 'sns') {
        snsEvidenceRoots.add(path.dirname(filePath));
      }
    }
    if (detectSnsEventBridgeBridgePattern(content)) {
      evidence.push(`Detected SNS/EventBridge bridge pattern in ${toEvidencePath(repoRoot, filePath)}`);
      providerHintSet.add('sns');
      providerHintSet.add('eventbridge-schemas');
    }
  }

  try {
    await readRepoFile(repoRoot, 'cdk.json', 'cdk-config-file');
    const cdkFiles = await findIaCFiles(repoRoot, ['.ts', '.js', '.py', '.java', '.cs']);
    for (const filePath of cdkFiles) {
      const content = await readRepoFile(repoRoot, filePath, 'cdk-signal-file').catch(() => '');
      if (!content) continue;
      const domains = extractCustomDomainHints(content);
      if (domains.length > 0) {
        customDomainHints.push(...domains);
        evidence.push(`Found API custom domain hints in ${toEvidencePath(repoRoot, filePath)}`);
      }
      const lambdaHosts = extractLambdaUrlHints(content);
      if (lambdaHosts.length > 0) {
        lambdaUrlHints.push(...lambdaHosts);
        providerHintSet.add('lambda-url');
        evidence.push(`Found Lambda Function URL host hints in ${toEvidencePath(repoRoot, filePath)}`);
      }
      for (const hint of detectProviderHints(content)) {
        providerHintSet.add(hint);
        evidence.push(`Detected ${hint} provider hint in ${toEvidencePath(repoRoot, filePath)}`);
        if (hint === 'sns') {
          snsEvidenceRoots.add(path.dirname(filePath));
        }
      }
      if (detectSnsEventBridgeBridgePattern(content)) {
        evidence.push(`Detected SNS/EventBridge bridge pattern in ${toEvidencePath(repoRoot, filePath)}`);
        providerHintSet.add('sns');
        providerHintSet.add('eventbridge-schemas');
      }
    }
  } catch {
    // Optional: no CDK project present.
  }

  try {
    const pulumiContent = await readRepoFile(repoRoot, 'Pulumi.yaml', 'pulumi-config-file');
    for (const hint of detectProviderHints(pulumiContent)) {
      providerHintSet.add(hint);
      evidence.push(`Detected ${hint} provider hint in Pulumi.yaml`);
    }
    const pulumiFiles = await findIaCFiles(repoRoot, ['.ts', '.py', '.go', '.java', '.cs']);
    for (const filePath of pulumiFiles) {
      const content = await readRepoFile(repoRoot, filePath, 'pulumi-signal-file').catch(() => '');
      if (!content) continue;
      const domains = extractCustomDomainHints(content);
      if (domains.length > 0) {
        customDomainHints.push(...domains);
        evidence.push(`Found API custom domain hints in ${toEvidencePath(repoRoot, filePath)}`);
      }
      const lambdaHosts = extractLambdaUrlHints(content);
      if (lambdaHosts.length > 0) {
        lambdaUrlHints.push(...lambdaHosts);
        providerHintSet.add('lambda-url');
        evidence.push(`Found Lambda Function URL host hints in ${toEvidencePath(repoRoot, filePath)}`);
      }
      for (const hint of detectProviderHints(content)) {
        providerHintSet.add(hint);
        evidence.push(`Detected ${hint} provider hint in ${toEvidencePath(repoRoot, filePath)}`);
        if (hint === 'sns') {
          snsEvidenceRoots.add(path.dirname(filePath));
        }
      }
      if (detectSnsEventBridgeBridgePattern(content)) {
        evidence.push(`Detected SNS/EventBridge bridge pattern in ${toEvidencePath(repoRoot, filePath)}`);
        providerHintSet.add('sns');
        providerHintSet.add('eventbridge-schemas');
      }
    }
  } catch {
    // Optional: no Pulumi project present.
  }

  if (providerHintSet.has('sns')) {
    const contractCandidates = new Set<string>();
    const contractSearchRoots = new Set<string>([repoRoot, ...snsEvidenceRoots]);

    for (const searchRoot of contractSearchRoots) {
      const files = await findIaCFiles(searchRoot, ['.yaml', '.yml', '.json']);
      for (const filePath of files) {
        if (isSnsEventContractFile(filePath)) {
          contractCandidates.add(filePath);
        }
      }
    }

    for (const contractPath of contractCandidates) {
      evidence.push(`Found SNS event contract file: ${toEvidencePath(repoRoot, contractPath)}`);
    }
  }

  // Exact physical API ID / literal output evidence from static IaC (no builds, no remote state).
  if (options.includeStaticIac !== false) {
    try {
      const iac = await resolveSignalsStaticIac(repoRoot, options.staticIac);
      for (const apiId of iac.physicalApiIds) {
        inferredGatewayHints.push(apiId);
        evidence.push(`Exact physical API ID ${apiId} from static IaC resolution`);
      }
      for (const candidate of iac.candidates) {
        if (candidate.kind === 'physical-api-id' && candidate.physicalApiId) {
          evidence.push(
            `Physical API ID handoff ${candidate.physicalApiId} via ${candidate.source} (${candidate.sourcePath})`
          );
        }
      }
    } catch {
      // Optional enrichment; signal collection must remain best-effort.
    }
  }

  return {
    serviceHints: unique(serviceHints),
    explicitGatewayIdHints: unique(expectedGatewayIds),
    inferredGatewayIdHints: unique(inferredGatewayHints),
    customDomainHints: unique(customDomainHints),
    lambdaUrlHints: unique(lambdaUrlHints),
    evidence: unique(evidence),
    providerHints: [...providerHintSet]
  };
}

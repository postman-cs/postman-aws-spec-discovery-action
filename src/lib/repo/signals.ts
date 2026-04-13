import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ProviderType } from '../../contracts.js';
import { findIaCFiles } from './scan.js';

export interface RepoSignals {
  serviceHints: string[];
  explicitGatewayIdHints: string[];
  inferredGatewayIdHints: string[];
  evidence: string[];
  /** Providers hinted at by repo contents (IaC files, schema files, etc.). */
  providerHints?: ProviderType[];
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
  { pattern: /arn:aws:sns:/i, provider: 'sns' },
  { pattern: /AWS::Events::EventBus/i, provider: 'eventbridge-schemas' },
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
  { pattern: /aws-cdk-lib\/aws-sns/i, provider: 'sns' },
  { pattern: /new\s+sns\.Topic\s*\(/i, provider: 'sns' },
  { pattern: /sns\.Topic\.fromTopicArn\s*\(/i, provider: 'sns' },
  { pattern: /SnsEventSource/i, provider: 'sns' },

  // Pulumi resource constructors (TypeScript/Python/Go)
  { pattern: /aws\.apigateway\.RestApi/i, provider: 'api-gateway' },
  { pattern: /aws\.apigatewayv2\.Api/i, provider: 'api-gateway' },
  { pattern: /aws\.appsync\.GraphQLApi/i, provider: 'appsync' },
  { pattern: /aws\.sns\.Topic/i, provider: 'sns' },
];

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
  expectedGatewayIds: string[] = []
): Promise<RepoSignals> {
  const serviceHints = unique([
    expectedServiceName ?? '',
    inferServiceNameFromRepoSlug(repoSlug) ?? ''
  ]);
  const inferredGatewayHints: string[] = [];
  const evidence: string[] = [];
  const providerHintSet = new Set<ProviderType>();
  const snsEvidenceRoots = new Set<string>();

  const inspectFiles = [
    '.github/workflows/deploy.yml',
    '.gitlab-ci.yml',
    'template.yaml',
    'template.yml',
    'serverless.yml',
    'serverless.yaml',
    'cdk.json',
    'README.md'
  ];

  for (const file of inspectFiles) {
    const fullPath = path.resolve(repoRoot, file);
    try {
      const content = await readFile(fullPath, 'utf8');
      const extracted = extractGatewayIds(content);
      if (extracted.length > 0) {
        inferredGatewayHints.push(...extracted);
        evidence.push(`Found gateway ID hints in ${file}`);
      }
      if (shouldDetectProviderHintsForFile(file)) {
        for (const hint of detectProviderHints(content)) {
          providerHintSet.add(hint);
          evidence.push(`Detected ${hint} provider hint in ${file}`);
          if (hint === 'sns') {
            snsEvidenceRoots.add(repoRoot);
          }
        }
      }
    } catch {
      // Optional file.
    }
  }

  // Check for GraphQL schema files as AppSync hint
  const graphqlFiles = ['schema.graphql', 'schema.gql', 'graphql/schema.graphql', 'src/schema.graphql'];
  for (const file of graphqlFiles) {
    const fullPath = path.resolve(repoRoot, file);
    try {
      await readFile(fullPath, 'utf8');
      providerHintSet.add('appsync');
      evidence.push(`Found GraphQL schema file: ${file}`);
      break;
    } catch {
      // Optional file.
    }
  }

  const iacFiles = await findIaCFiles(repoRoot, ['.tf']);
  for (const filePath of iacFiles) {
    const content = await readFile(filePath, 'utf8').catch(() => '');
    if (!content) continue;
    const extracted = extractGatewayIds(content);
    if (extracted.length > 0) {
      inferredGatewayHints.push(...extracted);
      evidence.push(`Found gateway ID hints in ${filePath}`);
    }
    for (const hint of detectProviderHints(content)) {
      providerHintSet.add(hint);
      evidence.push(`Detected ${hint} provider hint in ${toEvidencePath(repoRoot, filePath)}`);
      if (hint === 'sns') {
        snsEvidenceRoots.add(path.dirname(filePath));
      }
    }
  }

  const cdkJson = path.resolve(repoRoot, 'cdk.json');
  try {
    await readFile(cdkJson, 'utf8');
    const cdkFiles = await findIaCFiles(repoRoot, ['.ts']);
    for (const filePath of cdkFiles) {
      const content = await readFile(filePath, 'utf8').catch(() => '');
      if (!content) continue;
      for (const hint of detectProviderHints(content)) {
        providerHintSet.add(hint);
        evidence.push(`Detected ${hint} provider hint in ${toEvidencePath(repoRoot, filePath)}`);
        if (hint === 'sns') {
          snsEvidenceRoots.add(path.dirname(filePath));
        }
      }
    }
  } catch {
    // Optional: no CDK project present.
  }

  const pulumiYaml = path.resolve(repoRoot, 'Pulumi.yaml');
  try {
    await readFile(pulumiYaml, 'utf8');
    const pulumiFiles = await findIaCFiles(repoRoot, ['.ts', '.py', '.go']);
    for (const filePath of pulumiFiles) {
      const content = await readFile(filePath, 'utf8').catch(() => '');
      if (!content) continue;
      for (const hint of detectProviderHints(content)) {
        providerHintSet.add(hint);
        evidence.push(`Detected ${hint} provider hint in ${toEvidencePath(repoRoot, filePath)}`);
        if (hint === 'sns') {
          snsEvidenceRoots.add(path.dirname(filePath));
        }
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

  return {
    serviceHints: unique(serviceHints),
    explicitGatewayIdHints: unique(expectedGatewayIds),
    inferredGatewayIdHints: unique(inferredGatewayHints),
    evidence: unique(evidence),
    providerHints: [...providerHintSet]
  };
}

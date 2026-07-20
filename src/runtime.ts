import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  actionContract,
  type ActionMode,
  type ConfigurationMode,
  type DeployedSourceProvenance,
  type DiscoveredService,
  type GatewayType,
  type OpenApiContractAudit,
  type ProviderType,
  type ResolutionResult,
  type SourceType,
  type SpecFormat
} from './contracts.js';
import {
  accountIndicatorFromAccountId,
  parseAwsError,
  partitionFromArn,
  type AwsGatewayClient,
  type GatewayDomainMapping,
  type GatewayStageSummary,
  type HttpApiSummary,
  type RestApiSummary
} from './lib/aws/client.js';
import { AppSyncSdkClient } from './lib/aws/appsync-client.js';
import { EventBridgeSchemasSdkClient } from './lib/aws/schemas-client.js';
import { CloudFormationSdkClient, type CloudFormationSpecClient } from './lib/aws/cloudformation-client.js';
import { GlueSchemaSdkClient } from './lib/aws/glue-client.js';
import { LambdaSdkClient } from './lib/aws/lambda-client.js';
import { AppSyncEventsSdkClient } from './lib/aws/appsync-events-client.js';
import { EventBridgeSurfaceSdkClient } from './lib/aws/eventbridge-client.js';
import { BedrockActionGroupsSdkClient } from './lib/aws/bedrock-agent-client.js';
import { AlbListenerRulesSdkClient } from './lib/aws/alb-client.js';
import { LambdaEventSourceSdkClient } from './lib/aws/lambda-event-source-client.js';
import { VerifiedPermissionsSdkClient } from './lib/aws/verified-permissions-client.js';
import { StepFunctionsSdkClient } from './lib/aws/step-functions-client.js';
import { formatUserSafeError, sanitizeLogMessage, sanitizeJsonValue } from './lib/logging/sanitize.js';
import { detectRepoContext, type RepoContext } from './lib/repo/context.js';
import {
  inventoryRepoSpecs,
  findLocalCfnArtifactSpecs,
  type RepoSpecCandidate
} from './lib/repo/specs.js';
import { collectRepoSignals } from './lib/repo/signals.js';
import { chooseSource } from './lib/resolve/source-selector.js';
import { resolveServiceCandidate, rankServiceCandidates } from './lib/resolve/service-resolver.js';
import {
  formatOpenApiContractAuditWarning,
  AWS_WEBSOCKET_CONTRACT_PARTIAL,
  normalizeOpenApiYaml,
  type OperationIdRename
} from './lib/spec/normalize-openapi.js';
import {
  classifySpecContent,
  classifyWithDeclaredFormat,
  filenameForFormat
} from './lib/spec/classify-format.js';
import { deriveOpenApiDocument, type OpenApiDerivationResult } from './lib/spec/oas-derivation.js';
import { ProviderRegistry } from './lib/providers/registry.js';
import { ApiGatewayProvider } from './lib/providers/api-gateway.js';
import { AppSyncProvider } from './lib/providers/appsync.js';
import { EventBridgeSchemasProvider } from './lib/providers/eventbridge-schemas.js';
import { CloudFormationProvider } from './lib/providers/cloudformation.js';
import { GlueSchemaProvider } from './lib/providers/glue.js';
import { LambdaUrlProvider } from './lib/providers/lambda-url.js';
import { AppSyncEventsProvider } from './lib/providers/appsync-events.js';
import { EventBridgeSurfaceProvider } from './lib/providers/eventbridge-surfaces.js';
import { BedrockActionGroupProvider } from './lib/providers/bedrock-action-groups.js';
import { AlbListenerRulesProvider } from './lib/providers/alb-listener-rules.js';
import { LambdaEventSourceProvider } from './lib/providers/lambda-event-source.js';
import { VerifiedPermissionsProvider } from './lib/providers/verified-permissions.js';
import { StepFunctionsProvider } from './lib/providers/step-functions.js';
import { SsmProvider } from './lib/providers/ssm.js';
import { SnsProvider } from './lib/providers/sns.js';
import { SsmSdkClient } from './lib/aws/ssm-client.js';
import { SnsSdkClient } from './lib/aws/sns-client.js';
import { S3SdkClient } from './lib/aws/s3-client.js';
import { TaggingSdkClient, type TaggingSpecClient } from './lib/aws/tagging-client.js';
import { correlateExactRepoTags, runNarrowingPipeline } from './lib/resolve/narrowing-pipeline.js';
import { detectCatalogApis, type CatalogApiRef } from './lib/repo/catalog.js';
import {
  createRemoteFetchPolicy,
  DEFAULT_REMOTE_FETCH_POLICY,
  fetchSpecFromUrl,
  sanitizeUrlEvidence,
  type FetchByteBudget,
  type RemoteFetchPolicy
} from './lib/fetch/spec-fetcher.js';
import type { ExactRepoTagContract } from './lib/resolve/narrowing-pipeline.js';
import type { InventoryStaticIacOptions } from './lib/repo/specs.js';
import { resolveStaticIacCandidates, type StaticIacResolution } from './lib/iac/index.js';
import { resolveLocalReadWithinRoot, resolvePathWithinRoot } from './lib/utils/resolve-path-within-root.js';
import type { EventBridgeSchemasSpecClient } from './lib/aws/schemas-client.js';
import type { SpecProvider, SpecCandidate, SpecExportResult } from './lib/providers/types.js';
import type { SnsContractResolutionContext, SnsContractResult } from './lib/providers/sns.js';
import type { ResolveCodeDerivedContract } from './lib/providers/sns-code-derived.js';
import type { SnsResolvedCandidate } from './lib/resolve/source-selector.js';

export interface InputReaderLike {
  getInput(name: string, options?: { required?: boolean }): string;
}

export interface ReporterLike {
  group<T>(name: string, fn: () => Promise<T>): Promise<T>;
  info(message: string): void;
  warning(message: string): void;
}

export interface ResolvedInputs {
  mode: ActionMode;
  awsRegion: string;
  repoRoot: string;
  repoContext: RepoContext;
  expectedServiceName?: string;
  expectedGatewayIds: string[];
  stage?: string;
  /** Optional account ID that must match sts:GetCallerIdentity before export. */
  expectedAccountId?: string;
  /** Optional partition that must match the caller identity ARN before export. */
  expectedPartition?: string;
  /** Optional region pin that must match aws-region before discovery or export. */
  expectedRegion?: string;
  /** Explicit repo-relative specification path (validated inside repo root). */
  specPath?: string;
  /** Optional monorepo service root (validated inside repo root). */
  serviceRoot?: string;
  /** Deny-by-default remote fetch policy derived from remote-fetch-allowlist-json. */
  remoteFetchPolicy?: RemoteFetchPolicy;
  /**
   * Explicit repo-relative local Terraform state/output artifact paths.
   * Parsed from terraform-state-paths-json; default []. Never auto-discovers .tfstate.
   */
  terraformStatePaths?: string[];
  apiFilter?: RegExp;
  serviceMapping: Record<string, string>;
  outputDir: string;
  maxCandidates: number;
  dryRun: boolean;
  preflightChecks: boolean;
  preflightPermissionProbe: boolean;
  requestTimeoutMs: number;
  maxAttempts: number;
  includeV2: boolean;
}

interface GatewayCandidate {
  id: string;
  name: string;
  gatewayType: GatewayType;
}

interface TrustedStageEvidence {
  stageName?: string;
  deploymentId?: string;
  source?: string;
}

interface ResolutionStageSelection {
  stage?: string;
  deploymentId?: string;
  useLatestConfig?: boolean;
  configurationMode?: ConfigurationMode;
  rankedStages?: string[];
  evidence: string[];
  error?: string;
}

export interface DiscoveryDependencies {
  core: ReporterLike;
  aws: AwsGatewayClient;
  writeSpecFile(outputPath: string, content: string): Promise<void>;
  /** Optional override for the provider registry. When omitted, providers are auto-detected via IAM probing. */
  providerRegistry?: ProviderRegistry;
  /** Test seam: inject S3 client / terraform state paths into run-scoped static IaC options. */
  staticIac?: Pick<InventoryStaticIacOptions, 's3Client' | 'terraformStatePaths'>;
}

export interface DiscoverySummary {
  attempted: number;
  exported: number;
  failed: number;
  skipped: number;
}

export interface ExecutionResult {
  mode: ActionMode;
  discovered: DiscoveredService[];
  resolution?: ResolutionResult;
  exportSummary?: DiscoverySummary;
  outputs: Record<string, string>;
}

export interface ResolutionDependencies {
  providers?: SpecProvider[];
  snsProvider?: SnsResolutionProvider;
  createSnsProvider?: (dependencies: {
    fetchSpecFromUrl: typeof fetchSpecFromUrl;
    remoteFetchPolicy: RemoteFetchPolicy;
    catalogApis: Awaited<ReturnType<typeof detectCatalogApis>>;
    eventBridgeClient?: EventBridgeSchemasSpecClient;
    codeDerivedResolver?: ResolveCodeDerivedContract;
  }) => SnsResolutionProvider;
  eventBridgeClient?: EventBridgeSchemasSpecClient;
  codeDerivedResolver?: ResolveCodeDerivedContract;
  /** Test seam: override remote catalog/SSM/SNS URL fetches. */
  fetchSpecFromUrl?: typeof fetchSpecFromUrl;
  /**
   * Optional shared aggregate byte budget for this resolution.
   * When provided (for example by execute() for default providers), all remote fetches reuse it.
   */
  fetchByteBudget?: FetchByteBudget;
  /** Test seam: override the CloudFormation/Tagging clients used by progressive narrowing. */
  narrowingClients?: { cfnClient?: CloudFormationSpecClient; taggingClient?: TaggingSpecClient };
  /** Test seam: inject S3 client / terraform state paths into run-scoped static IaC options. */
  staticIac?: Pick<InventoryStaticIacOptions, 's3Client' | 'terraformStatePaths'>;
}

interface SnsResolutionProvider {
  probe(): Promise<boolean>;
  listCandidates(): Promise<SpecCandidate[]>;
  resolveContract(candidate: SpecCandidate, resolutionContext?: SnsContractResolutionContext): Promise<SnsContractResult>;
}

const DEFAULT_MODE: ActionMode = 'resolve-one';
const DEFAULT_REPO_ROOT = '.';
const DEFAULT_EXPECTED_GATEWAY_IDS_JSON = '[]';
const DEFAULT_SERVICE_MAPPING_JSON = '{}';
const DEFAULT_OUTPUT_DIR = 'discovered-specs';
const DEFAULT_INCLUDE_V2 = 'true';
const DEFAULT_MAX_CANDIDATES = '50';
const DEFAULT_DRY_RUN = 'false';
const DEFAULT_PREFLIGHT_CHECKS = 'true';
const DEFAULT_PREFLIGHT_PERMISSION_PROBE = 'true';
const DEFAULT_REQUEST_TIMEOUT_MS = '30000';
const DEFAULT_MAX_ATTEMPTS = '3';

function normalizeInputValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function getInput(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const normalizedName = `INPUT_${name.replace(/-/g, '_').toUpperCase()}`;
  const runnerName = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  const normalizedRaw = env[normalizedName];
  const runnerRaw = runnerName === normalizedName ? undefined : env[runnerName];
  const hasNormalized = normalizedRaw !== undefined;
  const hasRunner = runnerRaw !== undefined;

  if (hasNormalized && hasRunner) {
    const normalizedValue = normalizeInputValue(normalizedRaw);
    const runnerValue = normalizeInputValue(runnerRaw);
    if (normalizedValue !== runnerValue) {
      throw new Error(
        `Conflicting values for ${name}: ${normalizedName}=${JSON.stringify(normalizedValue)} vs ${runnerName}=${JSON.stringify(runnerValue)}`
      );
    }
  }

  return normalizeInputValue(hasNormalized ? normalizedRaw : runnerRaw);
}

function parseBoolean(input: string | undefined, inputName: string, fallback = true): boolean {
  if (!input) {
    return fallback;
  }
  const value = input.toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(value)) {
    return true;
  }
  if (['false', '0', 'no', 'n', 'off'].includes(value)) {
    return false;
  }
  throw new Error(`${inputName} must be a boolean-like value, got: ${input}`);
}

function parseBoundedInteger(
  input: string | undefined,
  inputName: string,
  fallback: number,
  min: number,
  max: number
): number {
  if (!input) {
    return fallback;
  }
  if (!/^\d+$/.test(input)) {
    throw new Error(`${inputName} must be a non-negative integer between ${min} and ${max}, got: ${input}`);
  }
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${inputName} must be a non-negative integer between ${min} and ${max}, got: ${input}`);
  }
  return value;
}

function parseMode(input: string | undefined): ActionMode {
  const value = (input ?? '').trim().toLowerCase();
  if (!value) {
    return 'resolve-one';
  }
  if (value === 'resolve-one' || value === 'discover-many') {
    return value;
  }
  throw new Error(`mode must be resolve-one or discover-many, got: ${input}`);
}

function parseServiceMapping(raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON for service-mapping-json: ${detail}`, {
      cause: error
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('service-mapping-json must be a JSON object keyed by gateway id');
  }
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v).trim()]));
}

function parseStringArrayJson(raw: string, inputName: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON for ${inputName}: ${detail}`, {
      cause: error
    });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${inputName} must be a JSON array`);
  }
  return parsed.map((value) => String(value).trim()).filter((value) => value.length > 0);
}

function parseRemoteFetchAllowlistJson(raw: string | undefined): RemoteFetchPolicy {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return DEFAULT_REMOTE_FETCH_POLICY;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON for remote-fetch-allowlist-json: ${detail}`, { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error('remote-fetch-allowlist-json must be a JSON array of exact host/path entries');
  }
  if (parsed.length === 0) {
    return DEFAULT_REMOTE_FETCH_POLICY;
  }
  const allowlist = parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`remote-fetch-allowlist-json[${index}] must be an object with hostname/host and optional pathPrefix/path`);
    }
    const record = entry as Record<string, unknown>;
    const hostname = typeof record.hostname === 'string'
      ? record.hostname
      : typeof record.host === 'string'
        ? record.host
        : undefined;
    if (!hostname?.trim()) {
      throw new Error(`remote-fetch-allowlist-json[${index}] requires a non-empty hostname or host`);
    }
    const pathPrefix = typeof record.pathPrefix === 'string'
      ? record.pathPrefix
      : typeof record.path === 'string'
        ? record.path
        : undefined;
    return {
      hostname: hostname.trim(),
      ...(pathPrefix !== undefined ? { pathPrefix } : {})
    };
  });
  return createRemoteFetchPolicy({ enabled: true, allowlist });
}

function validateRepoRelativeSelector(
  repoRoot: string,
  relativePath: string,
  fieldName: string,
  kind: 'file' | 'directory'
): string {
  const resolvedRoot = path.resolve(repoRoot);
  const absolute = resolvePathWithinRoot(resolvedRoot, relativePath, fieldName);
  const relative = path.relative(resolvedRoot, absolute).replace(/\\/g, '/');
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${fieldName} must stay within repo-root; received ${relativePath}`);
  }
  if (kind === 'directory' && (relative === '' || relative === '.')) {
    return '.';
  }
  return relative || '.';
}

export function resolveInputs(env: NodeJS.ProcessEnv = process.env): ResolvedInputs {
  const mode = parseMode(getInput('mode', env) ?? DEFAULT_MODE);
  const awsRegion =
    getInput('aws-region', env) ??
    normalizeInputValue(env.AWS_REGION) ??
    normalizeInputValue(env.AWS_DEFAULT_REGION) ??
    '';
  if (!awsRegion) {
    throw new Error('aws-region is required (set --aws-region / INPUT_AWS_REGION, or AWS_REGION / AWS_DEFAULT_REGION)');
  }
  const repoRoot =
    getInput('repo-root', env) ??
    normalizeInputValue(env.GITHUB_WORKSPACE) ??
    normalizeInputValue(env.CI_PROJECT_DIR) ??
    normalizeInputValue(env.BITBUCKET_CLONE_DIR) ??
    normalizeInputValue(env.BUILD_SOURCESDIRECTORY) ??
    DEFAULT_REPO_ROOT;
  const gatewayId = getInput('gateway-id', env);
  const expectedServiceName = getInput('expected-service-name', env);
  const expectedGatewayIdsRaw = getInput('expected-gateway-ids-json', env) ?? DEFAULT_EXPECTED_GATEWAY_IDS_JSON;
  const stage = getInput('stage', env);
  const expectedAccountIdRaw = getInput('expected-account-id', env);
  const expectedPartitionRaw = getInput('expected-partition', env);
  const expectedRegionRaw = getInput('expected-region', env);
  const specPathRaw = getInput('spec-path', env);
  const serviceRootRaw = getInput('service-root', env);
  const remoteFetchAllowlistRaw = getInput('remote-fetch-allowlist-json', env);
  const terraformStatePathsRaw = getInput('terraform-state-paths-json', env) ?? '[]';
  const apiFilterRaw = getInput('api-filter', env);
  const serviceMappingRaw = getInput('service-mapping-json', env) ?? DEFAULT_SERVICE_MAPPING_JSON;
  const outputDir = getInput('output-dir', env) ?? DEFAULT_OUTPUT_DIR;
  const includeV2Raw = getInput('include-v2', env) ?? DEFAULT_INCLUDE_V2;
  const maxCandidatesRaw = getInput('max-candidates', env) ?? DEFAULT_MAX_CANDIDATES;
  const dryRunRaw = getInput('dry-run', env) ?? DEFAULT_DRY_RUN;
  const preflightChecksRaw = getInput('preflight-checks', env) ?? DEFAULT_PREFLIGHT_CHECKS;
  const preflightPermissionProbeRaw = getInput('preflight-permission-probe', env) ?? DEFAULT_PREFLIGHT_PERMISSION_PROBE;
  const requestTimeoutMsRaw = getInput('request-timeout-ms', env) ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxAttemptsRaw = getInput('max-attempts', env) ?? DEFAULT_MAX_ATTEMPTS;
  const repoContext = detectRepoContext(
    {
      repoUrl: getInput('repo-url', env),
      repoSlug: getInput('repo-slug', env),
      gitProvider: getInput('git-provider', env),
      ref: getInput('ref', env),
      sha: getInput('sha', env)
    },
    env
  );

  let apiFilter: RegExp | undefined;
  if (apiFilterRaw) {
    try {
      apiFilter = new RegExp(apiFilterRaw);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid regex for api-filter: ${detail}`, {
        cause: error
      });
    }
  }

  const expectedGatewayIds = [gatewayId, ...parseStringArrayJson(expectedGatewayIdsRaw, 'expected-gateway-ids-json')].filter(
    (value): value is string => Boolean(value)
  );

  const specPath = specPathRaw
    ? validateRepoRelativeSelector(repoRoot, specPathRaw, 'spec-path', 'file')
    : undefined;
  const serviceRoot = serviceRootRaw
    ? validateRepoRelativeSelector(repoRoot, serviceRootRaw, 'service-root', 'directory')
    : undefined;

  const expectedAccountId = normalizeExpectedAccountId(expectedAccountIdRaw);
  const expectedPartition = normalizeExpectedPartition(expectedPartitionRaw);
  const expectedRegion = normalizeExpectedRegion(expectedRegionRaw);
  if (expectedRegion && expectedRegion !== awsRegion.toLowerCase()) {
    throw new Error(`AWS region mismatch: expected region ${expectedRegion} does not match aws-region ${awsRegion}. Export aborted.`);
  }

  return {
    mode,
    awsRegion,
    repoRoot,
    repoContext,
    expectedServiceName,
    expectedGatewayIds: [...new Set(expectedGatewayIds)],
    stage,
    expectedAccountId,
    expectedPartition,
    expectedRegion,
    specPath,
    serviceRoot,
    remoteFetchPolicy: parseRemoteFetchAllowlistJson(remoteFetchAllowlistRaw),
    terraformStatePaths: parseStringArrayJson(terraformStatePathsRaw, 'terraform-state-paths-json'),
    apiFilter,
    serviceMapping: parseServiceMapping(serviceMappingRaw),
    outputDir,
    maxCandidates: parseBoundedInteger(maxCandidatesRaw, 'max-candidates', 50, 1, 10000),
    dryRun: parseBoolean(dryRunRaw, 'dry-run', false),
    preflightChecks: parseBoolean(preflightChecksRaw, 'preflight-checks', true),
    preflightPermissionProbe: parseBoolean(preflightPermissionProbeRaw, 'preflight-permission-probe', true),
    requestTimeoutMs: parseBoundedInteger(requestTimeoutMsRaw, 'request-timeout-ms', 30000, 1, 300000),
    maxAttempts: parseBoundedInteger(maxAttemptsRaw, 'max-attempts', 3, 1, 100),
    includeV2: parseBoolean(includeV2Raw, 'include-v2', true)
  };
}

function normalizeExpectedAccountId(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim();
  if (!value) return undefined;
  if (!/^\d{12}$/.test(value)) {
    throw new Error('expected-account-id must be a 12-digit AWS account ID when provided');
  }
  return value;
}

function normalizeExpectedPartition(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return undefined;
  if (!/^[a-z0-9-]+$/.test(value)) {
    throw new Error('expected-partition must be a valid AWS partition identifier when provided');
  }
  return value;
}

function normalizeExpectedRegion(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return undefined;
  if (!/^[a-z0-9-]+$/.test(value)) {
    throw new Error('expected-region must be a valid AWS region identifier when provided');
  }
  return value;
}

export function readActionInputs(inputReader: InputReaderLike): ResolvedInputs {
  const requiredRegion = inputReader.getInput('aws-region').trim();
  return resolveInputs({
    ...process.env,
    INPUT_AWS_REGION: requiredRegion || undefined,
    INPUT_GATEWAY_ID: normalizeInputValue(inputReader.getInput('gateway-id')),
    INPUT_STAGE: normalizeInputValue(inputReader.getInput('stage')),
    INPUT_EXPECTED_ACCOUNT_ID: normalizeInputValue(inputReader.getInput('expected-account-id')),
    INPUT_EXPECTED_PARTITION: normalizeInputValue(inputReader.getInput('expected-partition')),
    INPUT_EXPECTED_REGION: normalizeInputValue(inputReader.getInput('expected-region')),
    INPUT_SPEC_PATH: normalizeInputValue(inputReader.getInput('spec-path')),
    INPUT_SERVICE_ROOT: normalizeInputValue(inputReader.getInput('service-root')),
    INPUT_REMOTE_FETCH_ALLOWLIST_JSON: normalizeInputValue(inputReader.getInput('remote-fetch-allowlist-json')),
    INPUT_TERRAFORM_STATE_PATHS_JSON:
      normalizeInputValue(inputReader.getInput('terraform-state-paths-json'))
      ?? actionContract.inputs['terraform-state-paths-json'].default,
    INPUT_OUTPUT_DIR: normalizeInputValue(inputReader.getInput('output-dir')) ?? actionContract.inputs['output-dir'].default
  });
}

/**
 * Build run-scoped static IaC options with a lazy memoized resolver.
 * The Promise is created only on first consumption; inventory and signals share it.
 * Standalone callers without `resolveStaticIac` still compute directly.
 */
function buildStaticIacOptions(
  inputs: ResolvedInputs,
  overrides: Pick<InventoryStaticIacOptions, 's3Client' | 'terraformStatePaths'> = {}
): InventoryStaticIacOptions {
  const s3Client =
    overrides.s3Client
    ?? new S3SdkClient(inputs.awsRegion, {
      requestTimeoutMs: inputs.requestTimeoutMs,
      maxAttempts: inputs.maxAttempts
    });
  const terraformStatePaths = overrides.terraformStatePaths ?? inputs.terraformStatePaths ?? [];
  let cached: Promise<StaticIacResolution> | undefined;
  const resolveStaticIac = (): Promise<StaticIacResolution> => {
    cached ??= resolveStaticIacCandidates(inputs.repoRoot, {
      s3Client,
      terraformStatePaths
    });
    return cached;
  };
  return { s3Client, terraformStatePaths, resolveStaticIac };
}

/** One shared aggregate byte budget per resolution; preserves caller options aside from budget. */
function withSharedFetchBudget(
  fetchImpl: typeof fetchSpecFromUrl,
  budget: FetchByteBudget
): typeof fetchSpecFromUrl {
  return (url, options = {}) => fetchImpl(url, { ...options, budget });
}

/**
 * After the unconditional exact-tag attempt, prevent broad narrowing from re-issuing
 * exact-contract Resource Groups Tagging queries while still allowing generic tag keys.
 */
function taggingClientWithoutExactRetry(client: TaggingSpecClient): TaggingSpecClient {
  return {
    getResourcesByTag: async (tagKey, tagValues, resourceTypes) => {
      if (tagKey === 'postman:repo') {
        return [];
      }
      return client.getResourcesByTag(tagKey, tagValues, resourceTypes);
    },
    getResourcesByTags: async (filters, resourceTypes) => {
      const keys = new Set(filters.map((filter) => filter.key));
      if (keys.has('GithubOrg') && keys.has('GithubRepo') && filters.length === 2) {
        return [];
      }
      return client.getResourcesByTags(filters, resourceTypes);
    },
    probe: () => client.probe()
  };
}

function resolveLegacyServiceName(gatewayId: string, gatewayName: string, tags: Record<string, string>, serviceMapping: Record<string, string>): string {
  const tagProjectName = (tags['postman:project-name'] ?? '').trim();
  if (tagProjectName) return tagProjectName;
  const tagName = (tags.Name ?? '').trim();
  if (tagName) return tagName;
  const mapped = (serviceMapping[gatewayId] ?? '').trim();
  if (mapped) return mapped;
  return gatewayName;
}

function projectFolderName(projectName: string): string {
  const safe = projectName.trim().replace(/[\\/]+/g, '-').replace(/^\.+$/, 'service').replace(/^\.+|\.+$/g, '');
  return safe || 'service';
}

function toRelativeSpecPath(outputDir: string, folderName: string): string {
  return path.join(outputDir, folderName, 'index.yaml').replace(/\\/g, '/');
}

function userSafeWarning(message: string): string {
  return sanitizeLogMessage(message);
}

export async function defaultWriteSpecFile(outputPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, 'utf8');
}

type DerivedOpenApiMetadata = Pick<
  ResolutionResult,
  'derivedOpenApiPath' | 'derivedOpenApiVersion' | 'derivedOpenApiCompleteness' | 'derivedOpenApiFormat' | 'derivedOpenApiEvidence'
>;

interface ArtifactSidecar {
  filename: string;
  content: string;
}

interface ResolvedArtifactWriteInput {
  repoRoot: string;
  relativeDir: string;
  native?: {
    relativePath: string;
    content: string;
  };
  sidecars?: ArtifactSidecar[];
  derivation?: {
    content: string;
    format: SpecFormat;
    title?: string;
    forceCompleteness?: 'partial';
  };
  dryRun: boolean;
  writeSpecFile(outputPath: string, content: string): Promise<void>;
}

const CANONICAL_DERIVED_OPENAPI_FILENAME = 'openapi.derived.json';
const CANONICAL_DERIVED_OPENAPI_COLLISION_FILENAME = 'openapi.derived-2.json';

function derivedOpenApiFilename(sidecars: ArtifactSidecar[] = []): string {
  return sidecars.some((sidecar) => sidecar.filename === CANONICAL_DERIVED_OPENAPI_FILENAME)
    ? CANONICAL_DERIVED_OPENAPI_COLLISION_FILENAME
    : CANONICAL_DERIVED_OPENAPI_FILENAME;
}

function normalizeDerivedOpenApiJson(derivation: OpenApiDerivationResult): { content: string; evidence: string[] } {
  try {
    const parsed = derivation.format === 'openapi-yaml'
      ? parseYaml(derivation.content)
      : JSON.parse(derivation.content);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('derived OpenAPI document did not parse to an object');
    }
    return { content: `${JSON.stringify(parsed, null, 2)}\n`, evidence: derivation.evidence };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      content: '',
      evidence: [...derivation.evidence, `Skipped derived OpenAPI sidecar because canonical JSON serialization failed: ${detail}`]
    };
  }
}

async function writeResolvedArtifactWithDerivedOpenApi(input: ResolvedArtifactWriteInput): Promise<DerivedOpenApiMetadata> {
  if (!input.dryRun && input.native) {
    const absoluteSpecPath = resolvePathWithinRoot(input.repoRoot, input.native.relativePath, 'output-dir');
    await input.writeSpecFile(absoluteSpecPath, input.native.content);
  }

  if (!input.dryRun) {
    for (const sidecar of input.sidecars ?? []) {
      const relativeSidecarPath = path.join(input.relativeDir, sidecar.filename).replace(/\\/g, '/');
      const absoluteSidecarPath = resolvePathWithinRoot(input.repoRoot, relativeSidecarPath, 'output-dir');
      await input.writeSpecFile(absoluteSidecarPath, sidecar.content);
    }
  }

  if (!input.derivation) {
    return {};
  }

  const derived = deriveOpenApiDocument(input.derivation);
  const completeness = input.derivation.forceCompleteness ?? derived.completeness;
  const normalized = normalizeDerivedOpenApiJson(derived);
  if (!normalized.content) {
    return {
      derivedOpenApiVersion: derived.version,
      derivedOpenApiCompleteness: completeness,
      derivedOpenApiFormat: 'openapi-json',
      derivedOpenApiEvidence: normalized.evidence
    };
  }

  const filename = derivedOpenApiFilename(input.sidecars);
  const relativeDerivedPath = path.join(input.relativeDir, filename).replace(/\\/g, '/');
  if (!input.dryRun) {
    const absoluteDerivedPath = resolvePathWithinRoot(input.repoRoot, relativeDerivedPath, 'output-dir');
    await input.writeSpecFile(absoluteDerivedPath, normalized.content);
  }

  return {
    derivedOpenApiPath: relativeDerivedPath,
    derivedOpenApiVersion: derived.version,
    derivedOpenApiCompleteness: completeness,
    derivedOpenApiFormat: 'openapi-json',
    derivedOpenApiEvidence: input.dryRun
      ? [...normalized.evidence, 'Dry run enabled; skipped derived OpenAPI sidecar write']
      : normalized.evidence
  };
}

/**
 * Apply post-export normalization to API Gateway specs and report any
 * rewrites to the action log. We do this BEFORE the spec is written so
 * the file landing in the repo (and downstream onboarding) is already
 * valid OpenAPI.
 *
 * AWS Gateway can emit duplicate `operationId` values (e.g. method-name-only
 * defaults like `update`, `get`) which the OpenAPI spec forbids and which
 * the bootstrap action rejects with CONTRACT_SPEC_VALIDATION_FAILED.
 * Failing here would be a regression vs the previous behaviour where the
 * raw spec was written and the bootstrap action surfaced the error — so
 * we treat any normalizer error as a no-op and proceed with the original.
 */
function normalizeApiGatewaySpec(
  body: string,
  candidate: { id: string; gatewayType?: GatewayType; name?: string },
  reporter: Pick<ReporterLike, 'info' | 'warning'>
): { content: string; openapiContractAudit?: OpenApiContractAudit; contractWarning?: string } {
  let result: {
    content: string;
    renamed: OperationIdRename[];
    normalized: boolean;
    openapiContractAudit?: OpenApiContractAudit;
  };
  try {
    result = normalizeOpenApiYaml(body, { skipContractAudit: candidate.gatewayType === 'WEBSOCKET' });
  } catch (error) {
    reporter.warning(
      userSafeWarning(`Skipped operationId normalization for ${candidate.id}: ${formatUserSafeError(error)}`)
    );
    return { content: body };
  }
  if (result.normalized) {
    for (const rename of result.renamed) {
      const from = rename.original === null ? '<missing>' : rename.original;
      reporter.info(`operationId normalized: ${candidate.id} ${rename.method.toUpperCase()} ${rename.path} \`${from}\` -> \`${rename.renamed}\``);
    }
  }
  const protocol =
    candidate.gatewayType === 'HTTP' || candidate.gatewayType === 'WEBSOCKET'
      ? candidate.gatewayType
      : 'REST';
  const contractWarning = candidate.gatewayType === 'WEBSOCKET'
    ? AWS_WEBSOCKET_CONTRACT_PARTIAL
    : result.openapiContractAudit
    ? formatOpenApiContractAuditWarning(result.openapiContractAudit, protocol)
    : undefined;
  if (contractWarning) reporter.warning(userSafeWarning(contractWarning));
  return {
    content: result.normalized ? result.content : body,
    openapiContractAudit: result.openapiContractAudit,
    contractWarning
  };
}

async function exportApiGatewaySpecBody(
  aws: AwsGatewayClient,
  candidate: { id: string; gatewayType?: GatewayType },
  stage: string | undefined
): Promise<{ content: string; fallback: boolean; evidence: string[] }> {
  try {
    const content =
      candidate.gatewayType === 'REST'
        ? await aws.exportRestApi(candidate.id, stage ?? '')
        : candidate.gatewayType === 'WEBSOCKET'
          ? await aws.exportWebSocketApi(candidate.id, stage)
          : await aws.exportHttpApi(candidate.id, stage);
    return { content, fallback: false, evidence: [] };
  } catch (error) {
    const parsed = parseAwsError(error);
    if (candidate.gatewayType === 'REST' && aws.exportRestApiFallback && isRestExportFallbackError(parsed)) {
      const content = await aws.exportRestApiFallback(candidate.id, stage);
      return {
        content,
        fallback: true,
        evidence: [
          `REST API Gateway fallback synthesized partial OpenAPI 3.0 spec for ${candidate.id} from API Gateway models and methods after native export failed`,
          formatUserSafeError(error)
        ]
      };
    }
    throw error;
  }
}

async function selectStage(
  aws: AwsGatewayClient,
  candidate: GatewayCandidate,
  preferredStage: string | undefined,
  preferLatestConfiguration = false,
  trustedEvidence?: TrustedStageEvidence
): Promise<ResolutionStageSelection> {
  return resolveStageSelection(aws, candidate, preferredStage, preferLatestConfiguration, trustedEvidence);
}

function filterCandidates(restApis: RestApiSummary[], httpApis: HttpApiSummary[], includeV2: boolean, apiFilter?: RegExp): GatewayCandidate[] {
  const rest: GatewayCandidate[] = restApis.map((api) => ({ id: api.id, name: api.name, gatewayType: 'REST' }));
  const http: GatewayCandidate[] = includeV2
    ? httpApis
        .filter((api) => !api.protocolType || api.protocolType === 'HTTP' || api.protocolType === 'WEBSOCKET')
        .map((api) => ({
          id: api.id,
          name: api.name,
          gatewayType: api.protocolType === 'WEBSOCKET' ? 'WEBSOCKET' as GatewayType : 'HTTP' as GatewayType
        }))
    : [];
  const all = [...rest, ...http];
  return apiFilter ? all.filter((api) => apiFilter.test(api.name)) : all;
}

function uniqueGatewayCandidates(candidates: GatewayCandidate[]): GatewayCandidate[] {
  const seen = new Set<string>();
  const unique: GatewayCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    unique.push(candidate);
  }
  return unique;
}

async function lookupCandidatesByIds(inputs: ResolvedInputs, awsClient: AwsGatewayClient, actionCore: Pick<ReporterLike, 'warning'>): Promise<GatewayCandidate[]> {
  const candidates: GatewayCandidate[] = [];
  for (const gatewayId of inputs.expectedGatewayIds) {
    let found = false;
    try {
      const restApi = await awsClient.getRestApi(gatewayId);
      if (restApi) {
        candidates.push({ id: restApi.id, name: restApi.name, gatewayType: 'REST' });
        found = true;
      }
    } catch (error) {
      actionCore.warning(userSafeWarning(`Failed direct REST lookup for ${gatewayId}: ${formatUserSafeError(error)}`));
    }
    if (!found && inputs.includeV2) {
      try {
        const httpApi = await awsClient.getHttpApi(gatewayId);
        if (httpApi && (!httpApi.protocolType || httpApi.protocolType === 'HTTP' || httpApi.protocolType === 'WEBSOCKET')) {
          const gwType: GatewayType = httpApi.protocolType === 'WEBSOCKET' ? 'WEBSOCKET' : 'HTTP';
          candidates.push({ id: httpApi.id, name: httpApi.name, gatewayType: gwType });
          found = true;
        } else if (httpApi) {
          actionCore.warning(userSafeWarning(`Skipping v2 API ${gatewayId} because protocol type ${httpApi.protocolType} is not supported`));
          found = true;
        }
      } catch (error) {
        actionCore.warning(userSafeWarning(`Failed direct HTTP lookup for ${gatewayId}: ${formatUserSafeError(error)}`));
      }
    }
    if (!found) {
      actionCore.warning(userSafeWarning(`Expected gateway ID ${gatewayId} was not found in ${inputs.awsRegion}`));
    }
  }
  return candidates;
}

async function safeListRestApis(
  awsClient: AwsGatewayClient,
  actionCore: Pick<ReporterLike, 'warning'>,
  region: string
): Promise<RestApiSummary[]> {
  try {
    return await awsClient.listRestApis();
  } catch (error) {
    actionCore.warning(
      userSafeWarning(
        `Attempted REST API enumeration in region ${region} failed: ${formatUserSafeError(error)}. Continuing without REST candidates. Grant API Gateway read permission or use the correct role.`
      )
    );
    return [];
  }
}

async function safeListHttpApis(inputs: ResolvedInputs, awsClient: AwsGatewayClient, actionCore: Pick<ReporterLike, 'warning'>): Promise<HttpApiSummary[]> {
  if (!inputs.includeV2) {
    return [];
  }
  try {
    return await awsClient.listHttpApis();
  } catch (error) {
    actionCore.warning(
      userSafeWarning(
        `Attempted HTTP API enumeration in region ${inputs.awsRegion} failed: ${formatUserSafeError(error)}. Continuing without HTTP candidates. Grant API Gateway read permission or use the correct role.`
      )
    );
    return [];
  }
}

async function lookupCandidatesByCustomDomains(
  hints: string[],
  awsClient: AwsGatewayClient,
  actionCore: Pick<ReporterLike, 'warning'>
): Promise<{ candidates: GatewayCandidate[]; ids: string[]; evidence: string[] }> {
  const normalizedHints = new Set(hints.map((hint) => hint.toLowerCase()).filter(Boolean));
  if (normalizedHints.size === 0) {
    return { candidates: [], ids: [], evidence: [] };
  }

  const mappings: GatewayDomainMapping[] = [];
  if (awsClient.listRestDomainMappings) {
    try {
      mappings.push(...await awsClient.listRestDomainMappings());
    } catch (error) {
      actionCore.warning(userSafeWarning(`Failed reading API Gateway REST custom domains: ${formatUserSafeError(error)}`));
    }
  }
  if (awsClient.listHttpDomainMappings) {
    try {
      mappings.push(...await awsClient.listHttpDomainMappings());
    } catch (error) {
      actionCore.warning(userSafeWarning(`Failed reading API Gateway HTTP custom domains: ${formatUserSafeError(error)}`));
    }
  }

  const matched = mappings.filter((mapping) => normalizedHints.has(mapping.domainName.toLowerCase()));
  const candidates: GatewayCandidate[] = [];
  const evidence: string[] = [];
  for (const mapping of matched) {
    if (mapping.gatewayType === 'REST') {
      const api = await awsClient.getRestApi(mapping.apiId).catch(() => undefined);
      candidates.push({ id: mapping.apiId, name: api?.name ?? mapping.domainName, gatewayType: 'REST' });
    } else {
      const api = await awsClient.getHttpApi(mapping.apiId).catch(() => undefined);
      candidates.push({
        id: mapping.apiId,
        name: api?.name ?? mapping.domainName,
        gatewayType: mapping.gatewayType === 'WEBSOCKET' ? 'WEBSOCKET' : 'HTTP'
      });
    }
    evidence.push(`Matched API Gateway custom domain ${mapping.domainName} to API ${mapping.apiId}`);
  }

  return {
    candidates,
    ids: [...new Set(candidates.map((candidate) => candidate.id))],
    evidence
  };
}

function inferFallbackServiceName(inputs: ResolvedInputs): string | undefined {
  return inputs.expectedServiceName ?? inputs.repoContext.repoSlug?.split('/').pop()?.trim() ?? inputs.repoContext.repoUrl?.split('/').pop()?.trim();
}

function inferFormatFromContent(relativePath: string, content: string): SpecFormat | undefined {
  return classifySpecContent(content, { pathHint: relativePath })?.format;
}

function classifyCatalogBytes(
  content: string,
  declaredType: string | undefined,
  pathHint?: string
): { format: SpecFormat; filename: string } | undefined {
  const classified = declaredType?.trim()
    ? classifyWithDeclaredFormat(content, declaredType, { pathHint })
    : classifySpecContent(content, { pathHint });
  if (!classified) return undefined;
  return {
    format: classified.format,
    filename: filenameForFormat(classified.format, pathHint)
  };
}

function normalizeSnsName(value: string): string {
  return value.trim().toLowerCase().replace(/\.fifo$/i, '');
}

function scoreSnsCandidate(candidate: SpecCandidate, serviceHints: string[]): number {
  const candidateName = normalizeSnsName(candidate.name);
  const tagValues = Object.values(candidate.tags).map((value) => normalizeSnsName(value));
  const projectTag = normalizeSnsName(candidate.tags['postman:project-name'] ?? '');
  let score = 0;

  for (const rawHint of serviceHints) {
    const hint = normalizeSnsName(rawHint);
    if (!hint) {
      continue;
    }
    if (candidateName === hint) {
      score += 60;
      continue;
    }
    if (candidateName.includes(hint) || hint.includes(candidateName)) {
      score += 40;
    }
    if (projectTag === hint) {
      score += 50;
    } else if (tagValues.some((value) => value.includes(hint))) {
      score += 20;
    }
  }

  return score;
}

function sortSnsCandidates(candidates: SpecCandidate[], serviceHints: string[]): SpecCandidate[] {
  return [...candidates].sort((left, right) => {
    const scoreDiff = scoreSnsCandidate(right, serviceHints) - scoreSnsCandidate(left, serviceHints);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return left.name.localeCompare(right.name);
  });
}

interface ProviderResolutionCandidate {
  provider: SpecProvider;
  candidate: SpecCandidate;
  confidence: number;
  sourceType: SourceType;
  evidence: string[];
}

function sourceTypeForProvider(providerType: ProviderType): SourceType | undefined {
  switch (providerType) {
    case 'appsync':
      return 'appsync-schema';
    case 'appsync-events':
      return 'appsync-event-api';
    case 'eventbridge-schemas':
      return 'eventbridge-schema';
    case 'eventbridge':
      return 'eventbridge-surface';
    case 'cloudformation':
      return 'cfn-embedded';
    case 'glue':
      return 'glue-schema';
    case 'bedrock-action-group':
      return 'bedrock-action-group';
    case 'alb-listener-rule':
      return 'alb-listener-rule';
    case 'ssm':
      return 'ssm-registry';
    case 'lambda-url':
      return 'lambda-url-export';
    case 'lambda-event-source':
      return 'lambda-event-source';
    case 'verified-permissions':
      return 'verified-permissions-schema';
    case 'step-functions':
      return 'step-functions-asl';
    case 'api-gateway':
      return 'gateway-export';
    case 'sns':
      return 'sns-contract';
  }
}

function scoreProviderCandidate(
  candidate: SpecCandidate,
  provider: SpecProvider,
  signals: Awaited<ReturnType<typeof collectRepoSignals>>
): ProviderResolutionCandidate | undefined {
  const sourceType = sourceTypeForProvider(provider.type);
  if (!sourceType || provider.type === 'api-gateway' || provider.type === 'sns') {
    return undefined;
  }

  const evidence = [...signals.evidence, ...candidate.evidence];
  const serviceHints = signals.serviceHints.map((hint) => hint.toLowerCase()).filter(Boolean);
  const candidateName = candidate.name.toLowerCase();
  const candidateId = candidate.id.toLowerCase();
  const tagValues = Object.values(candidate.tags).map((value) => value.toLowerCase());
  let confidence = 35;

  if (signals.providerHints?.includes(provider.type)) {
    confidence += 25;
    evidence.push(`Repo signals include ${provider.type} provider hint`);
  }

  for (const hint of serviceHints) {
    if (candidateName === hint || candidateId === hint) {
      confidence += 45;
      evidence.push(`Candidate ${candidate.id} exactly matches service hint ${hint}`);
    } else if (candidateName.includes(hint) || candidateId.includes(hint) || hint.includes(candidateName)) {
      confidence += 25;
      evidence.push(`Candidate ${candidate.id} matches service hint ${hint}`);
    }
    if (tagValues.some((tag) => tag.includes(hint))) {
      confidence += 25;
      evidence.push(`Candidate ${candidate.id} tags match service hint ${hint}`);
    }
  }

  if (signals.explicitGatewayIdHints.includes(candidate.id)) {
    confidence += 50;
    evidence.push(`Candidate ${candidate.id} matched explicit id hint`);
  }

  if (provider.type === 'lambda-url') {
    const functionUrlHost = hostnameFromUrl(candidate.meta.functionUrl);
    if (functionUrlHost && (signals.lambdaUrlHints ?? []).some((hint) => hint.toLowerCase() === functionUrlHost)) {
      confidence += 60;
      evidence.push(`Candidate ${candidate.id} matched Lambda Function URL host hint ${functionUrlHost}`);
    }
  }

  return {
    provider,
    candidate,
    confidence: Math.min(confidence, 100),
    sourceType,
    evidence
  };
}

function hostnameFromUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

async function collectProviderResolutionCandidates(
  providers: SpecProvider[],
  signals: Awaited<ReturnType<typeof collectRepoSignals>>,
  actionCore: Pick<ReporterLike, 'warning'>
): Promise<ProviderResolutionCandidate[]> {
  const results: ProviderResolutionCandidate[] = [];
  for (const provider of providers.filter((item) => item.type !== 'api-gateway' && item.type !== 'sns')) {
    let candidates: SpecCandidate[];
    try {
      candidates = await provider.listCandidates();
    } catch (error) {
      actionCore.warning(userSafeWarning(`Failed listing candidates from ${provider.type}: ${formatUserSafeError(error)}`));
      continue;
    }
    for (const candidate of candidates) {
      const scored = scoreProviderCandidate(candidate, provider, signals);
      if (scored) {
        results.push(scored);
      }
    }
  }
  return results.sort(
    (left, right) =>
      right.confidence - left.confidence ||
      left.provider.type.localeCompare(right.provider.type) ||
      left.candidate.id.localeCompare(right.candidate.id)
  );
}

function shouldPreferProviderCandidate(candidate: ProviderResolutionCandidate | undefined, selectedSource: ResolutionResult): boolean {
  if (!candidate || candidate.confidence < 40) return false;
  if (selectedSource.sourceType === 'repo-spec') return false;
  if (selectedSource.status === 'unresolved') return true;
  return candidate.confidence > selectedSource.confidence;
}

function serviceNameForProviderCandidate(candidate: SpecCandidate): string {
  return (candidate.tags['postman:project-name'] ?? '').trim() || (candidate.tags.Name ?? '').trim() || candidate.name;
}

async function exportProviderResolutionCandidate(
  resolved: ProviderResolutionCandidate,
  inputs: ResolvedInputs,
  writeSpecFile: (outputPath: string, content: string) => Promise<void>
): Promise<ResolutionResult> {
  const serviceName = serviceNameForProviderCandidate(resolved.candidate);
  const result = await resolved.provider.exportSpec(resolved.candidate, { stage: inputs.stage, dryRun: inputs.dryRun });
  const relativeProviderDir = path.join(inputs.outputDir, projectFolderName(serviceName || 'service')).replace(/\\/g, '/');
  const relativeProviderPath = path.join(relativeProviderDir, result.filename).replace(/\\/g, '/');
  const metadataSidecar = result.sidecars?.find((sidecar) => sidecar.filename === 'sns-resolution-metadata.json');
  const relativeMetadataPath = metadataSidecar ? path.join(relativeProviderDir, metadataSidecar.filename).replace(/\\/g, '/') : undefined;
  const derivedOpenApi = await writeResolvedArtifactWithDerivedOpenApi({
    repoRoot: inputs.repoRoot,
    relativeDir: relativeProviderDir,
    native: { relativePath: relativeProviderPath, content: result.content },
    sidecars: result.sidecars,
    derivation: {
      content: result.content,
      format: result.format,
      title: serviceName,
      forceCompleteness: result.derivedOpenApiCompleteness === 'partial' || resolved.provider.type === 'lambda-url' ? 'partial' : undefined
    },
    dryRun: inputs.dryRun,
    writeSpecFile
  });

  const gatewayType = (resolved.candidate.meta.gatewayType ?? 'REST') as GatewayType;
  const providerProvenance = result.provenance
    ? buildDeployedSourceProvenance({
        inputs,
        apiId: resolved.candidate.id,
        gatewayType: resolved.provider.type === 'api-gateway' ? gatewayType : undefined,
        content: result.content,
        sourceTier: resolved.provider.type,
        base: result.provenance
      })
    : result.provenance;

  return {
    status: 'resolved',
    sourceType: resolved.sourceType,
    serviceName,
    confidence: resolved.confidence,
    specPath: relativeProviderPath,
    gatewayId: resolved.candidate.id,
    gatewayType,
    providerType: resolved.provider.type,
    specFormat: result.format,
    metadataPath: relativeMetadataPath,
    stage: result.stage,
    provenance: providerProvenance ? sanitizeJsonValue(providerProvenance) : undefined,
    openapiContractAudit: inputs.dryRun ? undefined : result.openapiContractAudit,
    ...derivedOpenApi,
    evidence: [...resolved.evidence, ...result.evidence, ...(inputs.dryRun ? ['Dry run enabled; skipped provider spec file write'] : [])]
  };
}

function collectSnsEventBridgeBridgeEvidence(signals: Awaited<ReturnType<typeof collectRepoSignals>>): string[] {
  const providerHints = signals.providerHints ?? [];
  const hasSnsHint = providerHints.includes('sns');
  const hasEventBridgeHint = providerHints.includes('eventbridge-schemas');
  if (!hasSnsHint || !hasEventBridgeHint) {
    return [];
  }

  return signals.evidence.filter((entry) => /sns.*eventbridge|eventbridge.*sns|bridge pattern/i.test(entry));
}

function configurationModeForGateway(
  gatewayType: GatewayType,
  mode: 'deployed-stage' | 'latest-configuration'
): ConfigurationMode {
  if (gatewayType === 'WEBSOCKET') return 'partial-control-plane';
  return mode;
}

async function collectTrustedStageEvidence(
  aws: AwsGatewayClient,
  candidate: GatewayCandidate
): Promise<TrustedStageEvidence | undefined> {
  const mappings: GatewayDomainMapping[] = [];
  try {
    if (candidate.gatewayType === 'REST' && aws.listRestDomainMappings) {
      mappings.push(...(await aws.listRestDomainMappings()));
    }
    if ((candidate.gatewayType === 'HTTP' || candidate.gatewayType === 'WEBSOCKET') && aws.listHttpDomainMappings) {
      mappings.push(...(await aws.listHttpDomainMappings()));
    }
  } catch {
    return undefined;
  }
  const linkedStages = mappings
    .filter((mapping) => mapping.apiId === candidate.id)
    .map((mapping) => (mapping.stage ?? '').trim())
    .filter((stage) => stage.length > 0);
  const unique = [...new Set(linkedStages)];
  if (unique.length === 1) {
    return { stageName: unique[0], source: 'custom-domain-mapping' };
  }
  return undefined;
}

function stageNames(stages: GatewayStageSummary[]): string[] {
  return stages.map((stage) => stage.stageName);
}

/** Accept StageSummary objects or legacy string[] stubs without dropping singleton/explicit evidence. */
function normalizeStageList(raw: unknown): GatewayStageSummary[] {
  if (!Array.isArray(raw)) return [];
  const normalized: GatewayStageSummary[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const stageName = item.trim();
      if (stageName) normalized.push({ stageName });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const stageName = String(record.stageName ?? record.StageName ?? '').trim();
    if (!stageName) continue;
    const summary: GatewayStageSummary = { stageName };
    const deploymentId = String(record.deploymentId ?? record.DeploymentId ?? '').trim();
    if (deploymentId) summary.deploymentId = deploymentId;
    if (typeof record.autoDeploy === 'boolean') summary.autoDeploy = record.autoDeploy;
    else if (typeof record.AutoDeploy === 'boolean') summary.autoDeploy = record.AutoDeploy;
    if (typeof record.apiGatewayManaged === 'boolean') summary.apiGatewayManaged = record.apiGatewayManaged;
    else if (typeof record.ApiGatewayManaged === 'boolean') summary.apiGatewayManaged = record.ApiGatewayManaged;
    normalized.push(summary);
  }
  return normalized;
}

async function resolveStageSelection(
  aws: AwsGatewayClient,
  candidate: GatewayCandidate,
  preferredStage: string | undefined,
  preferLatestConfiguration = false,
  trustedEvidence?: TrustedStageEvidence
): Promise<ResolutionStageSelection> {
  const stages = normalizeStageList(
    candidate.gatewayType === 'REST' ? await aws.listRestStages(candidate.id) : await aws.listHttpStages(candidate.id)
  );

  if (preferredStage) {
    const match = stages.find((stage) => stage.stageName === preferredStage);
    if (match) {
      return {
        stage: match.stageName,
        deploymentId: match.deploymentId,
        configurationMode: configurationModeForGateway(candidate.gatewayType, 'deployed-stage'),
        evidence: [`Using explicitly requested stage ${preferredStage}`]
      };
    }
    return {
      evidence: [],
      error: `Requested stage ${preferredStage} was not found for ${candidate.gatewayType} API ${candidate.id}`
    };
  }

  if (preferLatestConfiguration && candidate.gatewayType === 'HTTP') {
    return {
      useLatestConfig: true,
      configurationMode: 'latest-configuration',
      evidence: ['Explicit HTTP gateway without stage; exporting latest HTTP API configuration (latest-configuration mode)']
    };
  }

  const evidence = trustedEvidence ?? (await collectTrustedStageEvidence(aws, candidate));
  if (evidence?.stageName) {
    const matches = stages.filter((stage) => stage.stageName === evidence.stageName);
    if (matches.length === 1) {
      const match = matches[0];
      return {
        stage: match.stageName,
        deploymentId: match.deploymentId,
        configurationMode: configurationModeForGateway(candidate.gatewayType, 'deployed-stage'),
        evidence: [
          `Using trusted stage evidence ${match.stageName}${evidence.source ? ` from ${evidence.source}` : ''}`
        ]
      };
    }
  }
  if (evidence?.deploymentId) {
    const matches = stages.filter((stage) => stage.deploymentId === evidence.deploymentId);
    if (matches.length === 1) {
      const match = matches[0];
      return {
        stage: match.stageName,
        deploymentId: match.deploymentId,
        configurationMode: configurationModeForGateway(candidate.gatewayType, 'deployed-stage'),
        evidence: [
          `Using trusted deployment evidence ${evidence.deploymentId}${evidence.source ? ` from ${evidence.source}` : ''}`
        ]
      };
    }
  }

  if (stages.length === 0) {
    if (candidate.gatewayType === 'HTTP') {
      return {
        useLatestConfig: true,
        configurationMode: 'latest-configuration',
        evidence: [
          'No deployed stage found; exporting latest HTTP API configuration (latest-configuration mode, distinct from deployed-stage truth)'
        ]
      };
    }
    if (candidate.gatewayType === 'WEBSOCKET') {
      return {
        useLatestConfig: true,
        configurationMode: 'partial-control-plane',
        evidence: [
          'No deployed stage found; synthesizing partial WebSocket control-plane reconstruction'
        ]
      };
    }
    return { evidence: [], error: `No stages were found for REST API ${candidate.id}` };
  }

  if (stages.length === 1) {
    const only = stages[0];
    return {
      stage: only.stageName,
      deploymentId: only.deploymentId,
      configurationMode: configurationModeForGateway(candidate.gatewayType, 'deployed-stage'),
      evidence: [`Auto-selected only available stage ${only.stageName}`]
    };
  }

  if (candidate.gatewayType === 'HTTP') {
    const defaultAutoDeploy = stages.filter(
      (stage) => stage.stageName === '$default' && stage.autoDeploy === true
    );
    const otherAutoDeploy = stages.filter(
      (stage) => stage.stageName !== '$default' && stage.autoDeploy === true
    );
    if (defaultAutoDeploy.length === 1 && otherAutoDeploy.length === 0) {
      const only = defaultAutoDeploy[0];
      return {
        stage: only.stageName,
        deploymentId: only.deploymentId,
        configurationMode: 'deployed-stage',
        evidence: ['Auto-selected uniquely evidenced HTTP $default auto-deploy stage']
      };
    }
  }

  const ranked = [...stageNames(stages)].sort((left, right) => left.localeCompare(right));
  return {
    rankedStages: ranked,
    evidence: [],
    error: `Multiple stages found without uniquely evidenced selection; manual review required: ${ranked.join(', ')}`
  };
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function gatewayApiArn(partition: string | undefined, region: string, gatewayType: GatewayType, apiId: string): string {
  const resolvedPartition = partition || 'aws';
  if (gatewayType === 'REST') {
    return `arn:${resolvedPartition}:apigateway:${region}::/restapis/${apiId}`;
  }
  return `arn:${resolvedPartition}:apigateway:${region}::/apis/${apiId}`;
}

function buildGatewayExportOptions(
  gatewayType: GatewayType,
  stage: string | undefined,
  useLatestConfig: boolean | undefined
): Record<string, unknown> {
  if (gatewayType === 'REST') {
    return { exportType: 'oas30', stageName: stage, extensions: 'apigateway' };
  }
  if (gatewayType === 'WEBSOCKET') {
    return {
      reconstruction: 'partial-control-plane',
      stageName: stage,
      useLatestConfig: Boolean(useLatestConfig || !stage)
    };
  }
  return {
    includeExtensions: Boolean(stage),
    stageName: stage,
    configurationMode: stage ? 'deployed-stage' : 'latest-configuration'
  };
}

function buildDeployedSourceProvenance(input: {
  inputs: ResolvedInputs;
  identity?: { accountId?: string; arn?: string; partition?: string };
  gatewayType?: GatewayType;
  apiId?: string;
  stageSelection?: ResolutionStageSelection;
  content?: string;
  sourceTier?: string;
  sourceTagContract?: string;
  providerProbes?: ResolutionResult['providerProbes'];
  truncation?: DeployedSourceProvenance['truncation'];
  base?: DeployedSourceProvenance;
}): DeployedSourceProvenance {
  const partition = input.identity?.partition ?? partitionFromArn(input.identity?.arn) ?? input.base?.partition;
  const provenance: DeployedSourceProvenance = {
    ...input.base,
    partition,
    accountIndicator: accountIndicatorFromAccountId(input.identity?.accountId) ?? input.base?.accountIndicator,
    region: input.inputs.awsRegion,
    queryTimestamp: input.base?.queryTimestamp ?? new Date().toISOString()
  };
  if (input.apiId) {
    provenance.apiId = input.apiId;
    if (input.gatewayType) {
      provenance.apiArn = gatewayApiArn(partition, input.inputs.awsRegion, input.gatewayType, input.apiId);
      provenance.protocol = input.gatewayType;
    }
  }
  if (input.stageSelection?.configurationMode) {
    provenance.configurationMode = input.stageSelection.configurationMode;
  }
  if (input.stageSelection?.stage) {
    provenance.stage = input.stageSelection.stage;
  }
  if (input.stageSelection?.deploymentId) {
    provenance.deploymentId = input.stageSelection.deploymentId;
  }
  if (input.gatewayType) {
    provenance.exportOptions = buildGatewayExportOptions(
      input.gatewayType,
      input.stageSelection?.stage,
      input.stageSelection?.useLatestConfig
    );
  }
  if (input.sourceTier) provenance.sourceTier = input.sourceTier;
  if (input.sourceTagContract) provenance.sourceTagContract = input.sourceTagContract;
  if (input.content) provenance.artifactHash = sha256Hex(input.content);
  if (input.providerProbes) provenance.providerProbes = input.providerProbes;
  if (input.truncation) provenance.truncation = input.truncation;
  return provenance;
}

function toManualReviewResult(base: ResolutionResult, extraEvidence: string[]): ResolutionResult {
  return { ...base, status: 'unresolved', sourceType: 'manual-review', evidence: [...base.evidence, ...extraEvidence] };
}

function isKnownRestExportLimitation(message: string): boolean {
  const lowered = message.toLowerCase();
  return lowered.includes('non-json body models') || lowered.includes('json body models are not found');
}

function isManualReviewExportError(error: { name?: string; message: string }): boolean {
  return error.name === 'BadRequestException' || isKnownRestExportLimitation(error.message);
}

function isRestExportFallbackError(error: { name?: string; message: string }): boolean {
  return error.name === 'BadRequestException' || isKnownRestExportLimitation(error.message);
}

function shouldResolveCallerIdentity(inputs: ResolvedInputs): boolean {
  return inputs.preflightChecks || Boolean(inputs.expectedAccountId) || Boolean(inputs.expectedPartition);
}

async function runPreflight(inputs: ResolvedInputs, dependencies: DiscoveryDependencies): Promise<void> {
  if (!shouldResolveCallerIdentity(inputs)) {
    dependencies.core.info('Preflight checks skipped by configuration');
    return;
  }
  let identity: Awaited<ReturnType<typeof dependencies.aws.getCallerIdentity>>;
  try {
    identity = await dependencies.aws.getCallerIdentity();
  } catch (error) {
    const parsed = parseAwsError(error);
    const name = parsed.name ?? '';
    const cause = formatUserSafeError(error);
    if (name === 'ExpiredTokenException' || name === 'ExpiredToken') {
      throw new Error(
        userSafeWarning(
          `Attempted sts:GetCallerIdentity in region ${inputs.awsRegion} failed: ${cause}. Refresh the role/session (re-assume the role or rotate the access keys) and re-run.`
        ),
        { cause: error }
      );
    }
    if (name === 'AccessDeniedException' || name === 'AccessDenied') {
      throw new Error(
        userSafeWarning(
          `Attempted sts:GetCallerIdentity in region ${inputs.awsRegion} failed: ${cause}. Credentials are malformed or the principal is denied STS; check the role/keys and trust policy.`
        ),
        { cause: error }
      );
    }
    if (name === 'CredentialsProviderError') {
      throw new Error(
        userSafeWarning(
          `Attempted sts:GetCallerIdentity in region ${inputs.awsRegion} failed: ${cause}. Configure credentials for this runner via the provider chain (env, profile, OIDC, instance role).`
        ),
        { cause: error }
      );
    }
    throw new Error(
      userSafeWarning(
        `Attempted sts:GetCallerIdentity in region ${inputs.awsRegion} failed: ${cause}. Verify AWS credentials, region, and IAM permission for sts:GetCallerIdentity, then re-run.`
      ),
      { cause: error }
    );
  }
  const partition = identity.partition ?? partitionFromArn(identity.arn);
  if (inputs.expectedAccountId) {
    const actual = (identity.accountId ?? '').trim();
    if (actual !== inputs.expectedAccountId) {
      throw new Error(
        userSafeWarning(
          `AWS account mismatch: expected account ${accountIndicatorFromAccountId(inputs.expectedAccountId) ?? '[redacted-account-id]'} does not match caller identity ${accountIndicatorFromAccountId(actual) ?? '[redacted-account-id]'}. Export aborted.`
        )
      );
    }
  }
  if (inputs.expectedPartition) {
    if (!partition || partition !== inputs.expectedPartition) {
      throw new Error(
        userSafeWarning(
          `AWS partition mismatch: expected partition ${inputs.expectedPartition} does not match caller identity partition ${partition ?? 'unknown'}. Export aborted.`
        )
      );
    }
  }
  if (inputs.preflightPermissionProbe) {
    try {
      await dependencies.aws.probeApiGatewayReadAccess();
    } catch (error) {
      dependencies.core.warning(
        userSafeWarning(
          `Attempted API Gateway REST read preflight in region ${inputs.awsRegion} failed: ${formatUserSafeError(error)}. REST discovery/export may be unavailable while other providers continue. Grant API Gateway read permission or use the correct role.`
        )
      );
    }
  }
  const accountIndicator = accountIndicatorFromAccountId(identity.accountId) ?? '***unknown';
  dependencies.core.info(
    `Preflight OK: region=${inputs.awsRegion}, partition=${partition ?? 'unknown'}, account=${accountIndicator}, identity=${identity.arn ? 'available' : 'unknown'}`
  );
}

export async function runDiscovery(inputs: ResolvedInputs, dependencies: DiscoveryDependencies): Promise<{ discovered: DiscoveredService[]; summary: DiscoverySummary }> {
  const restStart = Date.now();
  const restApis = await dependencies.core.group('Discover REST APIs', async () => {
    const items = await safeListRestApis(dependencies.aws, dependencies.core, inputs.awsRegion);
    dependencies.core.info(`Found ${items.length} REST API(s) in ${Date.now() - restStart}ms`);
    return items;
  });
  const httpStart = Date.now();
  const httpApis = await dependencies.core.group('Discover HTTP APIs', async () => {
    if (!inputs.includeV2) {
      dependencies.core.info('Skipping HTTP API discovery because include-v2=false');
      return [] as HttpApiSummary[];
    }
    const items = await safeListHttpApis(inputs, dependencies.aws, dependencies.core);
    dependencies.core.info(`Found ${items.length} HTTP API(s) in ${Date.now() - httpStart}ms`);
    return items;
  });

  let selectedCandidates = filterCandidates(restApis, httpApis, inputs.includeV2, inputs.apiFilter);
  if (inputs.maxCandidates > 0 && selectedCandidates.length > inputs.maxCandidates) {
    dependencies.core.warning(
      userSafeWarning(`${selectedCandidates.length} API Gateway candidates exceed limit (${inputs.maxCandidates}). Truncating to first ${inputs.maxCandidates}. Use api-filter or gateway-id to narrow.`)
    );
    selectedCandidates = selectedCandidates.slice(0, inputs.maxCandidates);
  }
  dependencies.core.info(`Export candidate count after filters: ${selectedCandidates.length}`);

  const discovered: DiscoveredService[] = [];
  const summary: DiscoverySummary = { attempted: selectedCandidates.length, exported: 0, failed: 0, skipped: 0 };
  const slugUsage = new Map<string, number>();
  const resolvedRoot = path.resolve(inputs.repoRoot);
  const resolvedOutputDir = resolvePathWithinRoot(resolvedRoot, inputs.outputDir, 'output-dir');

  let callerIdentity: Awaited<ReturnType<AwsGatewayClient['getCallerIdentity']>> | undefined;
  if (shouldResolveCallerIdentity(inputs)) {
    try {
      callerIdentity = await dependencies.aws.getCallerIdentity();
    } catch {
      callerIdentity = undefined;
    }
  }

  await dependencies.core.group('Export OpenAPI specs', async () => {
    for (const candidate of selectedCandidates) {
      try {
        const stageSelection = await selectStage(
          dependencies.aws,
          candidate,
          inputs.stage,
          inputs.expectedGatewayIds.includes(candidate.id)
        );
        if (stageSelection.error) {
          summary.skipped += 1;
          dependencies.core.warning(
            userSafeWarning(
              `Skipping ${candidate.gatewayType} API ${candidate.id} (${candidate.name}): ${stageSelection.error}`
            )
          );
          continue;
        }
        if (!stageSelection.stage && !stageSelection.useLatestConfig && candidate.gatewayType !== 'WEBSOCKET') {
          summary.skipped += 1;
          dependencies.core.warning(
            userSafeWarning(
              `Skipping ${candidate.gatewayType} API ${candidate.id} (${candidate.name}) because no stage is available`
            )
          );
          continue;
        }

        const tags = candidate.gatewayType === 'REST' ? await dependencies.aws.getRestTags(candidate.id) : await dependencies.aws.getHttpTags(candidate.id);
        const serviceName = resolveLegacyServiceName(candidate.id, candidate.name, tags, inputs.serviceMapping);
        const baseFolder = projectFolderName(serviceName);
        const next = (slugUsage.get(baseFolder) ?? 0) + 1;
        slugUsage.set(baseFolder, next);
        const folderName = next === 1 ? baseFolder : `${baseFolder}-${candidate.id}`;

        const relativeSpecPath = toRelativeSpecPath(path.relative(resolvedRoot, resolvedOutputDir), folderName);
        if (inputs.dryRun) {
          summary.skipped += 1;
          dependencies.core.info(`Dry run: skipping export for ${candidate.gatewayType} API ${candidate.id} (${candidate.name})`);
          continue;
        }

        const exportedStage = stageSelection.useLatestConfig ? undefined : stageSelection.stage;
        const exported = await exportApiGatewaySpecBody(dependencies.aws, candidate, exportedStage);
        const normalized = normalizeApiGatewaySpec(exported.content, candidate, dependencies.core);
        const specBody = normalized.content;
        const derivedOpenApi = await writeResolvedArtifactWithDerivedOpenApi({
          repoRoot: resolvedRoot,
          relativeDir: path.dirname(relativeSpecPath).replace(/\\/g, '/'),
          native: { relativePath: relativeSpecPath, content: specBody },
          derivation: {
            content: specBody,
            format: 'openapi-yaml',
            title: serviceName,
            forceCompleteness: candidate.gatewayType === 'WEBSOCKET' || exported.fallback ? 'partial' : undefined
          },
          dryRun: inputs.dryRun,
          writeSpecFile: dependencies.writeSpecFile
        });
        summary.exported += 1;
        const provenance = buildDeployedSourceProvenance({
          inputs,
          identity: callerIdentity,
          gatewayType: candidate.gatewayType,
          apiId: candidate.id,
          stageSelection,
          content: specBody
        });
        discovered.push({
          serviceName,
          specPath: relativeSpecPath,
          gatewayId: candidate.id,
          gatewayType: candidate.gatewayType,
          stage: stageSelection.stage ?? '',
          providerType: 'api-gateway',
          specFormat: 'openapi-yaml',
          openapiContractAudit: normalized.openapiContractAudit,
          provenance: sanitizeJsonValue(provenance),
          ...derivedOpenApi
        });
        for (const evidence of [...stageSelection.evidence, ...exported.evidence]) {
          dependencies.core.info(evidence);
        }
        dependencies.core.info(`Exported ${candidate.gatewayType} API ${candidate.id} (${candidate.name}) to ${relativeSpecPath}`);
      } catch (error) {
        summary.failed += 1;
        dependencies.core.warning(
          userSafeWarning(
            `Attempted export of ${candidate.gatewayType} API ${candidate.id} (${candidate.name}) in region ${inputs.awsRegion} failed: ${formatUserSafeError(error)}. Continuing with remaining candidates; this failure increments the export summary failed count. Grant API Gateway export/read permission for this API or fix stage/export errors, then re-run.`
          )
        );
      }
    }
  });

  return { discovered, summary };
}

interface RepoContractSelection {
  catalogApis: CatalogApiRef[] | undefined;
  existingSpecPath?: string;
  existingSpecFormat?: SpecFormat;
  existingSpecEvidence?: string[];
  existingSpecContent?: string;
  existingSpecShouldWriteNative: boolean;
  earlyResult?: ResolutionResult;
}

function rankedRepoAmbiguity(
  inputs: ResolvedInputs,
  candidates: Array<{ serviceName: string; gatewayId: string; gatewayType: GatewayType; confidence: number; evidence: string[] }>,
  evidencePrefix: string
): ResolutionResult {
  const rankedCandidates = sanitizeJsonValue(
    candidates.map((candidate, index) => ({
      rank: index + 1,
      serviceName: candidate.serviceName,
      gatewayId: candidate.gatewayId,
      gatewayType: candidate.gatewayType,
      confidence: candidate.confidence,
      evidence: candidate.evidence
    }))
  );
  return {
    status: 'unresolved',
    sourceType: 'manual-review',
    serviceName: inferFallbackServiceName(inputs) ?? 'unknown-service',
    confidence: 0,
    rankedCandidates,
    evidence: [
      evidencePrefix,
      ...rankedCandidates.map((candidate) => `Candidate ${candidate.rank}: ${candidate.gatewayId}`)
    ]
  };
}

function sameTierRepoCandidates(candidates: RepoSpecCandidate[]): RepoSpecCandidate[] {
  const top = candidates[0];
  if (!top) return [];
  // Same-tier means the winning artifact class + contract kind, not merely equal numeric score.
  // Basename heuristics (openapi.yaml vs api.yaml) must not silently collapse authored peers.
  return candidates.filter(
    (candidate) => candidate.artifactClass === top.artifactClass && candidate.type === top.type
  );
}

function topCandidatePerServiceRoot(candidates: RepoSpecCandidate[]): RepoSpecCandidate[] {
  const byRoot = new Map<string, RepoSpecCandidate>();
  for (const candidate of candidates) {
    const existing = byRoot.get(candidate.serviceRoot);
    if (!existing) {
      byRoot.set(candidate.serviceRoot, candidate);
      continue;
    }
    if (
      candidate.score > existing.score
      || (candidate.score === existing.score && candidate.path.localeCompare(existing.path) < 0)
    ) {
      byRoot.set(candidate.serviceRoot, candidate);
    }
  }
  return [...byRoot.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, candidate]) => candidate);
}

function gatewayTypeForRepoFormat(format: SpecFormat | undefined): GatewayType {
  if (format === 'asyncapi-yaml' || format === 'asyncapi-json') return 'SNS';
  return 'REST';
}

function serviceNameForRepoCandidate(inputs: ResolvedInputs, candidate: RepoSpecCandidate): string {
  if (candidate.serviceRoot && candidate.serviceRoot !== '.') {
    return path.posix.basename(candidate.serviceRoot);
  }
  return (
    inferFallbackServiceName(inputs)
    ?? (path.posix.basename(candidate.path, path.posix.extname(candidate.path)) || 'service')
  );
}

/**
 * Smithy projects and multi-file GraphQL groups carry aggregated model content.
 * Never expose smithy-build.json as the native model path; materialize a composed
 * artifact under output-dir instead.
 */
function materializeAggregatedRepoArtifact(
  inputs: ResolvedInputs,
  candidate: RepoSpecCandidate
): { path: string; writeNative: boolean; content?: string; evidence: string[] } {
  const members = candidate.memberPaths ?? [];
  const isSmithyProject =
    candidate.type === 'smithy'
    && (members.length > 0 || path.posix.basename(candidate.path).toLowerCase() === 'smithy-build.json');
  const isGraphqlAggregate = candidate.type === 'graphql' && members.length > 1;

  if ((!isSmithyProject && !isGraphqlAggregate) || !candidate.content?.trim()) {
    return {
      path: candidate.path,
      writeNative: false,
      content: candidate.content,
      evidence: candidate.evidence
    };
  }

  const serviceName = serviceNameForRepoCandidate(inputs, candidate);
  const filename = candidate.type === 'smithy' ? 'model.smithy' : 'schema.graphql';
  const aggregatePath = path
    .join(inputs.outputDir, projectFolderName(serviceName), filename)
    .replace(/\\/g, '/');
  return {
    path: aggregatePath,
    writeNative: true,
    content: candidate.content,
    evidence: [
      ...candidate.evidence,
      `Materialized aggregated ${candidate.type === 'smithy' ? 'Smithy' : 'GraphQL'} model at ${aggregatePath}`
    ]
  };
}

async function selectExplicitRepoSpec(
  inputs: ResolvedInputs
): Promise<Omit<RepoContractSelection, 'catalogApis' | 'earlyResult'>> {
  const relative = inputs.specPath!;
  const resolved = await resolveLocalReadWithinRoot(inputs.repoRoot, relative, {
    fieldName: 'spec-path',
    countAsReference: false
  });
  const content = await readFile(resolved.canonicalPath, 'utf8');
  const format = inferFormatFromContent(relative, content);
  return {
    existingSpecPath: relative.replace(/\\/g, '/'),
    existingSpecFormat: format,
    existingSpecEvidence: [`Resolved from explicit spec-path ${relative}`],
    existingSpecContent: content,
    existingSpecShouldWriteNative: false
  };
}

async function selectCatalogContract(
  inputs: ResolvedInputs,
  catalogApis: CatalogApiRef[],
  actionCore: Pick<ReporterLike, 'info' | 'warning'>,
  fetchRemoteSpec: typeof fetchSpecFromUrl = fetchSpecFromUrl
): Promise<Omit<RepoContractSelection, 'catalogApis'> | undefined> {
  const remotePolicy = inputs.remoteFetchPolicy ?? DEFAULT_REMOTE_FETCH_POLICY;
  const viable: Array<{
    api: CatalogApiRef;
    kind: 'local' | 'remote' | 'inline';
    path?: string;
    format?: SpecFormat;
    content?: string;
    evidence: string[];
    writeNative: boolean;
  }> = [];

  for (const api of catalogApis) {
    if (api.inlineContent) {
      const classified = classifyCatalogBytes(api.inlineContent, api.type, `${api.name}.inline`);
      if (!classified) {
        actionCore.warning(
          userSafeWarning(
            `Backstage entity ${api.name} inline definition could not be classified${api.type ? ` as declared type "${api.type}"` : ''}. Continuing discovery without this catalog contract.`
          )
        );
        continue;
      }
      const targetPath = path
        .join(inputs.outputDir, projectFolderName(api.name), classified.filename)
        .replace(/\\/g, '/');
      viable.push({
        api,
        kind: 'inline',
        path: targetPath,
        format: classified.format,
        content: api.inlineContent,
        evidence: [`Resolved from Backstage catalog inline ${api.type ?? 'api'} definition (${api.name})`],
        writeNative: true
      });
      continue;
    }

    if (api.specPath) {
      try {
        const resolved = await resolveLocalReadWithinRoot(inputs.repoRoot, api.specPath, {
          fieldName: 'catalog-spec-path',
          countAsReference: false
        });
        const content = await readFile(resolved.canonicalPath, 'utf8');
        // Prefer the containment helper's relative path (canonical-root aware) over
        // path.relative(repoRoot, canonicalPath), which breaks on macOS /var vs /private/var.
        const relative = resolved.relativePath.replace(/\\/g, '/');
        const classified = classifyCatalogBytes(content, api.type, api.specPath);
        if (!classified) {
          actionCore.warning(
            userSafeWarning(
              `Backstage entity ${api.name} local definition at ${api.specPath} could not be classified${api.type ? ` as declared type "${api.type}"` : ''}. Continuing discovery without this catalog contract.`
            )
          );
          continue;
        }
        viable.push({
          api,
          kind: 'local',
          path: relative,
          format: classified.format,
          content,
          evidence: [`Resolved from Backstage catalog local ${api.type ?? 'api'} definition (${api.name})`],
          writeNative: false
        });
      } catch (error) {
        actionCore.warning(
          userSafeWarning(
            `Attempted read of Backstage entity ${api.name} local definition at ${api.specPath} failed: ${formatUserSafeError(error)}. Continuing discovery without this catalog contract. Correct the catalog definition or local path, then re-run.`
          )
        );
      }
      continue;
    }

    if (api.specUrl) {
      const safeUrl = sanitizeUrlEvidence(api.specUrl);
      try {
        actionCore.info(`Fetching spec from Backstage catalog URL: ${safeUrl}`);
        const fetched = await fetchRemoteSpec(api.specUrl, {
          timeoutMs: 15000,
          policy: remotePolicy
        });
        const classified = classifyCatalogBytes(fetched.content, api.type, api.specUrl);
        if (!classified) {
          actionCore.warning(
            userSafeWarning(
              `Backstage entity ${api.name} remote definition at ${safeUrl} could not be classified${api.type ? ` as declared type "${api.type}"` : ''}. Continuing discovery without this catalog contract.`
            )
          );
          continue;
        }
        const targetPath = path
          .join(inputs.outputDir, projectFolderName(api.name), classified.filename)
          .replace(/\\/g, '/');
        viable.push({
          api,
          kind: 'remote',
          path: targetPath,
          format: classified.format,
          content: fetched.content,
          evidence: [`Resolved from Backstage catalog remote ${api.type ?? 'api'} definition (${api.name})`],
          writeNative: true
        });
        actionCore.info(`Fetched remote spec from catalog URL for ${targetPath}`);
      } catch (error) {
        actionCore.warning(
          userSafeWarning(
            `Attempted fetch of Backstage entity ${api.name} remote definition at ${safeUrl} failed: ${formatUserSafeError(error)}. Continuing discovery without this catalog contract. Correct the catalog definition or allowlist the HTTPS host/path, then re-run.`
          )
        );
      }
    }
  }

  if (viable.length === 0) {
    return undefined;
  }

  if (viable.length > 1) {
    return {
      earlyResult: rankedRepoAmbiguity(
        inputs,
        viable.map((entry) => ({
          serviceName: entry.api.name,
          gatewayId: entry.path ?? entry.api.specUrl ?? entry.api.name,
          gatewayType: gatewayTypeForRepoFormat(entry.format),
          confidence: 70,
          evidence: entry.evidence
        })),
        `Found ${viable.length} Backstage API entities with usable definitions; manual review required`
      ),
      existingSpecShouldWriteNative: false
    };
  }

  const selected = viable[0]!;
  return {
    existingSpecPath: selected.path,
    existingSpecFormat: selected.format,
    existingSpecEvidence: selected.evidence,
    existingSpecContent: selected.content,
    existingSpecShouldWriteNative: selected.writeNative
  };
}

async function selectInventoryContract(
  inputs: ResolvedInputs,
  staticIac: InventoryStaticIacOptions
): Promise<Omit<RepoContractSelection, 'catalogApis'> | undefined> {
  const inventory = await inventoryRepoSpecs(inputs.repoRoot, {
    ...(inputs.serviceRoot ? { serviceRoot: inputs.serviceRoot } : {}),
    staticIac
  });
  const candidates = inventory.candidates;
  if (candidates.length === 0) {
    return undefined;
  }

  if (!inputs.serviceRoot) {
    const rootWinners = topCandidatePerServiceRoot(
      candidates.filter((candidate) => candidate.artifactClass === 'authored')
    );
    if (rootWinners.length > 1) {
      return {
        earlyResult: rankedRepoAmbiguity(
          inputs,
          rootWinners.map((candidate) => ({
            serviceName:
              candidate.serviceRoot === '.'
                ? path.posix.basename(candidate.path)
                : path.posix.basename(candidate.serviceRoot),
            gatewayId: candidate.path,
            gatewayType: gatewayTypeForRepoFormat(candidate.format),
            confidence: Math.max(50, Math.min(95, candidate.score)),
            evidence: candidate.evidence
          })),
          `Found ${rootWinners.length} repository service groups; set service-root or spec-path for resolve-one`
        ),
        existingSpecShouldWriteNative: false
      };
    }
  }

  const sameTier = sameTierRepoCandidates(candidates);
  if (sameTier.length > 1) {
    return {
      earlyResult: rankedRepoAmbiguity(
        inputs,
        sameTier.map((candidate) => ({
          serviceName:
            candidate.serviceRoot === '.'
              ? path.posix.basename(candidate.path)
              : path.posix.basename(candidate.serviceRoot),
          gatewayId: candidate.path,
          gatewayType: gatewayTypeForRepoFormat(candidate.format),
          confidence: Math.max(50, Math.min(95, candidate.score)),
          evidence: candidate.evidence
        })),
        `Found ${sameTier.length} same-tier repository contracts; manual review required`
      ),
      existingSpecShouldWriteNative: false
    };
  }

  const selected = candidates[0]!;
  const materialized = materializeAggregatedRepoArtifact(inputs, selected);
  return {
    existingSpecPath: materialized.path,
    existingSpecFormat: selected.format,
    existingSpecEvidence: materialized.evidence,
    existingSpecContent: materialized.content,
    existingSpecShouldWriteNative: materialized.writeNative
  };
}

async function resolveRepoContractSelection(
  inputs: ResolvedInputs,
  actionCore: Pick<ReporterLike, 'info' | 'warning'>,
  fetchRemoteSpec: typeof fetchSpecFromUrl = fetchSpecFromUrl,
  staticIac?: InventoryStaticIacOptions
): Promise<RepoContractSelection> {
  const catalogApis = await detectCatalogApis(inputs.repoRoot, {
    ...(inputs.serviceRoot ? { serviceRoot: inputs.serviceRoot } : {}),
    ...(inputs.expectedServiceName ? { serviceName: inputs.expectedServiceName } : {})
  });

  if (inputs.specPath) {
    const explicit = await selectExplicitRepoSpec(inputs);
    return { catalogApis, ...explicit };
  }

  if (catalogApis && catalogApis.length > 0) {
    const catalogSelection = await selectCatalogContract(inputs, catalogApis, actionCore, fetchRemoteSpec);
    if (catalogSelection?.earlyResult || catalogSelection?.existingSpecPath) {
      return { catalogApis, ...catalogSelection, existingSpecShouldWriteNative: catalogSelection.existingSpecShouldWriteNative };
    }
  }

  const inventorySelection = await selectInventoryContract(
    inputs,
    staticIac ?? buildStaticIacOptions(inputs)
  );
  if (inventorySelection) {
    return { catalogApis, ...inventorySelection };
  }

  return { catalogApis, existingSpecShouldWriteNative: false };
}

async function discoverRepoServiceGroups(
  inputs: ResolvedInputs,
  dependencies: DiscoveryDependencies,
  staticIac: InventoryStaticIacOptions
): Promise<{ discovered: DiscoveredService[]; summary: DiscoverySummary; nativePaths: Set<string> }> {
  const inventory = await inventoryRepoSpecs(inputs.repoRoot, {
    ...(inputs.serviceRoot ? { serviceRoot: inputs.serviceRoot } : {}),
    staticIac
  });
  const byRoot = new Map<string, RepoSpecCandidate[]>();
  for (const candidate of inventory.candidates) {
    const bucket = byRoot.get(candidate.serviceRoot) ?? [];
    bucket.push(candidate);
    byRoot.set(candidate.serviceRoot, bucket);
  }

  const discovered: DiscoveredService[] = [];
  const nativePaths = new Set<string>();
  const summary: DiscoverySummary = { attempted: 0, exported: 0, failed: 0, skipped: 0 };
  const roots = [...byRoot.keys()].sort((left, right) => left.localeCompare(right));

  for (const serviceRoot of roots) {
    const group = (byRoot.get(serviceRoot) ?? []).sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.artifactClass !== right.artifactClass) {
        return left.artifactClass === 'authored' ? -1 : 1;
      }
      return left.path.localeCompare(right.path);
    });
    const sameTier = sameTierRepoCandidates(group);
    summary.attempted += 1;
    if (sameTier.length !== 1) {
      summary.skipped += 1;
      dependencies.core.info(
        `Skipping ambiguous repository service group ${serviceRoot} (${sameTier.length} same-tier candidates)`
      );
      continue;
    }
    const selected = sameTier[0]!;
    const materialized = materializeAggregatedRepoArtifact(inputs, selected);
    if (nativePaths.has(materialized.path) || nativePaths.has(selected.path)) {
      summary.skipped += 1;
      continue;
    }
    nativePaths.add(materialized.path);
    nativePaths.add(selected.path);
    const serviceName = serviceNameForRepoCandidate(inputs, selected);
    if (!inputs.dryRun && materialized.writeNative && materialized.content) {
      try {
        const absolute = resolvePathWithinRoot(inputs.repoRoot, materialized.path, 'output-dir');
        await dependencies.writeSpecFile(absolute, materialized.content);
      } catch (error) {
        summary.failed += 1;
        dependencies.core.warning(
          userSafeWarning(`Failed writing aggregated repo contract ${materialized.path}: ${formatUserSafeError(error)}`)
        );
        continue;
      }
    }
    discovered.push({
      serviceName,
      specPath: materialized.path,
      gatewayId: `repo-spec:${materialized.path}`,
      gatewayType: gatewayTypeForRepoFormat(selected.format),
      stage: '',
      specFormat: selected.format
    });
    summary.exported += 1;
    dependencies.core.info(`Discovered repository service group ${serviceRoot} -> ${materialized.path}`);
  }

  return { discovered, summary, nativePaths };
}

export async function runResolution(
  inputs: ResolvedInputs,
  awsClient: AwsGatewayClient,
  actionCore: Pick<ReporterLike, 'group' | 'info' | 'warning'>,
  writeSpecFile: (outputPath: string, content: string) => Promise<void>,
  resolutionDependencies: ResolutionDependencies = {}
): Promise<ResolutionResult> {
  const fetchByteBudget = resolutionDependencies.fetchByteBudget ?? { totalBytes: 0 };
  const fetchRemoteSpec = withSharedFetchBudget(
    resolutionDependencies.fetchSpecFromUrl ?? fetchSpecFromUrl,
    fetchByteBudget
  );
  const staticIac = buildStaticIacOptions(inputs, resolutionDependencies.staticIac);
  const repoSelection = await resolveRepoContractSelection(inputs, actionCore, fetchRemoteSpec, staticIac);
  const catalogApis = repoSelection.catalogApis;
  if (repoSelection.earlyResult) {
    return repoSelection.earlyResult;
  }

  const existingSpecPath = repoSelection.existingSpecPath;
  const existingSpecFormat = repoSelection.existingSpecFormat;
  const existingSpecEvidence = repoSelection.existingSpecEvidence;
  const existingSpecContent = repoSelection.existingSpecContent;
  const existingSpecShouldWriteNative = repoSelection.existingSpecShouldWriteNative;

  // Local CDK/SAM build-artifact probe (W5): runs only when no direct repo spec was found.
  // Local files only -- no AWS calls, no S3/HTTP fetches. Stale generated artifacts never resolve as current.
  if (!existingSpecPath) {
    const localArtifactSpecs = await findLocalCfnArtifactSpecs(inputs.repoRoot);
    if (localArtifactSpecs.length === 1) {
      const artifact = localArtifactSpecs[0]!;
      if (artifact.artifactClass === 'generated-stale') {
        // Continue to stronger evidence (signals / AWS) rather than treating stale output as current.
        actionCore.info(
          `Skipping stale local build artifact ${artifact.artifactRef} (${artifact.artifactClass}); continuing resolution`
        );
      } else {
        const serviceName = artifact.logicalId;
        const relativeDir = path.join(inputs.outputDir, projectFolderName(serviceName)).replace(/\\/g, '/');
        const relativeSpecPath = path.join(relativeDir, artifact.filename).replace(/\\/g, '/');
        const evidence = [
          `Extracted embedded OpenAPI document from local build artifact ${artifact.artifactPath} resource ${artifact.logicalId} (${artifact.artifactClass})`
        ];
        const base: ResolutionResult = {
          status: 'resolved',
          sourceType: 'cfn-embedded',
          serviceName,
          confidence: 75,
          gatewayType: artifact.gatewayType,
          providerType: 'cloudformation',
          specFormat: artifact.format,
          specPath: relativeSpecPath,
          evidence
        };
        if (inputs.dryRun) {
          return { ...base, evidence: [...evidence, 'Dry run enabled; skipped local build artifact write'] };
        }
        try {
          const derivedOpenApi = await writeResolvedArtifactWithDerivedOpenApi({
            repoRoot: inputs.repoRoot,
            relativeDir,
            native: { relativePath: relativeSpecPath, content: artifact.content },
            derivation: { content: artifact.content, format: artifact.format, title: serviceName },
            dryRun: inputs.dryRun,
            writeSpecFile
          });
          return { ...base, ...derivedOpenApi };
        } catch (error) {
          actionCore.warning(userSafeWarning(`Failed writing local build artifact spec: ${formatUserSafeError(error)}`));
        }
      }
    } else if (localArtifactSpecs.length > 1) {
      const rankedCandidates = sanitizeJsonValue(
        localArtifactSpecs.map((artifact, index) => ({
          rank: index + 1,
          serviceName: artifact.logicalId,
          gatewayId: artifact.artifactRef,
          gatewayType: artifact.gatewayType,
          confidence: 50,
          evidence: [
            `Embedded OpenAPI document in local build artifact ${artifact.artifactPath} (${artifact.artifactClass})`
          ]
        }))
      );
      return {
        status: 'unresolved',
        sourceType: 'manual-review',
        serviceName: inferFallbackServiceName(inputs) ?? 'unknown-service',
        confidence: 0,
        rankedCandidates,
        evidence: [
          `Found ${localArtifactSpecs.length} embedded OpenAPI documents across local CDK/SAM build artifacts; manual review required`,
          ...rankedCandidates.map((candidate) => `Candidate ${candidate.rank}: ${candidate.gatewayId}`)
        ]
      };
    }
  }

  // Skip static IaC in signals when a repo contract was already selected (explicit/catalog/inventory);
  // lazy resolver stays unconsumed for explicit/catalog paths that never called inventory.
  const signals = await collectRepoSignals(
    inputs.repoRoot,
    inputs.repoContext.repoSlug,
    inputs.expectedServiceName,
    inputs.expectedGatewayIds,
    { staticIac, includeStaticIac: !existingSpecPath }
  );
  const domainResolution = await lookupCandidatesByCustomDomains(signals.customDomainHints ?? [], awsClient, actionCore);
  const enrichedSignals = {
    ...signals,
    inferredGatewayIdHints: [...new Set([...signals.inferredGatewayIdHints, ...domainResolution.ids])],
    evidence: [...new Set([...signals.evidence, ...domainResolution.evidence])]
  };
  const narrowedCandidates =
    inputs.expectedGatewayIds.length > 0
      ? await actionCore.group('Resolve API candidates by explicit gateway ID', async () =>
          lookupCandidatesByIds(inputs, awsClient, actionCore)
        )
      : filterCandidates(
          await actionCore.group('Resolve REST API candidates', async () =>
            safeListRestApis(awsClient, actionCore, inputs.awsRegion)
          ),
          await actionCore.group('Resolve HTTP API candidates', async () => safeListHttpApis(inputs, awsClient, actionCore)),
          inputs.includeV2,
          inputs.apiFilter
        );

  // Exact repo-tag correlation runs at every account size (not only when over max-candidates).
  let finalCandidates = uniqueGatewayCandidates([...domainResolution.candidates, ...narrowedCandidates]);
  let resolutionNarrowing: { tier: string; mode: 'select' | 'narrow'; droppedCount: number } | undefined;
  let exactTagEvidence: string[] = [];
  let exactTagRestricted = false;
  let exactSourceTagContract: ExactRepoTagContract | undefined;
  const sdkOpts = { requestTimeoutMs: inputs.requestTimeoutMs, maxAttempts: inputs.maxAttempts };

  // One TaggingSpecClient instance for the entire resolution (exact + optional broad narrowing).
  let sharedTaggingClient: TaggingSpecClient | undefined;
  if (resolutionDependencies.narrowingClients) {
    sharedTaggingClient = resolutionDependencies.narrowingClients.taggingClient;
  } else {
    try {
      sharedTaggingClient = new TaggingSdkClient(inputs.awsRegion, sdkOpts);
    } catch {
      sharedTaggingClient = undefined;
    }
  }

  const exactCorrelation = await actionCore.group('Exact repository tag correlation', async () =>
    correlateExactRepoTags({
      repoSlug: inputs.repoContext.repoSlug,
      taggingClient: sharedTaggingClient
    })
  );

  if (exactCorrelation) {
    const beforeCount = finalCandidates.length;
    const matched = exactCorrelation.gatewayIds
      .map((id) => finalCandidates.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is (typeof finalCandidates)[number] => Boolean(candidate));
    if (matched.length > 0) {
      // One exact match selects; multiple exact per-environment matches stay as the candidate set.
      // Do not collapse environments by list order and do not retain non-matching gateways.
      finalCandidates = matched;
      exactTagRestricted = true;
      exactTagEvidence = exactCorrelation.evidence;
      exactSourceTagContract = exactCorrelation.tagContract;
      const mode: 'select' | 'narrow' =
        exactCorrelation.mode === 'select' && matched.length === 1 ? 'select' : 'narrow';
      resolutionNarrowing = {
        tier: 'tag-prefilter',
        mode,
        droppedCount: beforeCount - matched.length
      };
      if (mode === 'select') {
        actionCore.info(`Exact tag correlation (${exactCorrelation.tagContract}) selected candidate ${matched[0].id}`);
      } else {
        actionCore.info(
          `Exact tag correlation (${exactCorrelation.tagContract}) retained ${matched.length} per-environment candidate(s) for ambiguity-safe review`
        );
      }
    }
  }

  // Progressive narrowing (IaC/CFN/generic-tag/naming) only for broad accounts when exact tags did not already restrict.
  if (!exactTagRestricted && inputs.maxCandidates > 0 && finalCandidates.length > inputs.maxCandidates) {
    const candidateCountBeforeNarrowing = finalCandidates.length;
    const narrowingResult = await actionCore.group('Progressive narrowing', async () => {
      let cfnClient: CloudFormationSpecClient | undefined;
      if (resolutionDependencies.narrowingClients) {
        cfnClient = resolutionDependencies.narrowingClients.cfnClient;
      } else {
        try { cfnClient = new CloudFormationSdkClient(inputs.awsRegion, sdkOpts); } catch { /* unavailable */ }
      }
      // Reuse the same TaggingSpecClient; suppress exact-contract re-queries after the unconditional attempt.
      const taggingClient = sharedTaggingClient
        ? taggingClientWithoutExactRetry(sharedTaggingClient)
        : undefined;

      return runNarrowingPipeline(
        { repoSlug: inputs.repoContext.repoSlug, serviceHints: enrichedSignals.serviceHints, signals: enrichedSignals, cfnClient, taggingClient },
        finalCandidates.map((c) => ({ id: c.id, name: c.name }))
      );
    });

    if (narrowingResult) {
      if (narrowingResult.mode === 'select' && narrowingResult.gatewayIds.length === 1) {
        const selectedId = narrowingResult.gatewayIds[0];
        finalCandidates = finalCandidates.filter((c) => c.id === selectedId);
        actionCore.info(`Narrowing (${narrowingResult.tier}) selected candidate ${selectedId}`);
      } else {
        const intersecting = new Set(narrowingResult.gatewayIds);
        const first = narrowingResult.gatewayIds
          .map((id) => finalCandidates.find((c) => c.id === id))
          .filter((c): c is (typeof finalCandidates)[number] => Boolean(c));
        const rest = finalCandidates.filter((c) => !intersecting.has(c.id));
        finalCandidates = [...first, ...rest];
        actionCore.info(
          `Narrowing (${narrowingResult.tier}) ranked ${first.length} of ${candidateCountBeforeNarrowing} candidates first and demoted ${rest.length} (not deleted)`
        );
      }
      resolutionNarrowing = {
        tier: narrowingResult.tier,
        mode: narrowingResult.mode,
        droppedCount: narrowingResult.droppedCount
      };
    }

    // If still over limit after narrowing, warn instead of hard-fail
    if (inputs.maxCandidates > 0 && finalCandidates.length > inputs.maxCandidates) {
      actionCore.warning(
        userSafeWarning(`${finalCandidates.length} candidates after narrowing still exceeds limit (${inputs.maxCandidates}). Using top ${inputs.maxCandidates} by name relevance.`)
      );
      finalCandidates = finalCandidates.slice(0, inputs.maxCandidates);
    }
  }

  const resolverOptions = { repoSlug: inputs.repoContext.repoSlug };
  const gateways = [];
  for (const candidate of finalCandidates) {
    const candidateEvidence: string[] = [...exactTagEvidence];
    let tags: Record<string, string> = {};
    try {
      tags = candidate.gatewayType === 'REST' ? await awsClient.getRestTags(candidate.id) : await awsClient.getHttpTags(candidate.id);
    } catch (error) {
      candidateEvidence.push(`Tag lookup failed for ${candidate.id}: ${formatUserSafeError(error)}`);
      actionCore.warning(userSafeWarning(`Tag lookup failed for ${candidate.gatewayType} API ${candidate.id}: ${formatUserSafeError(error)}`));
    }
    gateways.push({ id: candidate.id, name: candidate.name, gatewayType: candidate.gatewayType, tags, evidence: candidateEvidence });
  }

  const resolvedCandidate = resolveServiceCandidate(gateways, enrichedSignals, resolverOptions);
  const rankedGatewayCandidates = rankServiceCandidates(gateways, enrichedSignals, resolverOptions);

  let resolvedSnsCandidate: SnsResolvedCandidate | undefined;
  let resolvedSnsExport: SpecExportResult | undefined;
  const snsManualReviewEvidence: string[] = [];
  let snsManualReviewMetadata:
    | {
        serviceName: string;
        metadataContent: string;
        sidecars?: Array<{ filename: string; content: string }>;
      }
    | undefined;
  const shouldAttemptSns = enrichedSignals.providerHints?.includes('sns') ?? false;
  if (shouldAttemptSns) {
    const sdkOpts = { requestTimeoutMs: inputs.requestTimeoutMs, maxAttempts: inputs.maxAttempts };
    const snsRuntimeDependencies = {
      fetchSpecFromUrl: fetchRemoteSpec,
      remoteFetchPolicy: inputs.remoteFetchPolicy ?? DEFAULT_REMOTE_FETCH_POLICY,
      catalogApis,
      eventBridgeClient:
        resolutionDependencies.eventBridgeClient ?? new EventBridgeSchemasSdkClient(inputs.awsRegion, sdkOpts),
      codeDerivedResolver: resolutionDependencies.codeDerivedResolver
    };
    const snsProvider =
      resolutionDependencies.snsProvider ??
      (resolutionDependencies.createSnsProvider
        ? resolutionDependencies.createSnsProvider(snsRuntimeDependencies)
        : new SnsProvider(new SnsSdkClient(inputs.awsRegion, sdkOpts), inputs.repoRoot, new SsmSdkClient(inputs.awsRegion, sdkOpts), snsRuntimeDependencies));

    let snsCandidates: SpecCandidate[] = [];
    try {
      const snsAvailable = await snsProvider.probe();
      if (snsAvailable) {
        snsCandidates = await snsProvider.listCandidates();
      } else {
        snsManualReviewEvidence.push('Detected sns provider hints but SNS provider probe was unavailable');
      }
    } catch (error) {
      actionCore.warning(userSafeWarning(`Failed preparing SNS provider: ${formatUserSafeError(error)}`));
      snsManualReviewEvidence.push('Detected sns provider hints but SNS provider probe was unavailable');
    }

    const sortedSnsCandidates = sortSnsCandidates(snsCandidates, enrichedSignals.serviceHints);
    const bridgeEvidence = collectSnsEventBridgeBridgeEvidence(enrichedSignals);
    const candidatesToTry =
      inputs.maxCandidates > 0 && sortedSnsCandidates.length > inputs.maxCandidates
        ? sortedSnsCandidates.slice(0, inputs.maxCandidates)
        : sortedSnsCandidates;

    for (const candidate of candidatesToTry) {
      try {
        const contract = await snsProvider.resolveContract(candidate, {
          serviceHints: enrichedSignals.serviceHints,
          bridgeEvidence
        });
        if (!contract.resolved) {
          snsManualReviewEvidence.push(...contract.evidence);
          if (!snsManualReviewMetadata) {
            snsManualReviewMetadata = {
              serviceName: candidate.name,
              metadataContent: JSON.stringify(contract.metadata, null, 2),
              sidecars: contract.sidecars
            };
          }
          continue;
        }
        const format = contract.result.format;
        if (format !== 'asyncapi-yaml' && format !== 'asyncapi-json' && format !== 'json-schema') {
          snsManualReviewEvidence.push(
            ...contract.evidence,
            `SNS candidate ${candidate.id} (${candidate.name}) resolved unsupported format ${format}`
          );
          continue;
        }
        resolvedSnsCandidate = {
          serviceName: candidate.name,
          topicArn: candidate.id,
          confidence:
            contract.origin === 'eventbridge-derived'
              ? 55
              : Math.max(60, scoreSnsCandidate(candidate, enrichedSignals.serviceHints)),
          origin: contract.origin,
          specFormat: format,
          variantCount: contract.variantCount,
          evidence: [...snsManualReviewEvidence, ...candidate.evidence, ...contract.evidence]
        };
        resolvedSnsExport = {
          ...contract.result,
          sidecars: [
            ...(contract.result.sidecars ?? []),
            ...(contract.sidecars ?? []),
            { filename: 'sns-resolution-metadata.json', content: JSON.stringify(contract.metadata, null, 2) }
          ]
        };
        break;
      } catch (error) {
        actionCore.warning(userSafeWarning(`Failed resolving SNS candidate ${candidate.id} (${candidate.name}): ${formatUserSafeError(error)}`));
      }
    }
  }

  const providerCandidates = await collectProviderResolutionCandidates(
    resolutionDependencies.providers ?? [],
    enrichedSignals,
    actionCore
  );

  const selectedSource = chooseSource({
    existingSpecPath,
    existingSpecFormat,
    existingSpecEvidence,
    candidate: resolvedCandidate,
    snsCandidate: resolvedSnsCandidate,
    fallbackServiceName: inferFallbackServiceName(inputs)
  });
  if (resolutionNarrowing) {
    selectedSource.narrowing = resolutionNarrowing;
  }
  if (selectedSource.status === 'unresolved' && resolvedCandidate?.ambiguous) {
    const rankedViews = rankServiceCandidates(gateways, enrichedSignals, resolverOptions).map((candidate, index) => ({
      rank: index + 1,
      serviceName: candidate.serviceName,
      gatewayId: candidate.gatewayId,
      gatewayType: candidate.gatewayType,
      confidence: candidate.confidence,
      evidence: candidate.evidence
    }));
    selectedSource.rankedCandidates = sanitizeJsonValue(rankedViews);
  }
  if (resolvedCandidate?.ambiguous && rankedGatewayCandidates.length > 1 && selectedSource.status === 'unresolved') {
    selectedSource.rankedCandidates = sanitizeJsonValue(
      rankedGatewayCandidates.map((candidate, index) => ({
        rank: index + 1,
        serviceName: candidate.serviceName,
        gatewayId: candidate.gatewayId,
        gatewayType: candidate.gatewayType,
        confidence: candidate.confidence,
        evidence: candidate.evidence
      }))
    );
  }
  const preferredProviderCandidate = providerCandidates[0];
  if (shouldPreferProviderCandidate(preferredProviderCandidate, selectedSource)) {
    const exportFailures: string[] = [];
    for (const candidate of providerCandidates) {
      if (!shouldPreferProviderCandidate(candidate, selectedSource)) {
        break;
      }
      try {
        return await exportProviderResolutionCandidate(candidate, inputs, writeSpecFile);
      } catch (error) {
        exportFailures.push(
          `Failed exporting ${candidate.provider.type} candidate ${candidate.candidate.id}: ${formatUserSafeError(error)}`
        );
      }
    }
    if (selectedSource.status === 'unresolved') {
      return toManualReviewResult(selectedSource, exportFailures);
    }
  }
  if (selectedSource.sourceType === 'repo-spec') {
    if (!selectedSource.specPath || !selectedSource.specFormat) {
      return selectedSource;
    }
    const relativeProviderDir = (
      existingSpecShouldWriteNative
        ? path.dirname(selectedSource.specPath)
        : path.join(inputs.outputDir, projectFolderName(selectedSource.serviceName || 'service'))
    ).replace(/\\/g, '/');
    try {
      let content = existingSpecContent;
      if (content === undefined) {
        const resolvedSpec = await resolveLocalReadWithinRoot(inputs.repoRoot, selectedSource.specPath, {
          fieldName: 'repo-spec-path'
        });
        content = await readFile(resolvedSpec.canonicalPath, 'utf8');
      }
      const derivedOpenApi = await writeResolvedArtifactWithDerivedOpenApi({
        repoRoot: inputs.repoRoot,
        relativeDir: relativeProviderDir,
        native: existingSpecShouldWriteNative ? { relativePath: selectedSource.specPath, content } : undefined,
        derivation: {
          content,
          format: selectedSource.specFormat,
          title: selectedSource.serviceName
        },
        dryRun: inputs.dryRun,
        writeSpecFile
      });
      return { ...selectedSource, ...derivedOpenApi };
    } catch (error) {
      return {
        ...selectedSource,
        derivedOpenApiEvidence: [
          `Skipped derived OpenAPI sidecar for repo spec ${selectedSource.specPath}: ${formatUserSafeError(error)}`
        ]
      };
    }
  }
  if (selectedSource.sourceType === 'gateway-export' && selectedSource.gatewayId) {
    const selectedGateway = finalCandidates.find((candidate) => candidate.id === selectedSource.gatewayId);
    if (!selectedGateway) {
      return toManualReviewResult(selectedSource, ['Selected gateway could not be reloaded for export']);
    }
    let stageSelection: ResolutionStageSelection;
    try {
      stageSelection = await resolveStageSelection(
        awsClient,
        selectedGateway,
        inputs.stage,
        inputs.expectedGatewayIds.includes(selectedGateway.id)
      );
    } catch (error) {
      return toManualReviewResult(selectedSource, [`Stage lookup failed for ${selectedSource.gatewayId}: ${formatUserSafeError(error)}`]);
    }
    if (stageSelection.error) {
      return toManualReviewResult(selectedSource, [stageSelection.error]);
    }
    selectedSource.stage = stageSelection.stage;
    selectedSource.evidence = [...selectedSource.evidence, ...stageSelection.evidence];
    const relativeSpecPath = toRelativeSpecPath(inputs.outputDir, projectFolderName(selectedSource.serviceName || 'service'));
    if (inputs.dryRun) {
      selectedSource.specPath = relativeSpecPath;
      selectedSource.derivedOpenApiPath = path.join(path.dirname(relativeSpecPath), CANONICAL_DERIVED_OPENAPI_FILENAME).replace(/\\/g, '/');
      selectedSource.derivedOpenApiFormat = 'openapi-json';
      selectedSource.derivedOpenApiCompleteness = selectedSource.gatewayType === 'WEBSOCKET' ? 'partial' : undefined;
      selectedSource.derivedOpenApiEvidence = ['Dry run enabled; skipped API Gateway export and derived OpenAPI sidecar write'];
      selectedSource.evidence = [...selectedSource.evidence, 'Dry run enabled; skipped export and file write'];
      return selectedSource;
    }
    try {
      const exported = await exportApiGatewaySpecBody(
        awsClient,
        { id: selectedSource.gatewayId, gatewayType: selectedSource.gatewayType },
        selectedSource.gatewayType === 'REST'
          ? selectedSource.stage
          : stageSelection.useLatestConfig ? undefined : selectedSource.stage
      );
      const normalized = normalizeApiGatewaySpec(
        exported.content,
        { id: selectedSource.gatewayId, gatewayType: selectedSource.gatewayType, name: selectedSource.serviceName },
        actionCore
      );
      const body = normalized.content;
      const derivedOpenApi = await writeResolvedArtifactWithDerivedOpenApi({
        repoRoot: inputs.repoRoot,
        relativeDir: path.dirname(relativeSpecPath).replace(/\\/g, '/'),
        native: { relativePath: relativeSpecPath, content: body },
        derivation: {
          content: body,
          format: 'openapi-yaml',
          title: selectedSource.serviceName,
          forceCompleteness: selectedSource.gatewayType === 'WEBSOCKET' || exported.fallback ? 'partial' : undefined
        },
        dryRun: inputs.dryRun,
        writeSpecFile
      });
      selectedSource.specPath = relativeSpecPath;
      selectedSource.providerType = 'api-gateway';
      selectedSource.specFormat = 'openapi-yaml';
      selectedSource.openapiContractAudit = normalized.openapiContractAudit;
      Object.assign(selectedSource, derivedOpenApi);
      let resolveIdentity: Awaited<ReturnType<AwsGatewayClient['getCallerIdentity']>> | undefined;
      if (shouldResolveCallerIdentity(inputs)) {
        try {
          resolveIdentity = await awsClient.getCallerIdentity();
        } catch {
          resolveIdentity = undefined;
        }
      }
      selectedSource.provenance = sanitizeJsonValue(
        buildDeployedSourceProvenance({
          inputs,
          identity: resolveIdentity,
          gatewayType: selectedSource.gatewayType,
          apiId: selectedSource.gatewayId,
          stageSelection,
          content: body,
          sourceTier: selectedSource.narrowing?.tier,
          sourceTagContract: exactSourceTagContract,
          providerProbes: selectedSource.providerProbes
        })
      );
      if (selectedSource.gatewayType === 'WEBSOCKET') {
        selectedSource.evidence = [
          ...selectedSource.evidence,
          `Synthesized partial OpenAPI 3.0 spec for WebSocket API ${selectedSource.gatewayId}`
        ];
      }
      if (exported.evidence.length > 0) {
        selectedSource.evidence = [...selectedSource.evidence, ...exported.evidence];
      }
      if (normalized.contractWarning) {
        selectedSource.evidence = [...selectedSource.evidence, normalized.contractWarning];
      }
    } catch (error) {
      const parsed = parseAwsError(error);
      if (isManualReviewExportError(parsed)) {
        return toManualReviewResult(selectedSource, [
          'API Gateway export could not produce a specification automatically; manual review required',
          formatUserSafeError(error)
        ]);
      }
      throw error;
    }
    return selectedSource;
  }
  if (selectedSource.sourceType === 'sns-contract') {
    if (!resolvedSnsExport) {
      return toManualReviewResult(selectedSource, ['SNS contract was selected but export payload was unavailable']);
    }
    const relativeProviderDir = path.join(inputs.outputDir, projectFolderName(selectedSource.serviceName || 'service')).replace(/\\/g, '/');
    const relativeProviderPath = path.join(relativeProviderDir, resolvedSnsExport.filename).replace(/\\/g, '/');
    const metadataSidecar = resolvedSnsExport.sidecars?.find((sidecar) => sidecar.filename === 'sns-resolution-metadata.json');
    const relativeMetadataPath = metadataSidecar ? path.join(relativeProviderDir, metadataSidecar.filename).replace(/\\/g, '/') : undefined;
    const derivedOpenApi = await writeResolvedArtifactWithDerivedOpenApi({
      repoRoot: inputs.repoRoot,
      relativeDir: relativeProviderDir,
      native: { relativePath: relativeProviderPath, content: resolvedSnsExport.content },
      sidecars: resolvedSnsExport.sidecars,
      derivation: { content: resolvedSnsExport.content, format: resolvedSnsExport.format, title: selectedSource.serviceName },
      dryRun: inputs.dryRun,
      writeSpecFile
    });
    if (inputs.dryRun) {
      return {
        ...selectedSource,
        specPath: relativeProviderPath,
        metadataPath: relativeMetadataPath,
        ...derivedOpenApi,
        evidence: [...selectedSource.evidence, 'Dry run enabled; skipped SNS contract file write']
      };
    }
    return {
      ...selectedSource,
      specPath: relativeProviderPath,
      metadataPath: relativeMetadataPath,
      variantCount: selectedSource.variantCount,
      ...derivedOpenApi
    };
  }

  if (selectedSource.sourceType === 'manual-review' && snsManualReviewEvidence.length > 0) {
    const serviceName = selectedSource.serviceName ?? snsManualReviewMetadata?.serviceName ?? 'service';
    const relativeProviderDir = path.join(inputs.outputDir, projectFolderName(serviceName)).replace(/\\/g, '/');
    const relativeMetadataPath = path.join(relativeProviderDir, 'sns-resolution-metadata.json').replace(/\\/g, '/');
    const manualReviewResult = toManualReviewResult(
      { ...selectedSource, contractOrigin: 'manual-review', metadataPath: relativeMetadataPath },
      snsManualReviewEvidence
    );
    if (inputs.dryRun) {
      return {
        ...manualReviewResult,
        evidence: [...manualReviewResult.evidence, 'Dry run enabled; skipped SNS metadata sidecar write']
      };
    }

    if (snsManualReviewMetadata?.metadataContent) {
      const absoluteMetadataPath = resolvePathWithinRoot(inputs.repoRoot, relativeMetadataPath, 'output-dir');
      await writeSpecFile(absoluteMetadataPath, snsManualReviewMetadata.metadataContent);
      for (const sidecar of snsManualReviewMetadata.sidecars ?? []) {
        const relativeSidecarPath = path.join(relativeProviderDir, sidecar.filename).replace(/\\/g, '/');
        const absoluteSidecarPath = resolvePathWithinRoot(inputs.repoRoot, relativeSidecarPath, 'output-dir');
        await writeSpecFile(absoluteSidecarPath, sidecar.content);
      }
    }
    return manualReviewResult;
  }

  return selectedSource;
}

export function buildProviderRegistry(
  inputs: ResolvedInputs,
  awsClient: AwsGatewayClient,
  options: { fetchSpecFromUrl?: typeof fetchSpecFromUrl } = {}
): ProviderRegistry {
  const sdkOpts = { requestTimeoutMs: inputs.requestTimeoutMs, maxAttempts: inputs.maxAttempts };
  const registry = new ProviderRegistry();
  const fetchRemote = options.fetchSpecFromUrl ?? fetchSpecFromUrl;

  registry.register(new ApiGatewayProvider(awsClient, { includeV2: inputs.includeV2, apiFilter: inputs.apiFilter }));
  registry.register(new AppSyncProvider(new AppSyncSdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new AppSyncEventsProvider(new AppSyncEventsSdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new EventBridgeSchemasProvider(new EventBridgeSchemasSdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new EventBridgeSurfaceProvider(new EventBridgeSurfaceSdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new CloudFormationProvider(new CloudFormationSdkClient(inputs.awsRegion, sdkOpts), inputs.repoRoot, new S3SdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new GlueSchemaProvider(new GlueSchemaSdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new BedrockActionGroupProvider(new BedrockActionGroupsSdkClient(inputs.awsRegion, sdkOpts), new S3SdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new AlbListenerRulesProvider(new AlbListenerRulesSdkClient(inputs.awsRegion, sdkOpts)));
  const remoteFetchPolicy = inputs.remoteFetchPolicy ?? DEFAULT_REMOTE_FETCH_POLICY;
  registry.register(
    new SsmProvider(new SsmSdkClient(inputs.awsRegion, sdkOpts), {
      remoteFetchPolicy,
      fetchSpecFromUrl: fetchRemote
    })
  );
  registry.register(
    new SnsProvider(new SnsSdkClient(inputs.awsRegion, sdkOpts), inputs.repoRoot, new SsmSdkClient(inputs.awsRegion, sdkOpts), {
      remoteFetchPolicy,
      fetchSpecFromUrl: fetchRemote
    })
  );
  registry.register(new LambdaUrlProvider(new LambdaSdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new LambdaEventSourceProvider(new LambdaEventSourceSdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new VerifiedPermissionsProvider(new VerifiedPermissionsSdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new StepFunctionsProvider(new StepFunctionsSdkClient(inputs.awsRegion, sdkOpts)));

  return registry;
}

async function runMultiProviderDiscovery(
  providers: SpecProvider[],
  inputs: ResolvedInputs,
  dependencies: DiscoveryDependencies,
  snsResolutionContext?: SnsContractResolutionContext
): Promise<{ discovered: DiscoveredService[]; summary: DiscoverySummary }> {
  const discovered: DiscoveredService[] = [];
  const summary: DiscoverySummary = { attempted: 0, exported: 0, failed: 0, skipped: 0 };
  const slugUsage = new Map<string, number>();
  const resolvedRoot = path.resolve(inputs.repoRoot);

  for (const provider of providers) {
    await dependencies.core.group(`Discover specs from ${provider.type}`, async () => {
      let candidates: SpecCandidate[];
      try {
        candidates = await provider.listCandidates();
      } catch (error) {
        dependencies.core.warning(
          userSafeWarning(
            `Attempted listing candidates from ${provider.type} in region ${inputs.awsRegion} failed: ${formatUserSafeError(error)}. Continuing with other providers; this failure increments the export summary failed count. Grant ${provider.type} read permission or verify the service is available in this region.`
          )
        );
        summary.failed += 1;
        return;
      }

      dependencies.core.info(`Found ${candidates.length} candidate(s) from ${provider.type}`);
      let providerCandidates = candidates;
      if (inputs.maxCandidates > 0 && candidates.length > inputs.maxCandidates) {
        dependencies.core.warning(
          userSafeWarning(
            `${provider.type} returned ${candidates.length} candidates; limiting to first ${inputs.maxCandidates} for this provider`
          )
        );
        summary.skipped += candidates.length - inputs.maxCandidates;
        providerCandidates = candidates.slice(0, inputs.maxCandidates);
      }
      summary.attempted += providerCandidates.length;

      for (const candidate of providerCandidates) {
        if (inputs.dryRun) {
          summary.skipped += 1;
          dependencies.core.info(`Dry run: skipping export for ${provider.type} candidate ${candidate.id} (${candidate.name})`);
          continue;
        }
        try {
          const result = await provider.exportSpec(candidate, {
            stage: inputs.stage,
            dryRun: inputs.dryRun,
            ...(provider.type === 'sns' ? { resolutionContext: snsResolutionContext } : {})
          });
          // SNS provider may set candidate.name from postman:project-name; use candidate.name directly.
          const serviceName = candidate.name;
          const baseFolder = projectFolderName(serviceName);
          const next = (slugUsage.get(baseFolder) ?? 0) + 1;
          slugUsage.set(baseFolder, next);
          const folderName = next === 1 ? baseFolder : `${baseFolder}-${candidate.id}`;
          const relativeSpecPath = path.join(inputs.outputDir, folderName, result.filename).replace(/\\/g, '/');
          const relativeProviderDir = path.join(inputs.outputDir, folderName).replace(/\\/g, '/');
          const derivedOpenApi = await writeResolvedArtifactWithDerivedOpenApi({
            repoRoot: resolvedRoot,
            relativeDir: relativeProviderDir,
            native: { relativePath: relativeSpecPath, content: result.content },
            sidecars: result.sidecars,
            derivation: {
              content: result.content,
              format: result.format,
              title: serviceName,
              forceCompleteness: result.derivedOpenApiCompleteness === 'partial' || provider.type === 'lambda-url' ? 'partial' : undefined
            },
            dryRun: inputs.dryRun,
            writeSpecFile: dependencies.writeSpecFile
          });
          summary.exported += 1;

          const gatewayType = (candidate.meta.gatewayType ?? (provider.type === 'sns' ? 'SNS' : 'REST')) as GatewayType;
          const metadataSidecar = result.sidecars?.find((sidecar) => sidecar.filename === 'sns-resolution-metadata.json');
          let contractOrigin: DiscoveredService['contractOrigin'];
          let variantCount: number | undefined;
          if (provider.type === 'sns' && metadataSidecar) {
            try {
              const parsed = JSON.parse(metadataSidecar.content) as {
                contractOrigin?: DiscoveredService['contractOrigin'];
                variantCount?: number;
              };
              contractOrigin = parsed.contractOrigin;
              variantCount = typeof parsed.variantCount === 'number' ? parsed.variantCount : undefined;
            } catch {
              // ignore malformed metadata sidecar
            }
          }
          const contractProtocol =
            gatewayType === 'HTTP' || gatewayType === 'WEBSOCKET' ? gatewayType : 'REST';
          const contractWarning = result.openapiContractAudit
            ? formatOpenApiContractAuditWarning(result.openapiContractAudit, contractProtocol)
            : undefined;
          if (contractWarning) dependencies.core.warning(userSafeWarning(contractWarning));
          const multiProvenance = result.provenance
            ? sanitizeJsonValue(
                buildDeployedSourceProvenance({
                  inputs,
                  apiId: candidate.id,
                  gatewayType: provider.type === 'api-gateway' ? gatewayType : undefined,
                  content: result.content,
                  sourceTier: provider.type,
                  base: result.provenance
                })
              )
            : undefined;
          discovered.push({
            serviceName,
            specPath: relativeSpecPath,
            gatewayId: candidate.id,
            gatewayType,
            stage: result.stage ?? '',
            providerType: provider.type,
            specFormat: result.format,
            contractOrigin,
            variantCount,
            metadataPath: metadataSidecar ? path.join(inputs.outputDir, folderName, metadataSidecar.filename).replace(/\\/g, '/') : undefined,
            openapiContractAudit: result.openapiContractAudit,
            provenance: multiProvenance,
            ...derivedOpenApi
          });
          dependencies.core.info(`Exported ${provider.type} candidate ${candidate.id} (${candidate.name}) to ${relativeSpecPath}`);
        } catch (error) {
          summary.failed += 1;
          dependencies.core.warning(
            userSafeWarning(
              `Attempted export of ${provider.type} candidate ${candidate.id} (${candidate.name}) in region ${inputs.awsRegion} failed: ${formatUserSafeError(error)}. Continuing with remaining candidates; this failure increments the export summary failed count. Grant ${provider.type} export/read permission or verify the service is available in this region.`
            )
          );
        }
      }
    });
  }

  return { discovered, summary };
}

export function buildExecutionOutputs(result: {
  mode: ActionMode;
  discovered: DiscoveredService[];
  resolution?: ResolutionResult;
  exportSummary?: DiscoverySummary;
  providerProbes?: import('./contracts.js').ProviderProbeResult[];
}): Record<string, string> {
  if (result.mode === 'discover-many') {
    const discovered = result.discovered;
    const summary = result.exportSummary ?? { attempted: discovered.length, exported: discovered.length, failed: 0, skipped: 0 };
    const unresolved = summary.failed > 0;
    return {
      'services-json': JSON.stringify(discovered),
      'service-count': String(discovered.length),
      'resolution-status': unresolved ? 'unresolved' : 'resolved',
      'source-type': 'discover-many',
      'mapping-confidence': unresolved ? '0' : discovered.length > 0 ? '100' : '0',
      'export-summary-json': JSON.stringify(summary),
      'resolution-json': JSON.stringify(
        sanitizeJsonValue({
          status: unresolved ? 'unresolved' : 'resolved',
          sourceType: 'discover-many',
          serviceName: 'multiple-services',
          confidence: unresolved ? 0 : discovered.length > 0 ? 100 : 0,
          evidence: [
            `discover-many exported ${summary.exported} service(s)`,
            ...(summary.failed > 0 ? [`${summary.failed} export(s) failed`] : [])
          ],
          count: discovered.length,
          summary,
          providerProbes: result.providerProbes ?? [],
          services: discovered
        })
      ),
      'service-name': '',
      'gateway-id': '',
      'spec-path': '',
      'candidates-json': '',
      'provider-type': discovered.length > 0 ? (discovered[0]?.providerType ?? '') : '',
      'spec-format': discovered.length > 0 ? (discovered[0]?.specFormat ?? '') : '',
      'contract-origin': '',
      'contract-metadata-path': '',
      'variant-count': '',
      'derived-openapi-path': '',
      'derived-openapi-version': '',
      'derived-openapi-completeness': '',
      'derived-openapi-format': '',
      'derived-openapi-evidence-json': '',
      'narrowing-strategy': 'none'
    };
  }

  const resolution = result.resolution ?? {
    status: 'unresolved',
    sourceType: 'manual-review',
    serviceName: 'unknown-service',
    confidence: 0,
    evidence: ['No resolution result produced']
  };
  const resolutionWithProbes = sanitizeJsonValue({
    ...resolution,
    providerProbes: resolution.providerProbes ?? result.providerProbes ?? []
  });
  return {
    'resolution-json': JSON.stringify(resolutionWithProbes),
    'resolution-status': resolution.status,
    'source-type': resolution.sourceType,
    'mapping-confidence': String(resolution.confidence),
    'service-name': resolution.serviceName,
    'gateway-id': resolution.gatewayId ?? '',
    'spec-path': resolution.specPath ?? '',
    'services-json': '[]',
    'service-count': '0',
    'export-summary-json': JSON.stringify({ attempted: 0, exported: 0, failed: 0, skipped: 0 }),
    'candidates-json':
      resolution.status === 'unresolved' && (resolution.rankedCandidates?.length ?? 0) >= 2
        ? JSON.stringify(resolution.rankedCandidates)
        : '',
    'provider-type': resolution.providerType ?? (resolution.sourceType === 'gateway-export' ? 'api-gateway' : ''),
    'spec-format': resolution.specFormat ?? '',
    'contract-origin': resolution.contractOrigin ?? '',
    'contract-metadata-path': resolution.metadataPath ?? '',
    'variant-count': resolution.variantCount !== undefined ? String(resolution.variantCount) : '',
    'derived-openapi-path': resolution.derivedOpenApiPath ?? '',
    'derived-openapi-version': resolution.derivedOpenApiVersion ?? '',
    'derived-openapi-completeness': resolution.derivedOpenApiCompleteness ?? '',
    'derived-openapi-format': resolution.derivedOpenApiFormat ?? '',
    'derived-openapi-evidence-json': JSON.stringify(resolution.derivedOpenApiEvidence ?? []),
    'narrowing-strategy': resolution.narrowing?.tier ?? 'none'
  };
}

export async function execute(inputs: ResolvedInputs, dependencies: DiscoveryDependencies): Promise<ExecutionResult> {
  await runPreflight(inputs, dependencies);

  if (inputs.mode === 'discover-many') {
    // One aggregate remote-fetch byte budget for this execution's default providers.
    const fetchByteBudget: FetchByteBudget = { totalBytes: 0 };
    const fetchRemoteSpec = withSharedFetchBudget(fetchSpecFromUrl, fetchByteBudget);
    // Use injected registry or build one and auto-detect via IAM probing
    const registry =
      dependencies.providerRegistry ?? buildProviderRegistry(inputs, dependencies.aws, { fetchSpecFromUrl: fetchRemoteSpec });
    let discoverManyProbes: import('./contracts.js').ProviderProbeResult[] = [];
    const availableProviders = dependencies.providerRegistry
      ? registry.all()
      : await dependencies.core.group('Probe available providers', async () => {
          const { availableProviders: probed, probes } = await registry.probeAvailableDetailed();
          discoverManyProbes = probes;
          dependencies.core.info(`Available providers: ${probed.map((p) => p.type).join(', ') || 'api-gateway only'}`);
          return probed;
        });

    // Always include API Gateway discovery (backward compat)
    const apiGwProvider = registry.get('api-gateway');
    if (availableProviders.length === 0 && apiGwProvider) {
      availableProviders.push(apiGwProvider);
    }

    // One run-scoped static IaC resolution shared by inventory and signal collection.
    const staticIac = buildStaticIacOptions(inputs, dependencies.staticIac);

    // Deterministic repository service groups first (repo-first precedence).
    const repoGroups = await dependencies.core.group('Discover repository service groups', async () =>
      discoverRepoServiceGroups(inputs, dependencies, staticIac)
    );

    // Run legacy API Gateway discovery next (preserves existing behavior and tests)
    const { discovered: legacyDiscovered, summary: legacySummary } = await runDiscovery(inputs, dependencies);

    // Run additional providers (skip api-gateway since we already ran it via legacy path)
    const extraProviders = availableProviders.filter((p) => p.type !== 'api-gateway');
    let extraDiscovered: DiscoveredService[] = [];
    let extraSummary: DiscoverySummary = { attempted: 0, exported: 0, failed: 0, skipped: 0 };
    const signals = await collectRepoSignals(
      inputs.repoRoot,
      inputs.repoContext.repoSlug,
      inputs.expectedServiceName,
      inputs.expectedGatewayIds,
      { staticIac }
    );
    const snsResolutionContext: SnsContractResolutionContext = {
      serviceHints: signals.serviceHints,
      bridgeEvidence: collectSnsEventBridgeBridgeEvidence(signals)
    };

    if (extraProviders.length > 0) {
      const extraResult = await runMultiProviderDiscovery(extraProviders, inputs, dependencies, snsResolutionContext);
      extraDiscovered = extraResult.discovered;
      extraSummary = extraResult.summary;
    }

    const awsDiscovered = [...legacyDiscovered, ...extraDiscovered].filter(
      (service) => !repoGroups.nativePaths.has(service.specPath)
    );
    const discovered = [...repoGroups.discovered, ...awsDiscovered];
    const summary: DiscoverySummary = {
      attempted: repoGroups.summary.attempted + legacySummary.attempted + extraSummary.attempted,
      exported: repoGroups.summary.exported + legacySummary.exported + extraSummary.exported,
      failed: repoGroups.summary.failed + legacySummary.failed + extraSummary.failed,
      skipped: repoGroups.summary.skipped + legacySummary.skipped + extraSummary.skipped
    };

    if (summary.failed > 0) {
      dependencies.core.warning(
        userSafeWarning(
          `discover-many partial success: attempted=${summary.attempted}, exported=${summary.exported}, failed=${summary.failed}, skipped=${summary.skipped}. Successful artifacts remain but resolution-status is unresolved. Inspect export-summary-json and preceding warnings, fix IAM/stage/source errors, then re-run.`
        )
      );
    }
    return {
      mode: inputs.mode,
      discovered,
      exportSummary: summary,
      outputs: buildExecutionOutputs({ mode: inputs.mode, discovered, exportSummary: summary, providerProbes: dependencies.providerRegistry ? [] : discoverManyProbes })
    };
  }

  // One aggregate byte budget shared by default SSM/SNS providers and runResolution remote fetches.
  const fetchByteBudget: FetchByteBudget = { totalBytes: 0 };
  const fetchRemoteSpec = withSharedFetchBudget(fetchSpecFromUrl, fetchByteBudget);
  const registry =
    dependencies.providerRegistry ?? buildProviderRegistry(inputs, dependencies.aws, { fetchSpecFromUrl: fetchRemoteSpec });
  let resolveOneProbes: import('./contracts.js').ProviderProbeResult[] = [];
  const providers = dependencies.providerRegistry
    ? registry.all()
    : await dependencies.core.group('Probe available providers', async () => {
        const { availableProviders: probed, probes } = await registry.probeAvailableDetailed();
        resolveOneProbes = probes;
        dependencies.core.info(`Available providers: ${probed.map((p) => p.type).join(', ') || 'api-gateway only'}`);
        return probed;
      });
  const resolution = await runResolution(inputs, dependencies.aws, dependencies.core, dependencies.writeSpecFile, {
    providers,
    // Pass the unwrapped default plus the shared budget so runResolution does not create a second budget.
    fetchByteBudget
  });
  if (!dependencies.providerRegistry) {
    resolution.providerProbes = resolveOneProbes;
  }
  return {
    mode: inputs.mode,
    discovered: [],
    resolution,
    outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution })
  };
}

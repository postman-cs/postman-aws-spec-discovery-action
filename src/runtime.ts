import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  actionContract,
  type ActionMode,
  type DiscoveredService,
  type GatewayType,
  type OpenApiContractAudit,
  type ProviderType,
  type ResolutionResult,
  type SourceType,
  type SpecFormat
} from './contracts.js';
import { parseAwsError, type AwsGatewayClient, type GatewayDomainMapping, type HttpApiSummary, type RestApiSummary } from './lib/aws/client.js';
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
import { formatUserSafeError, sanitizeLogMessage } from './lib/logging/sanitize.js';
import { detectRepoContext, type RepoContext } from './lib/repo/context.js';
import { findExistingRepoSpecTyped } from './lib/repo/specs.js';
import { collectRepoSignals } from './lib/repo/signals.js';
import { chooseSource } from './lib/resolve/source-selector.js';
import { resolveServiceCandidate } from './lib/resolve/service-resolver.js';
import {
  formatOpenApiContractAuditWarning,
  normalizeOpenApiYaml,
  type OperationIdRename
} from './lib/spec/normalize-openapi.js';
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
import { runNarrowingPipeline } from './lib/resolve/narrowing-pipeline.js';
import { detectCatalogApis } from './lib/repo/catalog.js';
import { fetchSpecFromUrl } from './lib/fetch/spec-fetcher.js';
import { resolvePathWithinRoot } from './lib/utils/resolve-path-within-root.js';
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

interface ResolutionStageSelection {
  stage?: string;
  useLatestConfig?: boolean;
  evidence: string[];
  error?: string;
}

export interface DiscoveryDependencies {
  core: ReporterLike;
  aws: AwsGatewayClient;
  writeSpecFile(outputPath: string, content: string): Promise<void>;
  /** Optional override for the provider registry. When omitted, providers are auto-detected via IAM probing. */
  providerRegistry?: ProviderRegistry;
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
    catalogApis: Awaited<ReturnType<typeof detectCatalogApis>>;
    eventBridgeClient?: EventBridgeSchemasSpecClient;
    codeDerivedResolver?: ResolveCodeDerivedContract;
  }) => SnsResolutionProvider;
  eventBridgeClient?: EventBridgeSchemasSpecClient;
  codeDerivedResolver?: ResolveCodeDerivedContract;
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

  return {
    mode,
    awsRegion,
    repoRoot,
    repoContext,
    expectedServiceName,
    expectedGatewayIds: [...new Set(expectedGatewayIds)],
    stage,
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

export function readActionInputs(inputReader: InputReaderLike): ResolvedInputs {
  const requiredRegion = inputReader.getInput('aws-region').trim();
  return resolveInputs({
    ...process.env,
    INPUT_AWS_REGION: requiredRegion || undefined,
    INPUT_GATEWAY_ID: normalizeInputValue(inputReader.getInput('gateway-id')),
    INPUT_STAGE: normalizeInputValue(inputReader.getInput('stage')),
    INPUT_OUTPUT_DIR: normalizeInputValue(inputReader.getInput('output-dir')) ?? actionContract.inputs['output-dir'].default
  });
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
    result = normalizeOpenApiYaml(body);
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
  const contractWarning = result.openapiContractAudit
    ? formatOpenApiContractAuditWarning(result.openapiContractAudit)
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

async function selectStage(aws: AwsGatewayClient, candidate: GatewayCandidate, preferredStage: string | undefined): Promise<string | undefined> {
  if (preferredStage) {
    return preferredStage;
  }
  if (candidate.gatewayType === 'REST') {
    const stages = await aws.listRestStages(candidate.id);
    return stages[0];
  }
  const stages = await aws.listHttpStages(candidate.id);
  return stages[0];
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

async function safeListRestApis(awsClient: AwsGatewayClient, actionCore: Pick<ReporterLike, 'warning'>): Promise<RestApiSummary[]> {
  try {
    return await awsClient.listRestApis();
  } catch (error) {
    actionCore.warning(userSafeWarning(`Skipping REST API enumeration: ${formatUserSafeError(error)}`));
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
    actionCore.warning(userSafeWarning(`Skipping HTTP API enumeration: ${formatUserSafeError(error)}`));
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

function catalogFormatFor(type: string | undefined, reference: string | undefined): { format?: SpecFormat; filename: string } {
  const normalizedType = (type ?? '').toLowerCase();
  const normalizedRef = (reference ?? '').toLowerCase();
  if (normalizedType === 'graphql' || normalizedRef.endsWith('.graphql') || normalizedRef.endsWith('.gql')) {
    return { format: 'graphql-sdl', filename: 'schema.graphql' };
  }
  if (normalizedType === 'asyncapi' || normalizedRef.includes('asyncapi')) {
    return { format: normalizedRef.endsWith('.json') ? 'asyncapi-json' : 'asyncapi-yaml', filename: normalizedRef.endsWith('.json') ? 'asyncapi.json' : 'asyncapi.yaml' };
  }
  if (normalizedType === 'grpc' || normalizedRef.endsWith('.proto')) {
    return { format: 'protobuf', filename: 'schema.proto' };
  }
  if (normalizedRef.endsWith('.json')) {
    return { format: 'openapi-json', filename: 'index.json' };
  }
  return { format: 'openapi-yaml', filename: 'index.yaml' };
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

  return {
    status: 'resolved',
    sourceType: resolved.sourceType,
    serviceName,
    confidence: resolved.confidence,
    specPath: relativeProviderPath,
    gatewayId: resolved.candidate.id,
    gatewayType: (resolved.candidate.meta.gatewayType ?? 'REST') as GatewayType,
    providerType: resolved.provider.type,
    specFormat: result.format,
    metadataPath: relativeMetadataPath,
    stage: result.stage,
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

function pickPreferredStage(stages: string[]): string | undefined {
  const priority = ['prod', 'production', '$default', 'main', 'staging', 'stage', 'dev', 'development'];
  const lowered = new Map(stages.map((stage) => [stage.toLowerCase(), stage]));
  for (const preferred of priority) {
    const match = lowered.get(preferred);
    if (match) {
      return match;
    }
  }
  return undefined;
}

async function resolveStageSelection(aws: AwsGatewayClient, candidate: GatewayCandidate, preferredStage: string | undefined): Promise<ResolutionStageSelection> {
  const stages = candidate.gatewayType === 'REST' ? await aws.listRestStages(candidate.id) : await aws.listHttpStages(candidate.id);
  if (preferredStage) {
    if (stages.includes(preferredStage)) {
      return { stage: preferredStage, evidence: [`Using explicitly requested stage ${preferredStage}`] };
    }
    return { evidence: [], error: `Requested stage ${preferredStage} was not found for ${candidate.gatewayType} API ${candidate.id}` };
  }
  if (stages.length === 0) {
    if (candidate.gatewayType === 'HTTP' || candidate.gatewayType === 'WEBSOCKET') {
      return {
        useLatestConfig: true,
        evidence: [`No deployed stage found; exporting latest ${candidate.gatewayType} API configuration without stage`]
      };
    }
    return { evidence: [], error: `No stages were found for REST API ${candidate.id}` };
  }
  if (stages.length === 1) {
    return { stage: stages[0], evidence: [`Auto-selected only available stage ${stages[0]}`] };
  }
  const preferred = pickPreferredStage(stages);
  if (preferred) {
    return { stage: preferred, evidence: [`Auto-selected preferred stage ${preferred}`] };
  }
  return { evidence: [], error: `Multiple stages found with no deterministic match: ${stages.join(', ')}` };
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

async function runPreflight(inputs: ResolvedInputs, dependencies: DiscoveryDependencies): Promise<void> {
  if (!inputs.preflightChecks) {
    dependencies.core.info('Preflight checks skipped by configuration');
    return;
  }
  let identity: Awaited<ReturnType<typeof dependencies.aws.getCallerIdentity>>;
  try {
    identity = await dependencies.aws.getCallerIdentity();
  } catch (error) {
    const parsed = parseAwsError(error);
    const name = parsed.name ?? '';
    if (name === 'ExpiredTokenException' || name === 'ExpiredToken') {
      throw new Error(
        userSafeWarning(
          'AWS credentials are expired; refresh the role/session (re-assume the role or rotate the access keys) and re-run.'
        ),
        { cause: error }
      );
    }
    if (name === 'AccessDeniedException' || name === 'AccessDenied') {
      throw new Error(
        userSafeWarning(
          'The AWS identity cannot call sts:GetCallerIdentity; the credentials are malformed or the principal is denied STS. Check the role/keys and trust policy.'
        ),
        { cause: error }
      );
    }
    if (name === 'CredentialsProviderError') {
      throw new Error(
        userSafeWarning(
          'No AWS credentials were resolved from the provider chain (env, profile, OIDC, instance role). Configure credentials for this runner.'
        ),
        { cause: error }
      );
    }
    throw error;
  }
  if (inputs.preflightPermissionProbe) {
    try {
      await dependencies.aws.probeApiGatewayReadAccess();
    } catch (error) {
      dependencies.core.warning(
        userSafeWarning(`API Gateway REST preflight probe failed; other provider discovery will continue: ${formatUserSafeError(error)}`)
      );
    }
  }
  const accountSuffix = identity.accountId ? identity.accountId.slice(-4) : 'unknown';
  dependencies.core.info(
    `Preflight OK: region=${inputs.awsRegion}, account=***${accountSuffix}, identity=${identity.arn ? 'available' : 'unknown'}`
  );
}

export async function runDiscovery(inputs: ResolvedInputs, dependencies: DiscoveryDependencies): Promise<{ discovered: DiscoveredService[]; summary: DiscoverySummary }> {
  const restStart = Date.now();
  const restApis = await dependencies.core.group('Discover REST APIs', async () => {
    const items = await safeListRestApis(dependencies.aws, dependencies.core);
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

  await dependencies.core.group('Export OpenAPI specs', async () => {
    for (const candidate of selectedCandidates) {
      try {
        const stage = await selectStage(dependencies.aws, candidate, inputs.stage);
        if (!stage && candidate.gatewayType !== 'WEBSOCKET') {
          summary.skipped += 1;
          dependencies.core.warning(userSafeWarning(`Skipping ${candidate.gatewayType} API ${candidate.id} (${candidate.name}) because no stage is available`));
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

        const exportedStage = stage ?? '';
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
        discovered.push({
          serviceName,
          specPath: relativeSpecPath,
          gatewayId: candidate.id,
          gatewayType: candidate.gatewayType,
          stage: exportedStage,
          providerType: 'api-gateway',
          specFormat: 'openapi-yaml',
          openapiContractAudit: normalized.openapiContractAudit,
          ...derivedOpenApi
        });
        for (const evidence of exported.evidence) {
          dependencies.core.info(evidence);
        }
        dependencies.core.info(`Exported ${candidate.gatewayType} API ${candidate.id} (${candidate.name}) to ${relativeSpecPath}`);
      } catch (error) {
        summary.failed += 1;
        dependencies.core.warning(
          userSafeWarning(`Failed exporting ${candidate.gatewayType} API ${candidate.id} (${candidate.name}): ${formatUserSafeError(error)}`)
        );
      }
    }
  });

  return { discovered, summary };
}

export async function runResolution(
  inputs: ResolvedInputs,
  awsClient: AwsGatewayClient,
  actionCore: Pick<ReporterLike, 'group' | 'info' | 'warning'>,
  writeSpecFile: (outputPath: string, content: string) => Promise<void>,
  resolutionDependencies: ResolutionDependencies = {}
): Promise<ResolutionResult> {
  // Check for Backstage catalog-info.yaml first -- it may reference a spec path
  const catalogApis = await detectCatalogApis(inputs.repoRoot);
  const catalogApi = catalogApis?.[0];
  const catalogSpecPath = catalogApi?.specPath;
  const catalogSpecUrl = catalogApi?.specUrl;

  const repoSpec = await findExistingRepoSpecTyped(inputs.repoRoot);
  let existingSpecPath: string | undefined;
  let existingSpecFormat: SpecFormat | undefined;
  let existingSpecEvidence: string[] | undefined;
  let existingSpecContent: string | undefined;
  let existingSpecShouldWriteNative = false;

  if (catalogSpecPath) {
    const resolvedCatalogPath = resolvePathWithinRoot(inputs.repoRoot, catalogSpecPath, 'catalog-spec-path');
    const catalogStat = await stat(resolvedCatalogPath).catch(() => undefined);
    if (catalogStat?.isFile()) {
      existingSpecPath = catalogSpecPath.replace(/\\/g, '/');
      existingSpecFormat = catalogFormatFor(catalogApi?.type, catalogSpecPath).format;
      existingSpecEvidence = [`Resolved from Backstage catalog local ${catalogApi?.type ?? 'api'} definition`];
    } else {
      actionCore.warning(userSafeWarning(`Backstage catalog spec path ${catalogSpecPath} was not found; continuing discovery`));
    }
  }

  if (!existingSpecPath && repoSpec) {
    existingSpecPath = repoSpec.path;
    existingSpecFormat = repoSpec.format;
    existingSpecEvidence = repoSpec.evidence;
  }

  // If Backstage catalog references a remote URL and no local spec exists, fetch it
  if (!existingSpecPath && catalogSpecUrl) {
    try {
      actionCore.info(`Fetching spec from Backstage catalog URL: ${catalogSpecUrl}`);
      const fetched = await fetchSpecFromUrl(catalogSpecUrl, { timeoutMs: 15000 });
      const folderName = catalogApi?.name ?? 'catalog-api';
      const catalogFormat = catalogFormatFor(catalogApi?.type, catalogSpecUrl);
      const targetPath = path.join(inputs.outputDir, folderName, catalogFormat.filename);
      existingSpecPath = targetPath.replace(/\\/g, '/');
      existingSpecFormat = catalogFormat.format;
      existingSpecEvidence = [`Resolved from Backstage catalog remote ${catalogApi?.type ?? 'api'} definition`];
      existingSpecContent = fetched.content;
      existingSpecShouldWriteNative = true;
      actionCore.info(`Fetched remote spec from catalog URL for ${existingSpecPath}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      actionCore.warning(`Failed to fetch spec from catalog URL ${catalogSpecUrl}: ${detail}`);
    }
  }

  const signals = await collectRepoSignals(inputs.repoRoot, inputs.repoContext.repoSlug, inputs.expectedServiceName, inputs.expectedGatewayIds);
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
          await actionCore.group('Resolve REST API candidates', async () => safeListRestApis(awsClient, actionCore)),
          await actionCore.group('Resolve HTTP API candidates', async () => safeListHttpApis(inputs, awsClient, actionCore)),
          inputs.includeV2,
          inputs.apiFilter
        );

  // If too many candidates, try progressive narrowing before failing
  let finalCandidates = uniqueGatewayCandidates([...domainResolution.candidates, ...narrowedCandidates]);
  if (inputs.maxCandidates > 0 && finalCandidates.length > inputs.maxCandidates) {
    const candidateCountBeforeNarrowing = finalCandidates.length;
    const sdkOpts = { requestTimeoutMs: inputs.requestTimeoutMs, maxAttempts: inputs.maxAttempts };
    const narrowingResult = await actionCore.group('Progressive narrowing', async () => {
      let cfnClient: CloudFormationSpecClient | undefined;
      let taggingClient: TaggingSpecClient | undefined;
      try { cfnClient = new CloudFormationSdkClient(inputs.awsRegion, sdkOpts); } catch { /* unavailable */ }
      try { taggingClient = new TaggingSdkClient(inputs.awsRegion, sdkOpts); } catch { /* unavailable */ }

      return runNarrowingPipeline(
        { repoSlug: inputs.repoContext.repoSlug, serviceHints: enrichedSignals.serviceHints, signals: enrichedSignals, cfnClient, taggingClient },
        finalCandidates.map((c) => ({ id: c.id, name: c.name }))
      );
    });

    if (narrowingResult) {
      const narrowedIds = new Set(narrowingResult.gatewayIds);
      finalCandidates = finalCandidates.filter((c) => narrowedIds.has(c.id));
      actionCore.info(`Narrowing (${narrowingResult.tier}) reduced ${candidateCountBeforeNarrowing} candidates to ${finalCandidates.length}`);
    }

    // If still over limit after narrowing, warn instead of hard-fail
    if (inputs.maxCandidates > 0 && finalCandidates.length > inputs.maxCandidates) {
      actionCore.warning(
        userSafeWarning(`${finalCandidates.length} candidates after narrowing still exceeds limit (${inputs.maxCandidates}). Using top ${inputs.maxCandidates} by name relevance.`)
      );
      finalCandidates = finalCandidates.slice(0, inputs.maxCandidates);
    }
  }

  const gateways = [];
  for (const candidate of finalCandidates) {
    const candidateEvidence: string[] = [];
    let tags: Record<string, string> = {};
    try {
      tags = candidate.gatewayType === 'REST' ? await awsClient.getRestTags(candidate.id) : await awsClient.getHttpTags(candidate.id);
    } catch (error) {
      candidateEvidence.push(`Tag lookup failed for ${candidate.id}: ${formatUserSafeError(error)}`);
      actionCore.warning(userSafeWarning(`Tag lookup failed for ${candidate.gatewayType} API ${candidate.id}: ${formatUserSafeError(error)}`));
    }
    gateways.push({ id: candidate.id, name: candidate.name, gatewayType: candidate.gatewayType, tags, evidence: candidateEvidence });
  }

  const resolvedCandidate = resolveServiceCandidate(gateways, enrichedSignals);

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
      fetchSpecFromUrl,
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
      const content = existingSpecContent ?? await readFile(resolvePathWithinRoot(inputs.repoRoot, selectedSource.specPath, 'repo-spec-path'), 'utf8');
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
      stageSelection = await resolveStageSelection(awsClient, selectedGateway, inputs.stage);
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

export function buildProviderRegistry(inputs: ResolvedInputs, awsClient: AwsGatewayClient): ProviderRegistry {
  const sdkOpts = { requestTimeoutMs: inputs.requestTimeoutMs, maxAttempts: inputs.maxAttempts };
  const registry = new ProviderRegistry();

  registry.register(new ApiGatewayProvider(awsClient, { includeV2: inputs.includeV2, apiFilter: inputs.apiFilter }));
  registry.register(new AppSyncProvider(new AppSyncSdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new AppSyncEventsProvider(new AppSyncEventsSdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new EventBridgeSchemasProvider(new EventBridgeSchemasSdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new EventBridgeSurfaceProvider(new EventBridgeSurfaceSdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new CloudFormationProvider(new CloudFormationSdkClient(inputs.awsRegion, sdkOpts), inputs.repoRoot, new S3SdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new GlueSchemaProvider(new GlueSchemaSdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new BedrockActionGroupProvider(new BedrockActionGroupsSdkClient(inputs.awsRegion, sdkOpts), new S3SdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new AlbListenerRulesProvider(new AlbListenerRulesSdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new SsmProvider(new SsmSdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new SnsProvider(new SnsSdkClient(inputs.awsRegion, sdkOpts), inputs.repoRoot, new SsmSdkClient(inputs.awsRegion, sdkOpts)));
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
        dependencies.core.warning(userSafeWarning(`Failed listing candidates from ${provider.type}: ${formatUserSafeError(error)}`));
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
          const contractWarning = result.openapiContractAudit
            ? formatOpenApiContractAuditWarning(result.openapiContractAudit)
            : undefined;
          if (contractWarning) dependencies.core.warning(userSafeWarning(contractWarning));
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
            ...derivedOpenApi
          });
          dependencies.core.info(`Exported ${provider.type} candidate ${candidate.id} (${candidate.name}) to ${relativeSpecPath}`);
        } catch (error) {
          summary.failed += 1;
          dependencies.core.warning(
            userSafeWarning(`Failed exporting ${provider.type} candidate ${candidate.id} (${candidate.name}): ${formatUserSafeError(error)}`)
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
      'resolution-json': JSON.stringify({
        status: unresolved ? 'unresolved' : 'resolved',
        sourceType: 'discover-many',
        count: discovered.length,
        summary
      }),
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
      'derived-openapi-evidence-json': ''
    };
  }

  const resolution = result.resolution ?? {
    status: 'unresolved',
    sourceType: 'manual-review',
    serviceName: 'unknown-service',
    confidence: 0,
    evidence: ['No resolution result produced']
  };
  return {
    'resolution-json': JSON.stringify(resolution),
    'resolution-status': resolution.status,
    'source-type': resolution.sourceType,
    'mapping-confidence': String(resolution.confidence),
    'service-name': resolution.serviceName,
    'gateway-id': resolution.gatewayId ?? '',
    'spec-path': resolution.specPath ?? '',
    'services-json': '[]',
    'service-count': '0',
    'export-summary-json': JSON.stringify({ attempted: 0, exported: 0, failed: 0, skipped: 0 }),
    'candidates-json': '',
    'provider-type': resolution.providerType ?? (resolution.sourceType === 'gateway-export' ? 'api-gateway' : ''),
    'spec-format': resolution.specFormat ?? '',
    'contract-origin': resolution.contractOrigin ?? '',
    'contract-metadata-path': resolution.metadataPath ?? '',
    'variant-count': resolution.variantCount !== undefined ? String(resolution.variantCount) : '',
    'derived-openapi-path': resolution.derivedOpenApiPath ?? '',
    'derived-openapi-version': resolution.derivedOpenApiVersion ?? '',
    'derived-openapi-completeness': resolution.derivedOpenApiCompleteness ?? '',
    'derived-openapi-format': resolution.derivedOpenApiFormat ?? '',
    'derived-openapi-evidence-json': JSON.stringify(resolution.derivedOpenApiEvidence ?? [])
  };
}

export async function execute(inputs: ResolvedInputs, dependencies: DiscoveryDependencies): Promise<ExecutionResult> {
  await runPreflight(inputs, dependencies);

  if (inputs.mode === 'discover-many') {
    // Use injected registry or build one and auto-detect via IAM probing
    const registry = dependencies.providerRegistry ?? buildProviderRegistry(inputs, dependencies.aws);
    const availableProviders = dependencies.providerRegistry
      ? registry.all()
      : await dependencies.core.group('Probe available providers', async () => {
          const available = await registry.probeAvailable();
          dependencies.core.info(`Available providers: ${available.map((p) => p.type).join(', ') || 'api-gateway only'}`);
          return available;
        });

    // Always include API Gateway discovery (backward compat)
    const apiGwProvider = registry.get('api-gateway');
    if (availableProviders.length === 0 && apiGwProvider) {
      availableProviders.push(apiGwProvider);
    }

    // Run legacy API Gateway discovery first (preserves existing behavior and tests)
    const { discovered: legacyDiscovered, summary: legacySummary } = await runDiscovery(inputs, dependencies);

    // Run additional providers (skip api-gateway since we already ran it via legacy path)
    const extraProviders = availableProviders.filter((p) => p.type !== 'api-gateway');
    let extraDiscovered: DiscoveredService[] = [];
    let extraSummary: DiscoverySummary = { attempted: 0, exported: 0, failed: 0, skipped: 0 };
    const signals = await collectRepoSignals(inputs.repoRoot, inputs.repoContext.repoSlug, inputs.expectedServiceName, inputs.expectedGatewayIds);
    const snsResolutionContext: SnsContractResolutionContext = {
      serviceHints: signals.serviceHints,
      bridgeEvidence: collectSnsEventBridgeBridgeEvidence(signals)
    };

    if (extraProviders.length > 0) {
      const extraResult = await runMultiProviderDiscovery(extraProviders, inputs, dependencies, snsResolutionContext);
      extraDiscovered = extraResult.discovered;
      extraSummary = extraResult.summary;
    }

    const discovered = [...legacyDiscovered, ...extraDiscovered];
    const summary: DiscoverySummary = {
      attempted: legacySummary.attempted + extraSummary.attempted,
      exported: legacySummary.exported + extraSummary.exported,
      failed: legacySummary.failed + extraSummary.failed,
      skipped: legacySummary.skipped + extraSummary.skipped
    };

    if (summary.failed > 0) {
      dependencies.core.warning(
        userSafeWarning(`discover-many encountered ${summary.failed} export failure(s); strict mode marks resolution as unresolved`)
      );
    }
    return {
      mode: inputs.mode,
      discovered,
      exportSummary: summary,
      outputs: buildExecutionOutputs({ mode: inputs.mode, discovered, exportSummary: summary })
    };
  }

  const registry = dependencies.providerRegistry ?? buildProviderRegistry(inputs, dependencies.aws);
  const providers = dependencies.providerRegistry
    ? registry.all()
    : await dependencies.core.group('Probe available providers', async () => {
        const available = await registry.probeAvailable();
        dependencies.core.info(`Available providers: ${available.map((p) => p.type).join(', ') || 'api-gateway only'}`);
        return available;
      });
  const resolution = await runResolution(inputs, dependencies.aws, dependencies.core, dependencies.writeSpecFile, { providers });
  return {
    mode: inputs.mode,
    discovered: [],
    resolution,
    outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution })
  };
}

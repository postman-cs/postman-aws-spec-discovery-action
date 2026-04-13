import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  actionContract,
  type ActionMode,
  type DiscoveredService,
  type GatewayType,
  type ResolutionResult
} from './contracts.js';
import { parseAwsError, type AwsGatewayClient, type HttpApiSummary, type RestApiSummary } from './lib/aws/client.js';
import { AppSyncSdkClient } from './lib/aws/appsync-client.js';
import { EventBridgeSchemasSdkClient } from './lib/aws/schemas-client.js';
import { CloudFormationSdkClient, type CloudFormationSpecClient } from './lib/aws/cloudformation-client.js';
import { GlueSchemaSdkClient } from './lib/aws/glue-client.js';
import { formatUserSafeError, sanitizeLogMessage } from './lib/logging/sanitize.js';
import { detectRepoContext, type RepoContext } from './lib/repo/context.js';
import { findExistingRepoSpecTyped } from './lib/repo/specs.js';
import { collectRepoSignals } from './lib/repo/signals.js';
import { chooseSource } from './lib/resolve/source-selector.js';
import { resolveServiceCandidate } from './lib/resolve/service-resolver.js';
import { ProviderRegistry } from './lib/providers/registry.js';
import { ApiGatewayProvider } from './lib/providers/api-gateway.js';
import { AppSyncProvider } from './lib/providers/appsync.js';
import { EventBridgeSchemasProvider } from './lib/providers/eventbridge-schemas.js';
import { CloudFormationProvider } from './lib/providers/cloudformation.js';
import { GlueSchemaProvider } from './lib/providers/glue.js';
import { SsmProvider } from './lib/providers/ssm.js';
import { SnsProvider } from './lib/providers/sns.js';
import { SsmSdkClient } from './lib/aws/ssm-client.js';
import { SnsSdkClient } from './lib/aws/sns-client.js';
import { TaggingSdkClient, type TaggingSpecClient } from './lib/aws/tagging-client.js';
import { runNarrowingPipeline } from './lib/resolve/narrowing-pipeline.js';
import { detectCatalogApis } from './lib/repo/catalog.js';
import { fetchSpecFromUrl } from './lib/fetch/spec-fetcher.js';
import type { EventBridgeSchemasSpecClient } from './lib/aws/schemas-client.js';
import type { SpecProvider, SpecCandidate, SpecExportResult } from './lib/providers/types.js';
import type { SnsContractResolutionContext, SnsContractResult } from './lib/providers/sns.js';
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
  snsProvider?: SnsResolutionProvider;
  createSnsProvider?: (dependencies: {
    fetchSpecFromUrl: typeof fetchSpecFromUrl;
    catalogApis: Awaited<ReturnType<typeof detectCatalogApis>>;
    eventBridgeClient?: EventBridgeSchemasSpecClient;
    codeDerivedResolver?: unknown;
  }) => SnsResolutionProvider;
  eventBridgeClient?: EventBridgeSchemasSpecClient;
  codeDerivedResolver?: unknown;
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
  const envName = `INPUT_${name.replace(/-/g, '_').toUpperCase()}`;
  return normalizeInputValue(env[envName]);
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

function parsePositiveInteger(input: string | undefined, inputName: string, fallback: number): number {
  if (!input) {
    return fallback;
  }
  const value = Number.parseInt(input, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${inputName} must be a non-negative integer, got: ${input}`);
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
  const awsRegion = getInput('aws-region', env) ?? '';
  if (!awsRegion) {
    throw new Error('aws-region is required');
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
    maxCandidates: parsePositiveInteger(maxCandidatesRaw, 'max-candidates', 50),
    dryRun: parseBoolean(dryRunRaw, 'dry-run', false),
    preflightChecks: parseBoolean(preflightChecksRaw, 'preflight-checks', true),
    preflightPermissionProbe: parseBoolean(preflightPermissionProbeRaw, 'preflight-permission-probe', true),
    requestTimeoutMs: parsePositiveInteger(requestTimeoutMsRaw, 'request-timeout-ms', 30000),
    maxAttempts: parsePositiveInteger(maxAttemptsRaw, 'max-attempts', 3),
    includeV2: parseBoolean(includeV2Raw, 'include-v2', true)
  };
}

export function readActionInputs(inputReader: InputReaderLike): ResolvedInputs {
  const requiredRegion = inputReader.getInput('aws-region', { required: true }).trim();
  return resolveInputs({
    INPUT_AWS_REGION: requiredRegion,
    INPUT_GATEWAY_ID: normalizeInputValue(inputReader.getInput('gateway-id')),
    INPUT_STAGE: normalizeInputValue(inputReader.getInput('stage')),
    INPUT_OUTPUT_DIR: normalizeInputValue(inputReader.getInput('output-dir')) ?? actionContract.inputs['output-dir'].default,
    ...process.env
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

function resolvePathWithinRoot(rootPath: string, targetPath: string, fieldName: string): string {
  const base = path.resolve(rootPath);
  const resolved = path.resolve(base, targetPath);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${fieldName} must stay within repo-root/workspace; received ${targetPath}`);
  }
  return resolved;
}

function userSafeWarning(message: string): string {
  return sanitizeLogMessage(message);
}

export async function defaultWriteSpecFile(outputPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, 'utf8');
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
          gatewayType: (api.protocolType === 'WEBSOCKET' ? 'WEBSOCKET' : 'HTTP') as GatewayType
        }))
    : [];
  const all = [...rest, ...http];
  return apiFilter ? all.filter((api) => apiFilter.test(api.name)) : all;
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

function inferFallbackServiceName(inputs: ResolvedInputs): string | undefined {
  return inputs.expectedServiceName ?? inputs.repoContext.repoSlug?.split('/').pop()?.trim() ?? inputs.repoContext.repoUrl?.split('/').pop()?.trim();
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
    if (candidate.gatewayType === 'HTTP') {
      return { useLatestConfig: true, evidence: ['No deployed stage found; exporting latest HTTP API configuration without stage'] };
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

async function runPreflight(inputs: ResolvedInputs, dependencies: DiscoveryDependencies): Promise<void> {
  if (!inputs.preflightChecks) {
    dependencies.core.info('Preflight checks skipped by configuration');
    return;
  }
  const identity = await dependencies.aws.getCallerIdentity();
  if (inputs.preflightPermissionProbe) {
    await dependencies.aws.probeApiGatewayReadAccess();
  }
  const accountSuffix = identity.accountId ? identity.accountId.slice(-4) : 'unknown';
  dependencies.core.info(
    `Preflight OK: region=${inputs.awsRegion}, account=***${accountSuffix}, identity=${identity.arn ? 'available' : 'unknown'}`
  );
}

export async function runDiscovery(inputs: ResolvedInputs, dependencies: DiscoveryDependencies): Promise<{ discovered: DiscoveredService[]; summary: DiscoverySummary }> {
  const restStart = Date.now();
  const restApis = await dependencies.core.group('Discover REST APIs', async () => {
    const items = await dependencies.aws.listRestApis();
    dependencies.core.info(`Found ${items.length} REST API(s) in ${Date.now() - restStart}ms`);
    return items;
  });
  const httpStart = Date.now();
  const httpApis = await dependencies.core.group('Discover HTTP APIs', async () => {
    if (!inputs.includeV2) {
      dependencies.core.info('Skipping HTTP API discovery because include-v2=false');
      return [] as HttpApiSummary[];
    }
    const items = await dependencies.aws.listHttpApis();
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
        if (!stage) {
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

        const absoluteSpecPath = resolvePathWithinRoot(resolvedRoot, relativeSpecPath, 'output-dir');
        const specBody =
          candidate.gatewayType === 'REST'
            ? await dependencies.aws.exportRestApi(candidate.id, stage)
            : await dependencies.aws.exportHttpApi(candidate.id, stage);
        await dependencies.writeSpecFile(absoluteSpecPath, specBody);
        summary.exported += 1;
        discovered.push({
          serviceName,
          specPath: relativeSpecPath,
          gatewayId: candidate.id,
          gatewayType: candidate.gatewayType,
          stage,
          providerType: 'api-gateway',
          specFormat: 'openapi-yaml'
        });
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
  const catalogSpecPath = catalogApis?.[0]?.specPath;
  const catalogSpecUrl = catalogApis?.[0]?.specUrl;

  const repoSpec = await findExistingRepoSpecTyped(inputs.repoRoot);
  let existingSpecPath = catalogSpecPath ?? repoSpec?.path;

  // If Backstage catalog references a remote URL and no local spec exists, fetch it
  if (!existingSpecPath && catalogSpecUrl) {
    try {
      actionCore.info(`Fetching spec from Backstage catalog URL: ${catalogSpecUrl}`);
      const fetched = await fetchSpecFromUrl(catalogSpecUrl, { timeoutMs: 15000 });
      const folderName = catalogApis?.[0]?.name ?? 'catalog-api';
      const targetPath = path.join(inputs.outputDir, folderName, 'index.yaml');
      const absolutePath = path.resolve(inputs.repoRoot, targetPath);
      await writeSpecFile(absolutePath, fetched.content);
      existingSpecPath = targetPath.replace(/\\/g, '/');
      actionCore.info(`Fetched remote spec from catalog URL and saved to ${existingSpecPath}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      actionCore.warning(`Failed to fetch spec from catalog URL ${catalogSpecUrl}: ${detail}`);
    }
  }

  const signals = await collectRepoSignals(inputs.repoRoot, inputs.repoContext.repoSlug, inputs.expectedServiceName, inputs.expectedGatewayIds);
  const narrowedCandidates =
    inputs.expectedGatewayIds.length > 0
      ? await actionCore.group('Resolve API candidates by explicit gateway ID', async () =>
          lookupCandidatesByIds(inputs, awsClient, actionCore)
        )
      : filterCandidates(
          await actionCore.group('Resolve REST API candidates', async () => awsClient.listRestApis()),
          await actionCore.group('Resolve HTTP API candidates', async () => (inputs.includeV2 ? awsClient.listHttpApis() : [] as HttpApiSummary[])),
          inputs.includeV2,
          inputs.apiFilter
        );

  // If too many candidates, try progressive narrowing before failing
  let finalCandidates = narrowedCandidates;
  if (inputs.maxCandidates > 0 && narrowedCandidates.length > inputs.maxCandidates) {
    const sdkOpts = { requestTimeoutMs: inputs.requestTimeoutMs, maxAttempts: inputs.maxAttempts };
    const narrowingResult = await actionCore.group('Progressive narrowing', async () => {
      let cfnClient: CloudFormationSpecClient | undefined;
      let taggingClient: TaggingSpecClient | undefined;
      try { cfnClient = new CloudFormationSdkClient(inputs.awsRegion, sdkOpts); } catch { /* unavailable */ }
      try { taggingClient = new TaggingSdkClient(inputs.awsRegion, sdkOpts); } catch { /* unavailable */ }

      return runNarrowingPipeline(
        { repoSlug: inputs.repoContext.repoSlug, serviceHints: signals.serviceHints, signals, cfnClient, taggingClient },
        narrowedCandidates.map((c) => ({ id: c.id, name: c.name }))
      );
    });

    if (narrowingResult) {
      const narrowedIds = new Set(narrowingResult.gatewayIds);
      finalCandidates = narrowedCandidates.filter((c) => narrowedIds.has(c.id));
      actionCore.info(`Narrowing (${narrowingResult.tier}) reduced ${narrowedCandidates.length} candidates to ${finalCandidates.length}`);
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

  const resolvedCandidate = resolveServiceCandidate(gateways, signals);

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
  const shouldAttemptSns = signals.providerHints?.includes('sns') ?? false;
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

    const sortedSnsCandidates = sortSnsCandidates(snsCandidates, signals.serviceHints);
    const bridgeEvidence = collectSnsEventBridgeBridgeEvidence(signals);
    const candidatesToTry =
      inputs.maxCandidates > 0 && sortedSnsCandidates.length > inputs.maxCandidates
        ? sortedSnsCandidates.slice(0, inputs.maxCandidates)
        : sortedSnsCandidates;

    for (const candidate of candidatesToTry) {
      try {
        const contract = await snsProvider.resolveContract(candidate, {
          serviceHints: signals.serviceHints,
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
              : Math.max(60, scoreSnsCandidate(candidate, signals.serviceHints)),
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

  const selectedSource = chooseSource({
    existingSpecPath,
    candidate: resolvedCandidate,
    snsCandidate: resolvedSnsCandidate,
    fallbackServiceName: inferFallbackServiceName(inputs)
  });
  if (selectedSource.sourceType === 'repo-spec') {
    return selectedSource;
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
      selectedSource.evidence = [...selectedSource.evidence, 'Dry run enabled; skipped export and file write'];
      return selectedSource;
    }
    const absoluteSpecPath = resolvePathWithinRoot(inputs.repoRoot, relativeSpecPath, 'output-dir');
    try {
      const body =
        selectedSource.gatewayType === 'REST'
          ? await awsClient.exportRestApi(selectedSource.gatewayId, selectedSource.stage ?? '')
          : await awsClient.exportHttpApi(selectedSource.gatewayId, stageSelection.useLatestConfig ? undefined : selectedSource.stage);
      await writeSpecFile(absoluteSpecPath, body);
      selectedSource.specPath = relativeSpecPath;
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
    if (inputs.dryRun) {
      return {
        ...selectedSource,
        specPath: relativeProviderPath,
        metadataPath: relativeMetadataPath,
        evidence: [...selectedSource.evidence, 'Dry run enabled; skipped SNS contract file write']
      };
    }
    const absoluteSpecPath = resolvePathWithinRoot(inputs.repoRoot, relativeProviderPath, 'output-dir');
    await writeSpecFile(absoluteSpecPath, resolvedSnsExport.content);
    for (const sidecar of resolvedSnsExport.sidecars ?? []) {
      const relativeSidecarPath = path.join(relativeProviderDir, sidecar.filename).replace(/\\/g, '/');
      const absoluteSidecarPath = resolvePathWithinRoot(inputs.repoRoot, relativeSidecarPath, 'output-dir');
      await writeSpecFile(absoluteSidecarPath, sidecar.content);
    }
    return {
      ...selectedSource,
      specPath: relativeProviderPath,
      metadataPath: relativeMetadataPath,
      variantCount: selectedSource.variantCount
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
  registry.register(new EventBridgeSchemasProvider(new EventBridgeSchemasSdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new CloudFormationProvider(new CloudFormationSdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new GlueSchemaProvider(new GlueSchemaSdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new SsmProvider(new SsmSdkClient(inputs.awsRegion, sdkOpts)));
  registry.register(new SnsProvider(new SnsSdkClient(inputs.awsRegion, sdkOpts), inputs.repoRoot, new SsmSdkClient(inputs.awsRegion, sdkOpts)));

  return registry;
}

async function runMultiProviderDiscovery(
  providers: SpecProvider[],
  inputs: ResolvedInputs,
  dependencies: DiscoveryDependencies
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
          const result = await provider.exportSpec(candidate, { stage: inputs.stage, dryRun: inputs.dryRun });
          // SNS provider may set candidate.name from postman:project-name; use candidate.name directly.
          const serviceName = candidate.name;
          const baseFolder = projectFolderName(serviceName);
          const next = (slugUsage.get(baseFolder) ?? 0) + 1;
          slugUsage.set(baseFolder, next);
          const folderName = next === 1 ? baseFolder : `${baseFolder}-${candidate.id}`;
          const relativeSpecPath = path.join(inputs.outputDir, folderName, result.filename).replace(/\\/g, '/');
          const absoluteSpecPath = resolvePathWithinRoot(resolvedRoot, relativeSpecPath, 'output-dir');

          await dependencies.writeSpecFile(absoluteSpecPath, result.content);
          for (const sidecar of result.sidecars ?? []) {
            const relativeSidecarPath = path.join(inputs.outputDir, folderName, sidecar.filename).replace(/\\/g, '/');
            const absoluteSidecarPath = resolvePathWithinRoot(resolvedRoot, relativeSidecarPath, 'output-dir');
            await dependencies.writeSpecFile(absoluteSidecarPath, sidecar.content);
          }
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
            metadataPath: metadataSidecar ? path.join(inputs.outputDir, folderName, metadataSidecar.filename).replace(/\\/g, '/') : undefined
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
      'variant-count': ''
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
    'variant-count': resolution.variantCount !== undefined ? String(resolution.variantCount) : ''
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
    if (extraProviders.length > 0) {
      const extraResult = await runMultiProviderDiscovery(extraProviders, inputs, dependencies);
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

  const resolution = await runResolution(inputs, dependencies.aws, dependencies.core, dependencies.writeSpecFile);
  return {
    mode: inputs.mode,
    discovered: [],
    resolution,
    outputs: buildExecutionOutputs({ mode: inputs.mode, discovered: [], resolution })
  };
}

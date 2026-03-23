import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  actionContract,
  contractOutputNames,
  type DiscoveredService,
  type ActionMode,
  type GatewayType,
  type ResolutionResult
} from './contracts.js';
import {
  AwsApiGatewayCliClient,
  type AwsGatewayClient,
  type ExecLike as AwsExecLike,
  type HttpApiSummary,
  type RestApiSummary
} from './lib/aws/client.js';
import { detectRepoContext, type RepoContext } from './lib/repo/context.js';
import { findExistingRepoSpec } from './lib/repo/specs.js';
import { collectRepoSignals } from './lib/repo/signals.js';
import { chooseSource } from './lib/resolve/source-selector.js';
import { resolveServiceCandidate } from './lib/resolve/service-resolver.js';

export interface CoreLike {
  getInput(name: string, options?: { required?: boolean }): string;
  group<T>(name: string, fn: () => Promise<T>): Promise<T>;
  info(message: string): void;
  warning(message: string): void;
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
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
  core: Pick<CoreLike, 'group' | 'info' | 'warning'>;
  aws: AwsGatewayClient;
  writeSpecFile(outputPath: string, content: string): Promise<void>;
}

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

function parseBoolean(input: string | undefined, inputName: string): boolean {
  if (!input) {
    return true;
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
    throw new Error(`Invalid JSON for service-mapping-json: ${detail}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('service-mapping-json must be a JSON object keyed by gateway id');
  }

  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
      key,
      String(value).trim()
    ])
  );
}

function parseStringArrayJson(raw: string, inputName: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON for ${inputName}: ${detail}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${inputName} must be a JSON array`);
  }

  return parsed.map((value) => String(value).trim()).filter((value) => value.length > 0);
}

export function resolveInputs(env: NodeJS.ProcessEnv = process.env): ResolvedInputs {
  const mode = parseMode(getInput('mode', env) ?? actionContract.inputs.mode.default ?? 'resolve-one');
  const awsRegion = getInput('aws-region', env) ?? '';
  if (!awsRegion) {
    throw new Error('aws-region is required');
  }

  const repoRoot =
    getInput('repo-root', env) ??
    normalizeInputValue(env.GITHUB_WORKSPACE) ??
    normalizeInputValue(env.CI_PROJECT_DIR) ??
    actionContract.inputs['repo-root'].default ??
    '.';
  const expectedServiceName = getInput('expected-service-name', env);
  const expectedGatewayIdsRaw =
    getInput('expected-gateway-ids-json', env) ?? actionContract.inputs['expected-gateway-ids-json'].default ?? '[]';
  const stage = getInput('stage', env);
  const apiFilterRaw = getInput('api-filter', env);
  const serviceMappingRaw =
    getInput('service-mapping-json', env) ?? actionContract.inputs['service-mapping-json'].default ?? '{}';
  const outputDir =
    getInput('output-dir', env) ?? actionContract.inputs['output-dir'].default ?? 'discovered-specs';
  const includeV2Raw =
    getInput('include-v2', env) ?? actionContract.inputs['include-v2'].default ?? 'true';
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
      throw new Error(`Invalid regex for api-filter: ${detail}`);
    }
  }

  return {
    mode,
    awsRegion,
    repoRoot,
    repoContext,
    expectedServiceName,
    expectedGatewayIds: parseStringArrayJson(expectedGatewayIdsRaw, 'expected-gateway-ids-json'),
    stage,
    apiFilter,
    serviceMapping: parseServiceMapping(serviceMappingRaw),
    outputDir,
    includeV2: parseBoolean(includeV2Raw, 'include-v2')
  };
}

export function readActionInputs(actionCore: Pick<CoreLike, 'getInput'>): ResolvedInputs {
  const requiredRegion = actionCore.getInput('aws-region', { required: true }).trim();

  return resolveInputs({
    INPUT_MODE: normalizeInputValue(actionCore.getInput('mode')) ?? actionContract.inputs.mode.default,
    INPUT_AWS_REGION: requiredRegion,
    INPUT_REPO_ROOT: normalizeInputValue(actionCore.getInput('repo-root')) ?? actionContract.inputs['repo-root'].default,
    INPUT_REPO_URL: normalizeInputValue(actionCore.getInput('repo-url')),
    INPUT_REPO_SLUG: normalizeInputValue(actionCore.getInput('repo-slug')),
    INPUT_GIT_PROVIDER: normalizeInputValue(actionCore.getInput('git-provider')),
    INPUT_REF: normalizeInputValue(actionCore.getInput('ref')),
    INPUT_SHA: normalizeInputValue(actionCore.getInput('sha')),
    INPUT_EXPECTED_SERVICE_NAME: normalizeInputValue(actionCore.getInput('expected-service-name')),
    INPUT_EXPECTED_GATEWAY_IDS_JSON:
      normalizeInputValue(actionCore.getInput('expected-gateway-ids-json')) ??
      actionContract.inputs['expected-gateway-ids-json'].default,
    INPUT_STAGE: normalizeInputValue(actionCore.getInput('stage')),
    INPUT_API_FILTER: normalizeInputValue(actionCore.getInput('api-filter')),
    INPUT_SERVICE_MAPPING_JSON:
      normalizeInputValue(actionCore.getInput('service-mapping-json')) ??
      actionContract.inputs['service-mapping-json'].default,
    INPUT_OUTPUT_DIR:
      normalizeInputValue(actionCore.getInput('output-dir')) ?? actionContract.inputs['output-dir'].default,
    INPUT_INCLUDE_V2:
      normalizeInputValue(actionCore.getInput('include-v2')) ?? actionContract.inputs['include-v2'].default
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
  const safe = projectName
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/^\.+$/, 'service')
    .replace(/^\.+|\.+$/g, '');
  return safe || 'service';
}

function toRelativeSpecPath(outputDir: string, folderName: string): string {
  return path.join(outputDir, folderName, 'index.yaml').replace(/\\/g, '/');
}

async function defaultWriteSpecFile(outputPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, 'utf8');
}

async function selectStage(
  aws: AwsGatewayClient,
  candidate: GatewayCandidate,
  preferredStage: string | undefined
): Promise<string | undefined> {
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

function filterCandidates(
  restApis: RestApiSummary[],
  httpApis: HttpApiSummary[],
  includeV2: boolean,
  apiFilter?: RegExp
): GatewayCandidate[] {
  const rest: GatewayCandidate[] = restApis.map((api) => ({
    id: api.id,
    name: api.name,
    gatewayType: 'REST'
  }));
  const http: GatewayCandidate[] = includeV2
    ? httpApis
        .filter((api) => !api.protocolType || api.protocolType === 'HTTP')
        .map((api) => ({
      id: api.id,
      name: api.name,
      gatewayType: 'HTTP'
    }))
    : [];

  const all = [...rest, ...http];
  if (!apiFilter) {
    return all;
  }

  return all.filter((api) => apiFilter.test(api.name));
}

async function lookupCandidatesByIds(
  inputs: ResolvedInputs,
  awsClient: AwsGatewayClient,
  actionCore: Pick<CoreLike, 'warning'>
): Promise<GatewayCandidate[]> {
  const candidates: GatewayCandidate[] = [];
  for (const gatewayId of inputs.expectedGatewayIds) {
    let found = false;
    try {
      const restApi = await awsClient.getRestApi(gatewayId);
      if (restApi) {
        candidates.push({
          id: restApi.id,
          name: restApi.name,
          gatewayType: 'REST'
        });
        found = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      actionCore.warning(`Failed direct REST lookup for ${gatewayId}: ${message}`);
    }

    if (!found && inputs.includeV2) {
      try {
        const httpApi = await awsClient.getHttpApi(gatewayId);
        if (httpApi && (!httpApi.protocolType || httpApi.protocolType === 'HTTP')) {
          candidates.push({
            id: httpApi.id,
            name: httpApi.name,
            gatewayType: 'HTTP'
          });
          found = true;
        } else if (httpApi) {
          actionCore.warning(`Skipping v2 API ${gatewayId} because protocol type ${httpApi.protocolType} is not supported`);
          found = true;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        actionCore.warning(`Failed direct HTTP lookup for ${gatewayId}: ${message}`);
      }
    }

    if (!found) {
      actionCore.warning(`Expected gateway ID ${gatewayId} was not found in ${inputs.awsRegion}`);
    }
  }

  return candidates;
}

function inferFallbackServiceName(inputs: ResolvedInputs): string | undefined {
  return (
    inputs.expectedServiceName ??
    inputs.repoContext.repoSlug?.split('/').pop()?.trim() ??
    inputs.repoContext.repoUrl?.split('/').pop()?.trim()
  );
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

async function resolveStageSelection(
  aws: AwsGatewayClient,
  candidate: GatewayCandidate,
  preferredStage: string | undefined
): Promise<ResolutionStageSelection> {
  const stages = candidate.gatewayType === 'REST' ? await aws.listRestStages(candidate.id) : await aws.listHttpStages(candidate.id);

  if (preferredStage) {
    if (stages.includes(preferredStage)) {
      return {
        stage: preferredStage,
        evidence: [`Using explicitly requested stage ${preferredStage}`]
      };
    }
    return {
      evidence: [],
      error: `Requested stage ${preferredStage} was not found for ${candidate.gatewayType} API ${candidate.id}`
    };
  }

  if (stages.length === 0) {
    if (candidate.gatewayType === 'HTTP') {
      return {
        useLatestConfig: true,
        evidence: ['No deployed stage found; exporting latest HTTP API configuration without stage']
      };
    }
    return {
      evidence: [],
      error: `No stages were found for REST API ${candidate.id}`
    };
  }

  if (stages.length === 1) {
    return {
      stage: stages[0],
      evidence: [`Auto-selected only available stage ${stages[0]}`]
    };
  }

  const preferred = pickPreferredStage(stages);
  if (preferred) {
    return {
      stage: preferred,
      evidence: [`Auto-selected preferred stage ${preferred}`]
    };
  }

  return {
    evidence: [],
    error: `Multiple stages found with no deterministic match: ${stages.join(', ')}`
  };
}

function toManualReviewResult(base: ResolutionResult, extraEvidence: string[]): ResolutionResult {
  return {
    ...base,
    status: 'unresolved',
    sourceType: 'manual-review',
    evidence: [...base.evidence, ...extraEvidence]
  };
}

function isKnownRestExportLimitation(message: string): boolean {
  const lowered = message.toLowerCase();
  return lowered.includes('non-json body models') || lowered.includes('json body models are not found');
}

function isManualReviewExportError(message: string): boolean {
  const lowered = message.toLowerCase();
  return lowered.includes('badrequestexception') || isKnownRestExportLimitation(message);
}

export async function runDiscovery(
  inputs: ResolvedInputs,
  dependencies: DiscoveryDependencies
): Promise<DiscoveredService[]> {
  const restApis = await dependencies.core.group('Discover REST APIs', async () => {
    const items = await dependencies.aws.listRestApis();
    dependencies.core.info(`Found ${items.length} REST API(s)`);
    return items;
  });

  const httpApis = await dependencies.core.group('Discover HTTP APIs', async () => {
    if (!inputs.includeV2) {
      dependencies.core.info('Skipping HTTP API discovery because include-v2=false');
      return [] as HttpApiSummary[];
    }

    const items = await dependencies.aws.listHttpApis();
    dependencies.core.info(`Found ${items.length} HTTP API(s)`);
    return items;
  });

  const selectedCandidates = filterCandidates(restApis, httpApis, inputs.includeV2, inputs.apiFilter);
  dependencies.core.info(`Export candidate count after filters: ${selectedCandidates.length}`);

  const discovered: DiscoveredService[] = [];
  const slugUsage = new Map<string, number>();

  await dependencies.core.group('Export OpenAPI specs', async () => {
    for (const candidate of selectedCandidates) {
      try {
        const stage = await selectStage(dependencies.aws, candidate, inputs.stage);
        if (!stage) {
          dependencies.core.warning(
            `Skipping ${candidate.gatewayType} API ${candidate.id} (${candidate.name}) because no stage is available`
          );
          continue;
        }

        const tags =
          candidate.gatewayType === 'REST'
            ? await dependencies.aws.getRestTags(candidate.id)
            : await dependencies.aws.getHttpTags(candidate.id);

        const serviceName = resolveLegacyServiceName(candidate.id, candidate.name, tags, inputs.serviceMapping);
        const baseFolder = projectFolderName(serviceName);
        const next = (slugUsage.get(baseFolder) ?? 0) + 1;
        slugUsage.set(baseFolder, next);
        const folderName = next === 1 ? baseFolder : `${baseFolder}-${candidate.id}`;

        const relativeSpecPath = toRelativeSpecPath(inputs.outputDir, folderName);
        const absoluteSpecPath = path.resolve(relativeSpecPath);

        const specBody =
          candidate.gatewayType === 'REST'
            ? await dependencies.aws.exportRestApi(candidate.id, stage)
            : await dependencies.aws.exportHttpApi(candidate.id, stage);

        await dependencies.writeSpecFile(absoluteSpecPath, specBody);

        discovered.push({
          serviceName,
          specPath: relativeSpecPath,
          gatewayId: candidate.id,
          gatewayType: candidate.gatewayType,
          stage
        });

        dependencies.core.info(
          `Exported ${candidate.gatewayType} API ${candidate.id} (${candidate.name}) to ${relativeSpecPath}`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dependencies.core.warning(
          `Failed exporting ${candidate.gatewayType} API ${candidate.id} (${candidate.name}): ${message}`
        );
      }
    }
  });

  return discovered;
}

async function runResolution(
  inputs: ResolvedInputs,
  awsClient: AwsGatewayClient,
  actionCore: Pick<CoreLike, 'group' | 'info' | 'warning'>,
  writeSpecFile: (outputPath: string, content: string) => Promise<void>
) {
  const existingSpecPath = await findExistingRepoSpec(inputs.repoRoot);
  const signals = await collectRepoSignals(
    inputs.repoRoot,
    inputs.repoContext.repoSlug,
    inputs.expectedServiceName,
    inputs.expectedGatewayIds
  );

  const narrowedCandidates =
    inputs.expectedGatewayIds.length > 0
      ? await actionCore.group('Resolve API candidates by explicit gateway ID', async () =>
          lookupCandidatesByIds(inputs, awsClient, actionCore)
        )
      : filterCandidates(
          await actionCore.group('Resolve REST API candidates', async () => awsClient.listRestApis()),
          await actionCore.group('Resolve HTTP API candidates', async () => {
            if (!inputs.includeV2) {
              return [] as HttpApiSummary[];
            }
            return awsClient.listHttpApis();
          }),
          inputs.includeV2,
          inputs.apiFilter
        );
  const gateways = [];
  for (const candidate of narrowedCandidates) {
    const candidateEvidence: string[] = [];
    let tags: Record<string, string> = {};
    try {
      tags =
        candidate.gatewayType === 'REST'
          ? await awsClient.getRestTags(candidate.id)
          : await awsClient.getHttpTags(candidate.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      candidateEvidence.push(`Tag lookup failed for ${candidate.id}: ${message}`);
      actionCore.warning(`Tag lookup failed for ${candidate.gatewayType} API ${candidate.id}: ${message}`);
    }
    gateways.push({
      id: candidate.id,
      name: candidate.name,
      gatewayType: candidate.gatewayType,
      tags,
      evidence: candidateEvidence
    });
  }

  const resolvedCandidate = resolveServiceCandidate(gateways, signals);
  const selectedSource = chooseSource({
    existingSpecPath,
    candidate: resolvedCandidate,
    fallbackServiceName: inferFallbackServiceName(inputs)
  });

  if (selectedSource.sourceType === 'gateway-export' && selectedSource.gatewayId) {
    const selectedGateway = narrowedCandidates.find((candidate) => candidate.id === selectedSource.gatewayId);
    if (!selectedGateway) {
      return toManualReviewResult(selectedSource, ['Selected gateway could not be reloaded for export']);
    }
    let stageSelection: ResolutionStageSelection;
    try {
      stageSelection = await resolveStageSelection(awsClient, selectedGateway, inputs.stage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toManualReviewResult(selectedSource, [`Stage lookup failed for ${selectedSource.gatewayId}: ${message}`]);
    }
    if (stageSelection.error) {
      return toManualReviewResult(selectedSource, [stageSelection.error]);
    }
    selectedSource.stage = stageSelection.stage;
    selectedSource.evidence = [...selectedSource.evidence, ...stageSelection.evidence];

    const relativeSpecPath = toRelativeSpecPath(
      inputs.outputDir,
      projectFolderName(selectedSource.serviceName || 'service')
    );
    const absoluteSpecPath = path.resolve(relativeSpecPath);
    try {
      const body =
        selectedSource.gatewayType === 'REST'
          ? await awsClient.exportRestApi(selectedSource.gatewayId, selectedSource.stage ?? '')
          : await awsClient.exportHttpApi(selectedSource.gatewayId, stageSelection.useLatestConfig ? undefined : selectedSource.stage);
      await writeSpecFile(absoluteSpecPath, body);
      selectedSource.specPath = relativeSpecPath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isManualReviewExportError(message)) {
        return toManualReviewResult(selectedSource, [
          'API Gateway export could not produce a specification automatically; manual review required',
          message
        ]);
      }
      throw error;
    }
  }

  return selectedSource;
}

export async function runAction(
  actionCore: CoreLike = core,
  actionExec: AwsExecLike = exec
): Promise<DiscoveredService[]> {
  const inputs = readActionInputs(actionCore);
  const awsClient = new AwsApiGatewayCliClient(actionExec, inputs.awsRegion);

  if (inputs.mode === 'discover-many') {
    const discovered = await runDiscovery(inputs, {
      core: actionCore,
      aws: awsClient,
      writeSpecFile: defaultWriteSpecFile
    });
    const servicesJson = JSON.stringify(discovered);
    actionCore.setOutput('services-json', servicesJson);
    actionCore.setOutput('service-count', String(discovered.length));
    actionCore.setOutput('resolution-status', 'resolved');
    actionCore.setOutput('source-type', 'discover-many');
    actionCore.setOutput('mapping-confidence', discovered.length > 0 ? '100' : '0');
    actionCore.setOutput('resolution-json', JSON.stringify({ status: 'resolved', sourceType: 'discover-many', count: discovered.length }));
    actionCore.info(`Discovered ${discovered.length} service(s)`);
    return discovered;
  }

  const resolution = await runResolution(inputs, awsClient, actionCore, defaultWriteSpecFile);
  actionCore.setOutput('resolution-json', JSON.stringify(resolution));
  actionCore.setOutput('resolution-status', resolution.status);
  actionCore.setOutput('source-type', resolution.sourceType);
  actionCore.setOutput('mapping-confidence', String(resolution.confidence));
  actionCore.setOutput('service-name', resolution.serviceName);
  actionCore.setOutput('gateway-id', resolution.gatewayId ?? '');
  actionCore.setOutput('spec-path', resolution.specPath ?? '');
  actionCore.setOutput('services-json', '[]');
  actionCore.setOutput('service-count', '0');
  actionCore.info(`Resolution status: ${resolution.status} (${resolution.sourceType})`);
  return [];
}

const currentModulePath = typeof __filename === 'string' ? __filename : '';
const entrypoint = process.argv[1];

if (entrypoint && currentModulePath === entrypoint) {
  runAction().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);
  });
}

export const outputNames = contractOutputNames;

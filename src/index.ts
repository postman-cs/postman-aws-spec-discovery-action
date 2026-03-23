import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  actionContract,
  contractOutputNames,
  type DiscoveredService,
  type GatewayType
} from './contracts.js';
import {
  AwsApiGatewayCliClient,
  type AwsGatewayClient,
  type ExecLike as AwsExecLike,
  type HttpApiSummary,
  type RestApiSummary
} from './lib/aws/client.js';

export interface CoreLike {
  getInput(name: string, options?: { required?: boolean }): string;
  group<T>(name: string, fn: () => Promise<T>): Promise<T>;
  info(message: string): void;
  warning(message: string): void;
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
}

export interface ResolvedInputs {
  awsRegion: string;
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

export function resolveInputs(env: NodeJS.ProcessEnv = process.env): ResolvedInputs {
  const awsRegion = getInput('aws-region', env) ?? '';
  if (!awsRegion) {
    throw new Error('aws-region is required');
  }

  const stage = getInput('stage', env);
  const apiFilterRaw = getInput('api-filter', env);
  const serviceMappingRaw =
    getInput('service-mapping-json', env) ?? actionContract.inputs['service-mapping-json'].default ?? '{}';
  const outputDir =
    getInput('output-dir', env) ?? actionContract.inputs['output-dir'].default ?? 'discovered-specs';
  const includeV2Raw =
    getInput('include-v2', env) ?? actionContract.inputs['include-v2'].default ?? 'true';

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
    awsRegion,
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
    INPUT_AWS_REGION: requiredRegion,
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

function resolveProjectName(
  gatewayId: string,
  gatewayName: string,
  tags: Record<string, string>,
  serviceMapping: Record<string, string>
): string {
  const tagProjectName = (tags['postman:project-name'] ?? '').trim();
  if (tagProjectName) {
    return tagProjectName;
  }

  const tagName = (tags.Name ?? '').trim();
  if (tagName) {
    return tagName;
  }

  const mapped = (serviceMapping[gatewayId] ?? '').trim();
  if (mapped) {
    return mapped;
  }

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
    ? httpApis.map((api) => ({
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

        const projectName = resolveProjectName(candidate.id, candidate.name, tags, inputs.serviceMapping);
        const baseFolder = projectFolderName(projectName);
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
          projectName,
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

export async function runAction(
  actionCore: CoreLike = core,
  actionExec: AwsExecLike = exec
): Promise<DiscoveredService[]> {
  const inputs = readActionInputs(actionCore);
  const awsClient = new AwsApiGatewayCliClient(actionExec, inputs.awsRegion);

  const discovered = await runDiscovery(inputs, {
    core: actionCore,
    aws: awsClient,
    writeSpecFile: defaultWriteSpecFile
  });

  const servicesJson = JSON.stringify(discovered);
  actionCore.setOutput('services-json', servicesJson);
  actionCore.setOutput('service-count', String(discovered.length));

  actionCore.info(`Discovered ${discovered.length} service(s)`);
  return discovered;
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

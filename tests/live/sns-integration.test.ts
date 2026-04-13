import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

interface CliExecutionResult {
  mode: string;
  outputs: Record<string, string>;
}

interface CliExecutionArtifacts {
  stdoutResult: CliExecutionResult;
  fileResult: CliExecutionResult;
}

interface DiscoveredServiceRecord {
  serviceName: string;
  specPath: string;
  gatewayId: string;
  providerType?: string;
}

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIR, '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'tests', 'live', 'fixtures');
const CLI_ENTRYPOINT = path.join(REPO_ROOT, 'dist', 'cli.cjs');

const createdWorkspaces: string[] = [];

function parseServices(result: CliExecutionResult): DiscoveredServiceRecord[] {
  const servicesJson = result.outputs['services-json'] ?? '[]';
  return JSON.parse(servicesJson) as DiscoveredServiceRecord[];
}

async function createWorkspace(name: string): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  createdWorkspaces.push(workspace);
  return workspace;
}

async function writeSnsTemplate(workspace: string, topicName: string): Promise<void> {
  const template = [
    "AWSTemplateFormatVersion: '2010-09-09'",
    'Resources:',
    '  Topic:',
    '    Type: AWS::SNS::Topic',
    '    Properties:',
    `      TopicName: ${topicName}`
  ].join('\n');
  await writeFile(path.join(workspace, 'template.yaml'), template, 'utf8');
}

function parseCliExecutionResult(raw: string, source: string): CliExecutionResult {
  try {
    return JSON.parse(raw) as CliExecutionResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed parsing CLI ${source}: ${message}`, { cause: error });
  }
}

function runCli(workspace: string, env: Record<string, string>): CliExecutionArtifacts {
  if (!existsSync(CLI_ENTRYPOINT)) {
    throw new Error(`CLI bundle not found at ${CLI_ENTRYPOINT}`);
  }
  const mergedEnv = {
    ...process.env,
    INPUT_AWS_REGION: 'us-east-1',
    INPUT_REPO_ROOT: workspace,
    INPUT_OUTPUT_DIR: 'discovered-specs',
    ...env
  };
  const resultJsonPath = path.join(workspace, 'result.json');

  const stdout = execFileSync('node', [CLI_ENTRYPOINT, '--result-json', 'result.json'], {
    cwd: workspace,
    env: mergedEnv,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });

  const stdoutResult = parseCliExecutionResult(stdout, 'stdout');
  const fileResult = parseCliExecutionResult(readFileSync(resultJsonPath, 'utf8'), 'result.json');

  if (JSON.stringify(stdoutResult.outputs) !== JSON.stringify(fileResult.outputs)) {
    throw new Error('CLI stdout output did not match result.json output');
  }

  return { stdoutResult, fileResult };
}

describe('SNS live CLI integration', () => {
  afterEach(async () => {
    await Promise.all(createdWorkspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
  });

  it('discover-many includes SNS services, service-count, output structure, and existing providers', async () => {
    const workspace = await createWorkspace('sns-live-discover-many');
    const { stdoutResult, fileResult: result } = runCli(workspace, {
      INPUT_MODE: 'discover-many'
    });
    expect(stdoutResult.mode).toBe(result.mode);

    const services = parseServices(result);
    const snsServices = services.filter((entry) => entry.providerType === 'sns');
    expect(snsServices.length).toBeGreaterThan(0);

    const serviceCount = Number.parseInt(result.outputs['service-count'] ?? '0', 10);
    expect(Number.isNaN(serviceCount)).toBe(false);
    expect(serviceCount).toBeGreaterThanOrEqual(snsServices.length);

    const providerTypes = new Set(services.map((entry) => entry.providerType).filter(Boolean));
    expect(providerTypes.has('sns')).toBe(true);
    expect(providerTypes.has('api-gateway')).toBe(true);

    const knownTopic = snsServices.find((entry) => entry.gatewayId.endsWith(':SpecDiscoveryTestTopic'));
    expect(knownTopic).toBeDefined();
    expect(knownTopic?.specPath).toMatch(/^discovered-specs\/[^/]+\/[^/]+$/);
    expect(existsSync(path.join(workspace, knownTopic!.specPath))).toBe(true);
  });

  it('resolve-one prefers repo-local AsyncAPI contract and exports asyncapi.yaml', async () => {
    const workspace = await createWorkspace('sns-live-asyncapi');
    await writeSnsTemplate(workspace, 'SpecDiscoveryTestTopic');
    await cp(path.join(FIXTURES_DIR, 'asyncapi.yaml'), path.join(workspace, 'asyncapi.yaml'));

    const { fileResult: result } = runCli(workspace, {
      INPUT_MODE: 'resolve-one',
      INPUT_EXPECTED_SERVICE_NAME: 'SpecDiscoveryTestTopic'
    });

    expect(result.outputs['resolution-status']).toBe('resolved');
    expect(result.outputs['source-type']).toBe('sns-contract');
    expect(result.outputs['provider-type']).toBe('sns');
    expect(result.outputs['spec-format']).toBe('asyncapi-yaml');
    expect(result.outputs['spec-path']).toMatch(/^discovered-specs\/SpecDiscoveryTestTopic\/asyncapi\.yaml$/);

    const exported = path.join(workspace, result.outputs['spec-path'] ?? '');
    expect(existsSync(exported)).toBe(true);
    expect(readFileSync(exported, 'utf8')).toContain('asyncapi: 2.6.0');
  });

  it('resolve-one uses repo-local JSON Schema and exports schema.json', async () => {
    const workspace = await createWorkspace('sns-live-json-schema');
    await writeSnsTemplate(workspace, 'SpecDiscoverySubscribedTopic');
    await cp(path.join(FIXTURES_DIR, 'schema.json'), path.join(workspace, 'schema.json'));

    const { fileResult: result } = runCli(workspace, {
      INPUT_MODE: 'resolve-one',
      INPUT_EXPECTED_SERVICE_NAME: 'SpecDiscoverySubscribedTopic',
      INPUT_MAX_CANDIDATES: '1'
    });

    expect(result.outputs['resolution-status']).toBe('resolved');
    expect(result.outputs['source-type']).toBe('sns-contract');
    expect(result.outputs['provider-type']).toBe('sns');
    expect(result.outputs['spec-format']).toBe('json-schema');
    expect(result.outputs['spec-path']).toMatch(/^discovered-specs\/SpecDiscoverySubscribedTopic\/schema\.json$/);

    const exported = path.join(workspace, result.outputs['spec-path'] ?? '');
    expect(existsSync(exported)).toBe(true);
    expect(readFileSync(exported, 'utf8')).toContain('"$schema"');
  });

  it('resolve-one falls back to SSM pointer when no local contract exists', async () => {
    const workspace = await createWorkspace('sns-live-ssm');
    await writeSnsTemplate(workspace, 'SpecDiscoveryTestTopic');

    const { fileResult: result } = runCli(workspace, {
      INPUT_MODE: 'resolve-one',
      INPUT_EXPECTED_SERVICE_NAME: 'SpecDiscoveryTestTopic'
    });

    expect(result.outputs['resolution-status']).toBe('resolved');
    expect(result.outputs['source-type']).toBe('sns-contract');
    expect(result.outputs['provider-type']).toBe('sns');
    expect(result.outputs['spec-format']).toBe('asyncapi-yaml');
    expect(result.outputs['spec-path']).toMatch(/^discovered-specs\/SpecDiscoveryTestTopic\/asyncapi\.yaml$/);

    const resolutionJson = JSON.parse(result.outputs['resolution-json'] ?? '{}') as { evidence?: string[] };
    expect(resolutionJson.evidence?.some((entry) => entry.includes('/postman/specs/spec-discovery-test-topic/'))).toBe(true);
  });

  it('resolve-one returns manual-review when no SNS contract exists', async () => {
    const workspace = await createWorkspace('sns-live-manual-review');
    await writeSnsTemplate(workspace, 'SpecDiscoverySubscribedTopic');

    const { fileResult: result } = runCli(workspace, {
      INPUT_MODE: 'resolve-one',
      INPUT_EXPECTED_SERVICE_NAME: 'SpecDiscoverySubscribedTopic',
      INPUT_MAX_CANDIDATES: '1'
    });

    expect(result.outputs['resolution-status']).toBe('unresolved');
    expect(result.outputs['source-type']).toBe('manual-review');
    expect(result.outputs['provider-type']).toBe('');
    expect(result.outputs['spec-format']).toBe('');
  });

  it('uses SNS tags for candidate ranking in resolve-one (services-json does not expose raw tag metadata)', async () => {
    const workspace = await createWorkspace('sns-live-tag-ranking');
    await writeSnsTemplate(workspace, 'SpecDiscoveryTaggedTopic');
    await cp(path.join(FIXTURES_DIR, 'asyncapi.yaml'), path.join(workspace, 'asyncapi.yaml'));

    const { fileResult: result } = runCli(workspace, {
      INPUT_MODE: 'resolve-one',
      INPUT_EXPECTED_SERVICE_NAME: 'test-service'
    });

    expect(result.outputs['resolution-status']).toBe('resolved');
    expect(result.outputs['source-type']).toBe('sns-contract');
    expect(result.outputs['service-name']).toBe('SpecDiscoveryTaggedTopic');
    expect(result.outputs['gateway-id']).toContain(':SpecDiscoveryTaggedTopic');
  });
});

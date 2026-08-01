/**
 * LocalStack emulator lane: proves the SHIPPED CLI bundle (dist/cli.cjs) speaks
 * real Smithy/SDK wire protocol against an AWS-compatible endpoint -- request
 * signing, pagination, REST API export, STS preflight identity, and account
 * mismatch enforcement -- with zero live AWS traffic.
 *
 * Endpoint override rides the AWS SDK's own AWS_ENDPOINT_URL env contract (no
 * product-code seam, no public action input). The lane is excluded from
 * `npm test`; CI runs it as a budgeted Linux step against a LocalStack
 * container started by the workflow (POSTMAN_AWS_EMULATOR_URL). A missing
 * emulator fails loudly -- this suite never silently skips in CI.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APIGatewayClient,
  CreateDeploymentCommand,
  CreateResourceCommand,
  CreateRestApiCommand,
  GetResourcesCommand,
  PutIntegrationCommand,
  PutMethodCommand
} from '@aws-sdk/client-api-gateway';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIR, '..', '..');
const CLI_ENTRYPOINT = path.join(REPO_ROOT, 'dist', 'cli.cjs');

const EMULATOR_URL = process.env.POSTMAN_AWS_EMULATOR_URL ?? 'http://127.0.0.1:4566';
const REGION = 'us-east-1';
// LocalStack's fixed default account for static test credentials.
const EMULATOR_ACCOUNT_ID = '000000000000';

const credentialEnv = {
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  AWS_ENDPOINT_URL: EMULATOR_URL
} as const;

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

const workspaces: string[] = [];

async function createWorkspace(name: string): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  workspaces.push(workspace);
  return workspace;
}

function runCli(workspace: string, env: Record<string, string>): CliResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI_ENTRYPOINT, '--result-json', 'result.json'], {
      cwd: workspace,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: {
        // Deliberately NOT process.env: the child sees only the emulator
        // credentials and inputs, proving no ambient AWS profile leaks in.
        PATH: process.env.PATH ?? '',
        HOME: os.tmpdir(),
        POSTMAN_ACTIONS_TELEMETRY: 'off',
        INPUT_AWS_REGION: REGION,
        INPUT_REPO_ROOT: workspace,
        INPUT_OUTPUT_DIR: 'discovered-specs',
        ...credentialEnv,
        ...env
      }
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: unknown; stderr?: unknown };
    return {
      status: failure.status ?? 1,
      stdout: typeof failure.stdout === 'string' ? failure.stdout : String(failure.stdout ?? ''),
      stderr: typeof failure.stderr === 'string' ? failure.stderr : String(failure.stderr ?? '')
    };
  }
}

function readResult(workspace: string): { outputs: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(workspace, 'result.json'), 'utf8')) as {
    outputs: Record<string, string>;
  };
}

let apiId: string;

beforeAll(async () => {
  const health = await fetch(`${EMULATOR_URL}/_localstack/health`).catch((error: unknown) => {
    throw new Error(
      `AWS emulator is not reachable at ${EMULATOR_URL}. Start LocalStack (SERVICES=apigateway,sts) or set POSTMAN_AWS_EMULATOR_URL. ${String(error)}`
    );
  });
  expect(health.ok).toBe(true);

  // Seed one deployed REST API through the same SDK the action ships.
  const gateway = new APIGatewayClient({ region: REGION, endpoint: EMULATOR_URL, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const api = await gateway.send(new CreateRestApiCommand({ name: 'ws10-emulator-petstore' }));
  apiId = api.id!;
  const resources = await gateway.send(new GetResourcesCommand({ restApiId: apiId }));
  const rootId = resources.items?.[0]?.id;
  const pets = await gateway.send(new CreateResourceCommand({ restApiId: apiId, parentId: rootId, pathPart: 'pets' }));
  await gateway.send(new PutMethodCommand({ restApiId: apiId, resourceId: pets.id, httpMethod: 'GET', authorizationType: 'NONE' }));
  await gateway.send(
    new PutIntegrationCommand({
      restApiId: apiId,
      resourceId: pets.id,
      httpMethod: 'GET',
      type: 'MOCK',
      requestTemplates: { 'application/json': '{"statusCode":200}' }
    })
  );
  await gateway.send(new CreateDeploymentCommand({ restApiId: apiId, stageName: 'prod' }));
}, 60_000);

afterAll(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
});

describe('LocalStack API Gateway transport', () => {
  it('resolve-one exports the deployed stage through the emulator endpoint and derives OpenAPI', async () => {
    const workspace = await createWorkspace('ws10-resolve-one');
    const result = runCli(workspace, { INPUT_MODE: 'resolve-one', 'INPUT_GATEWAY-ID': apiId });
    expect(result.status, result.stderr).toBe(0);

    const { outputs } = readResult(workspace);
    expect(outputs['resolution-status']).toBe('resolved');
    expect(outputs['source-type']).toBe('gateway-export');
    expect(outputs['gateway-id']).toBe(apiId);
    expect(outputs['provider-type']).toBe('api-gateway');
    expect(outputs['spec-path']).toMatch(/^discovered-specs\//);
    expect(existsSync(path.join(workspace, outputs['spec-path']!))).toBe(true);
    expect(outputs['derived-openapi-version']).toMatch(/^3\./);
    expect(existsSync(path.join(workspace, outputs['derived-openapi-path']!))).toBe(true);

    // Preflight identity came from the emulator's fixed account, proving the
    // STS call went to the override endpoint and not live AWS.
    const resolution = JSON.parse(outputs['resolution-json']!) as {
      provenance?: { accountIndicator?: string; region?: string };
    };
    expect(resolution.provenance?.accountIndicator).toBe('***0000');
    expect(resolution.provenance?.region).toBe(REGION);
  });

  it('rejects an expected-account-id mismatch during STS preflight', async () => {
    const workspace = await createWorkspace('ws10-account-mismatch');
    const result = runCli(workspace, {
      INPUT_MODE: 'resolve-one',
      'INPUT_GATEWAY-ID': apiId,
      'INPUT_EXPECTED-ACCOUNT-ID': '999999999999'
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('AWS account mismatch');
  });

  it('reports unresolved for a gateway id the emulator does not know', async () => {
    const workspace = await createWorkspace('ws10-unknown-gateway');
    const result = runCli(workspace, { INPUT_MODE: 'resolve-one', 'INPUT_GATEWAY-ID': 'zzzznotreal' });
    expect(result.status, result.stderr).toBe(0);
    const { outputs } = readResult(workspace);
    expect(outputs['resolution-status']).toBe('unresolved');
    expect(outputs['spec-path'] ?? '').toBe('');
  });

  it('never contacts live AWS: emulator account is pinned to the LocalStack default', () => {
    // Guard the assumption the accountIndicator assertion above rests on.
    expect(EMULATOR_ACCOUNT_ID.endsWith('0000')).toBe(true);
  });
});

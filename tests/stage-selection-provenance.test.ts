import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

import type { AwsGatewayClient, GatewayStageSummary } from '../src/lib/aws/client.js';
import { accountIndicatorFromAccountId, partitionFromArn } from '../src/lib/aws/client.js';
import type { AppSyncSpecClient } from '../src/lib/aws/appsync-client.js';
import { AppSyncProvider } from '../src/lib/providers/appsync.js';
import { resolveInputs, runDiscovery, execute, type ResolvedInputs } from '../src/runtime.js';
import { actionContract, contractInputNames } from '../src/contracts.js';

function createCoreStub() {
  const infos: string[] = [];
  const warnings: string[] = [];
  return {
    core: {
      getInput: () => '',
      group: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      info: (message: string) => {
        infos.push(message);
      },
      warning: (message: string) => {
        warnings.push(message);
      },
      setOutput: vi.fn(),
      setFailed: vi.fn()
    },
    infos,
    warnings
  };
}

function createAwsClientStub(overrides: Partial<AwsGatewayClient> = {}): AwsGatewayClient {
  return {
    listRestApis: vi.fn().mockResolvedValue([]),
    listHttpApis: vi.fn().mockResolvedValue([]),
    getRestApi: vi.fn().mockResolvedValue(undefined),
    getHttpApi: vi.fn().mockResolvedValue(undefined),
    listRestStages: vi.fn().mockResolvedValue([]),
    listHttpStages: vi.fn().mockResolvedValue([]),
    getRestTags: vi.fn().mockResolvedValue({}),
    getHttpTags: vi.fn().mockResolvedValue({}),
    exportRestApi: vi.fn().mockResolvedValue('openapi: 3.0.1\ninfo:\n  title: rest'),
    exportHttpApi: vi.fn().mockResolvedValue('openapi: 3.0.1\ninfo:\n  title: http'),
    exportWebSocketApi: vi.fn().mockResolvedValue('openapi: 3.0.3\ninfo:\n  title: websocket'),
    getCallerIdentity: vi.fn().mockResolvedValue({
      accountId: '123456789012',
      arn: 'arn:aws:iam::123456789012:role/test',
      partition: 'aws'
    }),
    probeApiGatewayReadAccess: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

function baseDiscoveryInputs(overrides: Partial<ResolvedInputs> = {}): ResolvedInputs {
  return {
    mode: 'discover-many',
    awsRegion: 'us-east-1',
    repoRoot: '.',
    repoContext: { provider: 'unknown' },
    expectedGatewayIds: [],
    stage: undefined,
    apiFilter: undefined,
    serviceMapping: {},
    outputDir: 'discovered-specs',
    maxCandidates: 50,
    dryRun: false,
    preflightChecks: true,
    preflightPermissionProbe: false,
    requestTimeoutMs: 30000,
    maxAttempts: 3,
    includeV2: true,
    ...overrides
  };
}

describe('POS-390 evidence-safe stage selection', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function withTempRepo(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pos-390-'));
    tempDirs.push(dir);
    return dir;
  }

  it('uses an explicit stage when present', async () => {
    const repoRoot = await withTempRepo();
    const { core, warnings } = createCoreStub();
    const stages: GatewayStageSummary[] = [
      { stageName: 'prod', deploymentId: 'd-prod' },
      { stageName: 'staging', deploymentId: 'd-staging' }
    ];
    const aws = createAwsClientStub({
      listHttpApis: vi.fn().mockResolvedValue([{ id: 'http-1', name: 'orders', protocolType: 'HTTP' }]),
      listHttpStages: vi.fn().mockResolvedValue(stages),
      exportHttpApi: vi.fn().mockResolvedValue('openapi: 3.0.1\ninfo:\n  title: explicit')
    });

    const result = await runDiscovery(baseDiscoveryInputs({ repoRoot, expectedGatewayIds: ['http-1'], stage: 'staging' }), {
      core,
      aws,
      writeSpecFile: async () => undefined
    });

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]?.stage).toBe('staging');
    expect(result.discovered[0]?.provenance).toMatchObject({
      configurationMode: 'deployed-stage',
      stage: 'staging',
      deploymentId: 'd-staging'
    });
    expect(aws.exportHttpApi).toHaveBeenCalledWith('http-1', 'staging');
    expect(warnings.join('\n')).not.toMatch(/manual review/i);
  });

  it('exports the latest HTTP configuration when an explicit gateway has no explicit stage', async () => {
    const repoRoot = await withTempRepo();
    const { core, infos } = createCoreStub();
    const exportHttpApi = vi.fn().mockResolvedValue('openapi: 3.0.1\ninfo:\n  title: latest');
    const aws = createAwsClientStub({
      listHttpApis: vi.fn().mockResolvedValue([{ id: 'http-1', name: 'orders', protocolType: 'HTTP' }]),
      listHttpStages: vi.fn().mockResolvedValue([{ stageName: '$default', deploymentId: 'd-default' }]),
      exportHttpApi
    });

    const result = await runDiscovery(baseDiscoveryInputs({ repoRoot, expectedGatewayIds: ['http-1'] }), {
      core,
      aws,
      writeSpecFile: async () => undefined
    });

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]?.stage).toBe('');
    expect(result.discovered[0]?.provenance).toMatchObject({
      configurationMode: 'latest-configuration',
      protocol: 'HTTP',
      exportOptions: { configurationMode: 'latest-configuration', stageName: undefined }
    });
    expect(result.discovered[0]?.provenance?.stage).toBeUndefined();
    expect(exportHttpApi).toHaveBeenCalledWith('http-1', undefined);
    expect(infos.join('\n')).toMatch(/latest-configuration/);
  });

  it('auto-selects a singleton deployed stage', async () => {
    const repoRoot = await withTempRepo();
    const { core } = createCoreStub();
    const aws = createAwsClientStub({
      listRestApis: vi.fn().mockResolvedValue([{ id: 'rest-1', name: 'orders' }]),
      listRestStages: vi.fn().mockResolvedValue([{ stageName: 'v1', deploymentId: 'dep-1' }])
    });

    const result = await runDiscovery(baseDiscoveryInputs({ repoRoot, includeV2: false }), {
      core,
      aws,
      writeSpecFile: async () => undefined
    });

    expect(result.discovered[0]?.stage).toBe('v1');
    expect(result.discovered[0]?.provenance).toMatchObject({
      configurationMode: 'deployed-stage',
      deploymentId: 'dep-1',
      stage: 'v1'
    });
  });

  it('does not auto-select merely because a stage is named prod/production among multiple stages', async () => {
    const repoRoot = await withTempRepo();
    const { core, warnings } = createCoreStub();
    const aws = createAwsClientStub({
      listRestApis: vi.fn().mockResolvedValue([{ id: 'rest-1', name: 'orders' }]),
      listRestStages: vi.fn().mockResolvedValue([
        { stageName: 'prod', deploymentId: 'd1' },
        { stageName: 'production', deploymentId: 'd2' },
        { stageName: 'staging', deploymentId: 'd3' }
      ])
    });

    const result = await runDiscovery(baseDiscoveryInputs({ repoRoot, includeV2: false }), {
      core,
      aws,
      writeSpecFile: async () => undefined
    });

    expect(result.discovered).toHaveLength(0);
    expect(result.summary.skipped).toBe(1);
    expect(warnings.join('\n')).toMatch(/Multiple stages found without uniquely evidenced selection/i);
    expect(warnings.join('\n')).toMatch(/prod/);
    expect(aws.exportRestApi).not.toHaveBeenCalled();
  });

  it('auto-selects uniquely evidenced HTTP $default auto-deploy target among multiple stages', async () => {
    const repoRoot = await withTempRepo();
    const { core } = createCoreStub();
    const aws = createAwsClientStub({
      listHttpApis: vi.fn().mockResolvedValue([{ id: 'http-1', name: 'orders', protocolType: 'HTTP' }]),
      listHttpStages: vi.fn().mockResolvedValue([
        { stageName: '$default', deploymentId: 'd-default', autoDeploy: true },
        { stageName: 'preview', deploymentId: 'd-preview', autoDeploy: false }
      ])
    });

    const result = await runDiscovery(baseDiscoveryInputs({ repoRoot }), {
      core,
      aws,
      writeSpecFile: async () => undefined
    });

    expect(result.discovered[0]?.stage).toBe('$default');
    expect(result.discovered[0]?.provenance).toMatchObject({
      configurationMode: 'deployed-stage',
      stage: '$default',
      deploymentId: 'd-default'
    });
  });

  it('rejects $default when another auto-deploy stage also exists', async () => {
    const repoRoot = await withTempRepo();
    const { core, warnings } = createCoreStub();
    const aws = createAwsClientStub({
      listHttpApis: vi.fn().mockResolvedValue([{ id: 'http-1', name: 'orders', protocolType: 'HTTP' }]),
      listHttpStages: vi.fn().mockResolvedValue([
        { stageName: '$default', autoDeploy: true, deploymentId: 'd1' },
        { stageName: 'canary', autoDeploy: true, deploymentId: 'd2' }
      ])
    });

    const result = await runDiscovery(baseDiscoveryInputs({ repoRoot }), {
      core,
      aws,
      writeSpecFile: async () => undefined
    });

    expect(result.discovered).toHaveLength(0);
    expect(warnings.join('\n')).toMatch(/manual review/i);
  });

  it('treats HTTP no-stage export as latest-configuration, distinct from deployed-stage', async () => {
    const repoRoot = await withTempRepo();
    const { core, infos } = createCoreStub();
    const exportHttpApi = vi.fn().mockResolvedValue('openapi: 3.0.1\ninfo:\n  title: latest');
    const aws = createAwsClientStub({
      listHttpApis: vi.fn().mockResolvedValue([{ id: 'http-1', name: 'orders', protocolType: 'HTTP' }]),
      listHttpStages: vi.fn().mockResolvedValue([]),
      exportHttpApi
    });

    const result = await runDiscovery(baseDiscoveryInputs({ repoRoot }), {
      core,
      aws,
      writeSpecFile: async () => undefined
    });

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]?.stage).toBe('');
    expect(result.discovered[0]?.provenance).toMatchObject({
      configurationMode: 'latest-configuration',
      protocol: 'HTTP'
    });
    expect(result.discovered[0]?.provenance?.stage).toBeUndefined();
    expect(exportHttpApi).toHaveBeenCalledWith('http-1', undefined);
    expect(infos.join('\n')).toMatch(/latest-configuration/);
  });

  it('requires a deployed stage for REST and does not invent latest-configuration', async () => {
    const repoRoot = await withTempRepo();
    const { core, warnings } = createCoreStub();
    const aws = createAwsClientStub({
      listRestApis: vi.fn().mockResolvedValue([{ id: 'rest-1', name: 'orders' }]),
      listRestStages: vi.fn().mockResolvedValue([])
    });

    const result = await runDiscovery(baseDiscoveryInputs({ repoRoot, includeV2: false }), {
      core,
      aws,
      writeSpecFile: async () => undefined
    });

    expect(result.discovered).toHaveLength(0);
    expect(warnings.join('\n')).toMatch(/No stages were found for REST API/);
    expect(aws.exportRestApi).not.toHaveBeenCalled();
  });

  it('labels WebSocket exports as partial-control-plane', async () => {
    const repoRoot = await withTempRepo();
    const { core } = createCoreStub();
    const aws = createAwsClientStub({
      listHttpApis: vi.fn().mockResolvedValue([{ id: 'ws-1', name: 'orders-ws', protocolType: 'WEBSOCKET' }]),
      listHttpStages: vi.fn().mockResolvedValue([{ stageName: 'prod', deploymentId: 'ws-dep' }]),
      exportWebSocketApi: vi.fn().mockResolvedValue('openapi: 3.0.3\ninfo:\n  title: ws')
    });

    const result = await runDiscovery(baseDiscoveryInputs({ repoRoot }), {
      core,
      aws,
      writeSpecFile: async () => undefined
    });

    expect(result.discovered[0]?.gatewayType).toBe('WEBSOCKET');
    expect(result.discovered[0]?.provenance).toMatchObject({
      configurationMode: 'partial-control-plane',
      stage: 'prod',
      deploymentId: 'ws-dep',
      protocol: 'WEBSOCKET'
    });
  });

  it('uses trusted custom-domain stage evidence when unique', async () => {
    const repoRoot = await withTempRepo();
    const { core } = createCoreStub();
    const aws = createAwsClientStub({
      listRestApis: vi.fn().mockResolvedValue([{ id: 'rest-1', name: 'orders' }]),
      listRestStages: vi.fn().mockResolvedValue([
        { stageName: 'prod', deploymentId: 'd-prod' },
        { stageName: 'staging', deploymentId: 'd-staging' }
      ]),
      listRestDomainMappings: vi.fn().mockResolvedValue([
        { domainName: 'api.example.test', apiId: 'rest-1', stage: 'staging', gatewayType: 'REST' }
      ])
    });

    const result = await runDiscovery(baseDiscoveryInputs({ repoRoot, includeV2: false }), {
      core,
      aws,
      writeSpecFile: async () => undefined
    });

    expect(result.discovered[0]?.stage).toBe('staging');
    expect(result.discovered[0]?.provenance).toMatchObject({
      configurationMode: 'deployed-stage',
      stage: 'staging',
      deploymentId: 'd-staging'
    });
  });

  it('records sanitized additive provenance without raw account IDs', async () => {
    const repoRoot = await withTempRepo();
    const { core } = createCoreStub();
    const aws = createAwsClientStub({
      listRestApis: vi.fn().mockResolvedValue([{ id: 'rest-1', name: 'orders' }]),
      listRestStages: vi.fn().mockResolvedValue([{ stageName: 'prod', deploymentId: 'dep-xyz' }]),
      getCallerIdentity: vi.fn().mockResolvedValue({
        accountId: '111122223333',
        arn: 'arn:aws-us-gov:iam::111122223333:role/test',
        partition: 'aws-us-gov'
      })
    });

    const result = await runDiscovery(baseDiscoveryInputs({ repoRoot, includeV2: false, awsRegion: 'us-gov-west-1' }), {
      core,
      aws,
      writeSpecFile: async () => undefined
    });

    const provenance = result.discovered[0]?.provenance;
    expect(provenance).toMatchObject({
      partition: 'aws-us-gov',
      accountIndicator: '***3333',
      region: 'us-gov-west-1',
      apiId: 'rest-1',
      configurationMode: 'deployed-stage',
      deploymentId: 'dep-xyz'
    });
    expect(JSON.stringify(provenance)).not.toMatch(/\b111122223333\b/);
    expect(provenance?.accountIndicator).not.toMatch(/^\d{12}$/);
    expect(provenance?.artifactHash).toMatch(/^[a-f0-9]{64}$/);
    expect(provenance?.queryTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(provenance?.exportOptions).toMatchObject({ exportType: 'oas30', stageName: 'prod' });
  });
});

describe('POS-390 expected identity fail-closed preflight', () => {
  it('fails closed before export on account mismatch with sanitized error', async () => {
    const { core } = createCoreStub();
    const aws = createAwsClientStub({
      listRestApis: vi.fn().mockResolvedValue([{ id: 'rest-1', name: 'orders' }]),
      listRestStages: vi.fn().mockResolvedValue([{ stageName: 'prod' }]),
      getCallerIdentity: vi.fn().mockResolvedValue({
        accountId: '123456789012',
        arn: 'arn:aws:iam::123456789012:role/test',
        partition: 'aws'
      })
    });

    const err = await execute(
      baseDiscoveryInputs({
        mode: 'discover-many',
        expectedAccountId: '999988887777',
        includeV2: false,
        preflightChecks: true
      }),
      { core, aws, writeSpecFile: async () => undefined }
    ).catch((error: Error) => error);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/account mismatch/i);
    expect((err as Error).message).toMatch(/\*\*\*7777/);
    expect((err as Error).message).not.toMatch(/999988887777/);
    expect(aws.exportRestApi).not.toHaveBeenCalled();
  });

  it('fails closed before export on partition mismatch', async () => {
    const { core } = createCoreStub();
    const aws = createAwsClientStub({
      getCallerIdentity: vi.fn().mockResolvedValue({
        accountId: '123456789012',
        arn: 'arn:aws:iam::123456789012:role/test',
        partition: 'aws'
      })
    });

    const err = await execute(
      baseDiscoveryInputs({
        mode: 'discover-many',
        expectedPartition: 'aws-us-gov',
        includeV2: false,
        preflightChecks: true
      }),
      { core, aws, writeSpecFile: async () => undefined }
    ).catch((error: Error) => error);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/partition mismatch/i);
    expect((err as Error).message).toMatch(/aws-us-gov/);
    expect(aws.exportRestApi).not.toHaveBeenCalled();
  });

  it('parses expected account, partition, and region pins', () => {
    const parsed = resolveInputs({
      INPUT_AWS_REGION: 'eu-west-1',
      INPUT_EXPECTED_ACCOUNT_ID: '123456789012',
      INPUT_EXPECTED_PARTITION: 'aws',
      INPUT_EXPECTED_REGION: 'eu-west-1'
    });
    expect(parsed.awsRegion).toBe('eu-west-1');
    expect(parsed.expectedAccountId).toBe('123456789012');
    expect(parsed.expectedPartition).toBe('aws');
    expect(parsed.expectedRegion).toBe('eu-west-1');
    expect(accountIndicatorFromAccountId(parsed.expectedAccountId)).toBe('***9012');
    expect(partitionFromArn('arn:aws:iam::123456789012:role/test')).toBe('aws');
  });

  it('fails closed before AWS calls when expected-region differs from aws-region', () => {
    expect(() =>
      resolveInputs({
        INPUT_AWS_REGION: 'us-east-1',
        INPUT_EXPECTED_REGION: 'eu-west-1'
      })
    ).toThrow(/region mismatch/i);
  });

  it('rejects malformed expected-account-id', () => {
    expect(() =>
      resolveInputs({
        INPUT_AWS_REGION: 'us-east-1',
        INPUT_EXPECTED_ACCOUNT_ID: 'not-an-account'
      })
    ).toThrow(/expected-account-id/);
  });
});

describe('POS-390 AppSync merged association provenance', () => {
  it('exports merged SDL once and retains sanitized source association identifiers', async () => {
    const listSourceApiAssociations = vi.fn().mockResolvedValue({
      associations: [
        { associationId: 'assoc-1', sourceApiId: 'source-a' },
        { associationId: 'assoc-2', sourceApiId: 'source-b' }
      ],
      evidence: ['Listed 2 AppSync source API association(s) for merged API merged-1']
    });
    const client: AppSyncSpecClient = {
      listGraphqlApis: vi.fn().mockResolvedValue([{ id: 'merged-1', name: 'merged', arn: 'arn:merged', apiType: 'MERGED' }]),
      getSchema: vi.fn().mockResolvedValue('type Query { hello: String }'),
      getTags: vi.fn().mockResolvedValue({}),
      listSourceApiAssociations,
      probe: vi.fn().mockResolvedValue(true)
    };
    const provider = new AppSyncProvider(client);
    const result = await provider.exportSpec(
      {
        id: 'merged-1',
        name: 'merged',
        providerType: 'appsync',
        tags: {},
        evidence: [],
        meta: { arn: 'arn:merged', apiType: 'MERGED' }
      },
      {}
    );

    expect(result.content).toContain('type Query');
    expect(listSourceApiAssociations).toHaveBeenCalledTimes(1);
    expect(result.provenance).toMatchObject({
      apiId: 'merged-1',
      protocol: 'GRAPHQL',
      appsyncAssociationEvidence: 'complete',
      appsyncSourceAssociations: [
        { associationId: 'assoc-1', sourceApiId: 'source-a' },
        { associationId: 'assoc-2', sourceApiId: 'source-b' }
      ]
    });
  });

  it('keeps SDL usable when association listing is denied and records denied evidence', async () => {
    const client: AppSyncSpecClient = {
      listGraphqlApis: vi.fn().mockResolvedValue([]),
      getSchema: vi.fn().mockResolvedValue('type Query { ok: Boolean }'),
      getTags: vi.fn().mockResolvedValue({}),
      listSourceApiAssociations: vi.fn().mockResolvedValue({
        associations: [],
        denied: true,
        evidence: ['AppSync source API association listing denied for merged API merged-1; merged SDL export continues']
      }),
      probe: vi.fn().mockResolvedValue(true)
    };
    const provider = new AppSyncProvider(client);
    const result = await provider.exportSpec(
      {
        id: 'merged-1',
        name: 'merged',
        providerType: 'appsync',
        tags: {},
        evidence: [],
        meta: { arn: 'arn:merged', apiType: 'MERGED' }
      },
      {}
    );

    expect(result.content).toContain('type Query');
    expect(result.provenance?.appsyncAssociationEvidence).toBe('denied');
    expect(result.evidence.join('\n')).toMatch(/denied/i);
  });

  it('records partial association evidence when listing is truncated', async () => {
    const client: AppSyncSpecClient = {
      listGraphqlApis: vi.fn().mockResolvedValue([]),
      getSchema: vi.fn().mockResolvedValue('type Query { ok: Boolean }'),
      getTags: vi.fn().mockResolvedValue({}),
      listSourceApiAssociations: vi.fn().mockResolvedValue({
        associations: [{ associationId: 'assoc-1', sourceApiId: 'source-a' }],
        truncated: true,
        evidence: ['AppSync source API association listing truncated after 20 pages']
      }),
      probe: vi.fn().mockResolvedValue(true)
    };
    const provider = new AppSyncProvider(client);
    const result = await provider.exportSpec(
      {
        id: 'merged-1',
        name: 'merged',
        providerType: 'appsync',
        tags: {},
        evidence: [],
        meta: { arn: 'arn:merged', apiType: 'MERGED' }
      },
      {}
    );

    expect(result.provenance?.appsyncAssociationEvidence).toBe('partial');
    expect(result.provenance?.truncation).toMatchObject({ truncated: true });
  });
});

describe('POS-390 schema/action/CLI parity for provenance inputs', () => {
  it('keeps expected identity pins in contract, action.yml, CLI, and schema', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const actionManifest = parse(readFileSync(path.join(repoRoot, 'action.yml'), 'utf8')) as {
      inputs: Record<string, unknown>;
    };
    const cliSource = readFileSync(path.join(repoRoot, 'src/cli.ts'), 'utf8');
    const schema = JSON.parse(readFileSync(path.join(repoRoot, 'schemas/resolution-json.schema.json'), 'utf8')) as {
      properties: { provenance?: { properties?: Record<string, unknown> } };
    };

    for (const name of ['expected-account-id', 'expected-partition', 'expected-region'] as const) {
      expect(contractInputNames).toContain(name);
      expect(actionContract.inputs[name]?.required).toBe(false);
      expect(actionManifest.inputs[name]).toBeTruthy();
      expect(cliSource).toContain(`'${name}'`);
    }

    const provenanceProps = schema.properties.provenance?.properties ?? {};
    for (const key of [
      'partition',
      'accountIndicator',
      'region',
      'apiArn',
      'apiId',
      'protocol',
      'configurationMode',
      'stage',
      'deploymentId',
      'exportOptions',
      'sourceTier',
      'sourceTagContract',
      'queryTimestamp',
      'artifactHash',
      'providerProbes',
      'truncation',
      'appsyncSourceAssociations',
      'appsyncAssociationEvidence'
    ]) {
      expect(provenanceProps[key]).toBeTruthy();
    }
    expect((provenanceProps.configurationMode as { enum?: string[] }).enum).toEqual([
      'deployed-stage',
      'latest-configuration',
      'partial-control-plane'
    ]);
  });
});

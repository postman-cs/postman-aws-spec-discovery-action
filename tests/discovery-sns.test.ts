import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { DiscoveredService } from '../src/contracts.js';
import { resolveInputs } from '../src/index.js';
import { ProviderRegistry } from '../src/lib/providers/registry.js';
import type { SpecProvider } from '../src/lib/providers/types.js';
import { buildExecutionOutputs, buildProviderRegistry, execute, runResolution, type ResolutionDependencies } from '../src/runtime.js';
import { createAwsClientStub, createCoreStub } from './helpers/discovery-fixtures.js';

describe('SNS runtime integration', () => {
  function createSnsProviderStub(
    overrides: Partial<NonNullable<ResolutionDependencies['snsProvider']>> = {}
  ): NonNullable<ResolutionDependencies['snsProvider']> {
    return {
      probe: vi.fn().mockResolvedValue(true),
      listCandidates: vi.fn().mockResolvedValue([]),
      resolveContract: vi.fn().mockResolvedValue({
        resolved: true,
        origin: 'repo-asyncapi',
        evidence: ['Resolved SNS contract'],
        result: {
          content: 'asyncapi: 2.6.0',
          format: 'asyncapi-yaml',
          filename: 'asyncapi.yaml',
          evidence: ['Resolved SNS contract']
        }
      }),
      ...overrides
    };
  }

  function createDiscoverManySnsProvider(overrides: Partial<SpecProvider> = {}): SpecProvider {
    return {
      type: 'sns',
      probe: vi.fn().mockResolvedValue(true),
      listCandidates: vi.fn().mockResolvedValue([]),
      exportSpec: vi.fn().mockResolvedValue({
        content: 'asyncapi: 2.6.0',
        format: 'asyncapi-yaml',
        filename: 'asyncapi.yaml',
        evidence: ['Resolved SNS contract']
      }),
      ...overrides
    };
  }

  function createSnsTopicCandidate(name: string) {
    return {
      id: `arn:aws:sns:us-east-1:123456789012:${name}`,
      name,
      providerType: 'sns' as const,
      tags: {},
      evidence: [`SNS candidate ${name}`],
      meta: { topicArn: `arn:aws:sns:us-east-1:123456789012:${name}` }
    };
  }

  function createResolvedSnsContract(
    format: 'asyncapi-yaml' | 'asyncapi-json' | 'json-schema',
    origin:
      | 'repo-asyncapi'
      | 'repo-json-schema'
      | 'generated-asyncapi'
      | 'ssm-content'
      | 'ssm-url'
      | 'catalog-url'
      | 'manual-review',
    variantCount?: number
  ) {
    return {
      resolved: true as const,
      origin,
      variantCount,
      evidence: ['Resolved SNS contract'],
      result: {
        content: format === 'json-schema' ? '{"type":"object"}' : 'asyncapi: 2.6.0',
        format,
        filename: format === 'json-schema' ? 'schema.json' : format === 'asyncapi-json' ? 'asyncapi.json' : 'asyncapi.yaml',
        evidence: ['Resolved SNS contract']
      }
    };
  }

  async function withSnsSignals<T>(fn: (tempDir: string) => Promise<T>): Promise<T> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-resolution-'));
    await writeFile(path.join(tempDir, 'template.yaml'), 'Resources:\\n  Topic:\\n    Type: AWS::SNS::Topic', 'utf8');
    try {
      return await fn(tempDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  it('resolves sns-contract when SNS confidence beats gateway confidence', async () => {
    await withSnsSignals(async (tempDir) => {
      const snsProvider = createSnsProviderStub({
        listCandidates: vi.fn().mockResolvedValue([createSnsTopicCandidate('orders-topic')]),
        resolveContract: vi.fn().mockResolvedValue(createResolvedSnsContract('asyncapi-yaml', 'repo-asyncapi'))
      });
      const awsClient = createAwsClientStub({
        listRestApis: vi.fn().mockResolvedValue([{ id: 'rest-1', name: 'payments-api' }]),
        getRestTags: vi.fn().mockResolvedValue({}),
        listRestStages: vi.fn().mockResolvedValue([{ stageName: 'prod' }])
      });

      const result = await runResolution(
        {
          mode: 'resolve-one',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'github', repoSlug: 'postman/orders-api' },
          expectedServiceName: 'orders',
          expectedGatewayIds: [],
          stage: undefined,
          apiFilter: undefined,
          serviceMapping: {},
          outputDir: 'discovered-specs',
          maxCandidates: 50,
          dryRun: false,
          preflightChecks: true,
          preflightPermissionProbe: true,
          requestTimeoutMs: 30000,
          maxAttempts: 3,
          includeV2: true
        },
        awsClient,
        createCoreStub().core,
        vi.fn().mockResolvedValue(undefined),
        { snsProvider }
      );

      expect(result.sourceType).toBe('sns-contract');
      expect(result.providerType).toBe('sns');
      expect(result.specFormat).toBe('asyncapi-yaml');
    });
  });

  it('predicts SNS native and derived paths in resolve-one dry-run without writing files', async () => {
    await withSnsSignals(async (tempDir) => {
      const writeSpecFile = vi.fn().mockResolvedValue(undefined);
      const snsProvider = createSnsProviderStub({
        listCandidates: vi.fn().mockResolvedValue([createSnsTopicCandidate('orders-topic')]),
        resolveContract: vi.fn().mockResolvedValue(createResolvedSnsContract('asyncapi-yaml', 'repo-asyncapi'))
      });

      const result = await runResolution(
        {
          mode: 'resolve-one',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'github', repoSlug: 'postman/orders-api' },
          expectedServiceName: 'orders',
          expectedGatewayIds: [],
          stage: undefined,
          apiFilter: undefined,
          serviceMapping: {},
          outputDir: 'discovered-specs',
          maxCandidates: 50,
          dryRun: true,
          preflightChecks: true,
          preflightPermissionProbe: true,
          requestTimeoutMs: 30000,
          maxAttempts: 3,
          includeV2: true
        },
        createAwsClientStub(),
        createCoreStub().core,
        writeSpecFile,
        { snsProvider }
      );

      expect(result.sourceType).toBe('sns-contract');
      expect(result.specPath).toBe('discovered-specs/orders-topic/asyncapi.yaml');
      expect(result.derivedOpenApiPath).toBe('discovered-specs/orders-topic/openapi.derived.json');
      expect(result.derivedOpenApiFormat).toBe('openapi-json');
      expect(result.evidence).toEqual(expect.arrayContaining([expect.stringContaining('Dry run enabled')]));
      expect(writeSpecFile).not.toHaveBeenCalled();
    });
  });

  it('resolves gateway-export when gateway confidence beats SNS confidence', async () => {
    await withSnsSignals(async (tempDir) => {
      const snsProvider = createSnsProviderStub({
        listCandidates: vi.fn().mockResolvedValue([createSnsTopicCandidate('orders-topic')]),
        resolveContract: vi.fn().mockResolvedValue(createResolvedSnsContract('asyncapi-yaml', 'repo-asyncapi'))
      });
      const awsClient = createAwsClientStub({
        getRestApi: vi.fn().mockResolvedValue({ id: 'rest-1', name: 'payments-api' }),
        getRestTags: vi.fn().mockResolvedValue({}),
        listRestStages: vi.fn().mockResolvedValue([{ stageName: 'prod' }]),
        exportRestApi: vi.fn().mockResolvedValue('openapi: 3.0.1')
      });

      const result = await runResolution(
        {
          mode: 'resolve-one',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'github', repoSlug: 'postman/orders-api' },
          expectedServiceName: 'orders',
          expectedGatewayIds: ['rest-1'],
          stage: undefined,
          apiFilter: undefined,
          serviceMapping: {},
          outputDir: 'discovered-specs',
          maxCandidates: 50,
          dryRun: false,
          preflightChecks: true,
          preflightPermissionProbe: true,
          requestTimeoutMs: 30000,
          maxAttempts: 3,
          includeV2: true
        },
        awsClient,
        createCoreStub().core,
        vi.fn().mockResolvedValue(undefined),
        { snsProvider }
      );

      expect(result.sourceType).toBe('gateway-export');
      expect(result.gatewayId).toBe('rest-1');
    });
  });

  it('applies equal-confidence tie-break both ways', async () => {
    await withSnsSignals(async (tempDir) => {
      const awsClient = createAwsClientStub({
        getRestApi: vi.fn().mockResolvedValue({ id: 'rest-1', name: 'payments-api' }),
        getRestTags: vi.fn().mockResolvedValue({}),
        listRestStages: vi.fn().mockResolvedValue([{ stageName: 'prod' }]),
        exportRestApi: vi.fn().mockResolvedValue('openapi: 3.0.1')
      });
      const inputs = {
        mode: 'resolve-one' as const,
        awsRegion: 'us-east-1',
        repoRoot: tempDir,
        repoContext: { provider: 'github' as const, repoSlug: 'postman/orders' },
        expectedServiceName: 'orders-api',
        expectedGatewayIds: ['rest-1'],
        stage: undefined,
        apiFilter: undefined,
        serviceMapping: {},
        outputDir: 'discovered-specs',
        maxCandidates: 50,
        dryRun: false,
        preflightChecks: true,
        preflightPermissionProbe: true,
        requestTimeoutMs: 30000,
        maxAttempts: 3,
        includeV2: true
      };

      const repoLocalProvider = createSnsProviderStub({
        listCandidates: vi.fn().mockResolvedValue([createSnsTopicCandidate('orders-api')]),
        resolveContract: vi.fn().mockResolvedValue(createResolvedSnsContract('asyncapi-yaml', 'repo-asyncapi'))
      });
      const repoLocalResult = await runResolution(inputs, awsClient, createCoreStub().core, vi.fn().mockResolvedValue(undefined), {
        snsProvider: repoLocalProvider
      });
      expect(repoLocalResult.sourceType).toBe('sns-contract');

      const ssmProvider = createSnsProviderStub({
        listCandidates: vi.fn().mockResolvedValue([createSnsTopicCandidate('orders-api')]),
        resolveContract: vi.fn().mockResolvedValue(createResolvedSnsContract('json-schema', 'ssm-content'))
      });
      const ssmResult = await runResolution(inputs, awsClient, createCoreStub().core, vi.fn().mockResolvedValue(undefined), {
        snsProvider: ssmProvider
      });
      expect(ssmResult.sourceType).toBe('gateway-export');
    });
  });

  it('keeps existing repo spec precedence over gateway and SNS', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-resolution-'));
    try {
      await writeFile(path.join(tempDir, 'openapi.yaml'), 'openapi: 3.0.0\ninfo:\n  title: Local\n  version: "1.0.0"\npaths: {}\n', 'utf8');
      await writeFile(path.join(tempDir, 'template.yaml'), 'Resources:\n  Topic:\n    Type: AWS::SNS::Topic', 'utf8');
      const writes = new Map<string, string>();
      const snsProvider = createSnsProviderStub({
        listCandidates: vi.fn().mockResolvedValue([createSnsTopicCandidate('orders-topic')])
      });
      const result = await runResolution(
        {
          mode: 'resolve-one',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'github', repoSlug: 'postman/orders-api' },
          expectedServiceName: 'orders',
          expectedGatewayIds: ['rest-1'],
          stage: undefined,
          apiFilter: undefined,
          serviceMapping: {},
          outputDir: 'discovered-specs',
          maxCandidates: 50,
          dryRun: false,
          preflightChecks: true,
          preflightPermissionProbe: true,
          requestTimeoutMs: 30000,
          maxAttempts: 3,
          includeV2: true
        },
        createAwsClientStub({ getRestApi: vi.fn().mockResolvedValue({ id: 'rest-1', name: 'orders-api' }) }),
        createCoreStub().core,
        async (outputPath, content) => {
          writes.set(outputPath.replace(/\\/g, '/'), content);
        },
        { snsProvider }
      );
      expect(result.sourceType).toBe('repo-spec');
      expect(result.specPath).toBe('openapi.yaml');
      expect(result.derivedOpenApiPath).toBe('discovered-specs/orders-api/openapi.derived.json');
      expect(result.derivedOpenApiFormat).toBe('openapi-json');
      const derived = [...writes.entries()].find(([file]) => file.endsWith('/discovered-specs/orders-api/openapi.derived.json'));
      expect(derived).toBeDefined();
      expect(JSON.parse(derived?.[1] ?? '{}')).toMatchObject({ openapi: '3.0.0' });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not probe SNS when repo signals lack sns', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-resolution-'));
    try {
      await writeFile(path.join(tempDir, 'template.yaml'), 'Resources:\n  RestApi:\n    Type: AWS::ApiGateway::RestApi', 'utf8');
      const snsProvider = createSnsProviderStub();
      const result = await runResolution(
        {
          mode: 'resolve-one',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'github', repoSlug: 'postman/orders' },
          expectedServiceName: 'orders',
          expectedGatewayIds: [],
          stage: undefined,
          apiFilter: undefined,
          serviceMapping: {},
          outputDir: 'discovered-specs',
          maxCandidates: 50,
          dryRun: false,
          preflightChecks: true,
          preflightPermissionProbe: true,
          requestTimeoutMs: 30000,
          maxAttempts: 3,
          includeV2: true
        },
        createAwsClientStub({
          listRestApis: vi.fn().mockResolvedValue([{ id: 'rest-1', name: 'orders-api' }]),
          getRestTags: vi.fn().mockResolvedValue({ 'postman:project-name': 'orders' }),
          listRestStages: vi.fn().mockResolvedValue([{ stageName: 'prod' }]),
          exportRestApi: vi.fn().mockResolvedValue('openapi: 3.0.1')
        }),
        createCoreStub().core,
        vi.fn().mockResolvedValue(undefined),
        { snsProvider }
      );
      expect(result.sourceType).toBe('gateway-export');
      expect(snsProvider.probe).not.toHaveBeenCalled();
      expect(snsProvider.listCandidates).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('skips manual-review SNS candidates in score order and accumulates evidence', async () => {
    await withSnsSignals(async (tempDir) => {
      const snsProvider = createSnsProviderStub({
        listCandidates: vi.fn().mockResolvedValue([
          createSnsTopicCandidate('z-topic'),
          createSnsTopicCandidate('orders-topic'),
          createSnsTopicCandidate('orders')
        ]),
        resolveContract: vi
          .fn()
          .mockResolvedValueOnce({ resolved: false, evidence: ['first unresolved evidence'] })
          .mockResolvedValueOnce(createResolvedSnsContract('asyncapi-yaml', 'repo-asyncapi'))
      });
      const result = await runResolution(
        {
          mode: 'resolve-one',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'github', repoSlug: 'postman/orders-api' },
          expectedServiceName: 'orders',
          expectedGatewayIds: [],
          stage: undefined,
          apiFilter: undefined,
          serviceMapping: {},
          outputDir: 'discovered-specs',
          maxCandidates: 50,
          dryRun: false,
          preflightChecks: true,
          preflightPermissionProbe: true,
          requestTimeoutMs: 30000,
          maxAttempts: 3,
          includeV2: true
        },
        createAwsClientStub(),
        createCoreStub().core,
        vi.fn().mockResolvedValue(undefined),
        { snsProvider }
      );

      expect(snsProvider.resolveContract).toHaveBeenCalledTimes(2);
      expect((snsProvider.resolveContract as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.name).toBe('orders');
      expect(result.sourceType).toBe('sns-contract');
      expect(result.evidence).toContain('first unresolved evidence');
    });
  });

  it('returns manual-review with accumulated SNS evidence when all candidates are unresolved', async () => {
    await withSnsSignals(async (tempDir) => {
      const snsProvider = createSnsProviderStub({
        listCandidates: vi.fn().mockResolvedValue([createSnsTopicCandidate('orders')]),
        resolveContract: vi.fn().mockResolvedValue({ resolved: false, evidence: ['no SNS contract found'] })
      });
      const result = await runResolution(
        {
          mode: 'resolve-one',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'github', repoSlug: 'postman/orders-api' },
          expectedServiceName: 'orders',
          expectedGatewayIds: [],
          stage: undefined,
          apiFilter: undefined,
          serviceMapping: {},
          outputDir: 'discovered-specs',
          maxCandidates: 50,
          dryRun: false,
          preflightChecks: true,
          preflightPermissionProbe: true,
          requestTimeoutMs: 30000,
          maxAttempts: 3,
          includeV2: true
        },
        createAwsClientStub(),
        createCoreStub().core,
        vi.fn().mockResolvedValue(undefined),
        { snsProvider }
      );

      expect(result.sourceType).toBe('manual-review');
      expect(result.evidence).toContain('no SNS contract found');
    });
  });

  it('uses injected SNS resolveContract seam', async () => {
    await withSnsSignals(async (tempDir) => {
      const snsProvider = createSnsProviderStub({
        listCandidates: vi.fn().mockResolvedValue([createSnsTopicCandidate('orders-topic')]),
        resolveContract: vi.fn().mockResolvedValue(createResolvedSnsContract('asyncapi-yaml', 'repo-asyncapi'))
      });

      await runResolution(
        {
          mode: 'resolve-one',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'github', repoSlug: 'postman/orders-api' },
          expectedServiceName: 'orders',
          expectedGatewayIds: [],
          stage: undefined,
          apiFilter: undefined,
          serviceMapping: {},
          outputDir: 'discovered-specs',
          maxCandidates: 50,
          dryRun: false,
          preflightChecks: true,
          preflightPermissionProbe: true,
          requestTimeoutMs: 30000,
          maxAttempts: 3,
          includeV2: true
        },
        createAwsClientStub(),
        createCoreStub().core,
        vi.fn().mockResolvedValue(undefined),
        { snsProvider }
      );
      expect(snsProvider.resolveContract).toHaveBeenCalled();
    });
  });

  it('passes SNS runtime dependencies when constructing SnsProvider', async () => {
    await withSnsSignals(async (tempDir) => {
      const createSnsProvider = vi.fn().mockReturnValue(
        createSnsProviderStub({
          listCandidates: vi.fn().mockResolvedValue([createSnsTopicCandidate('orders-topic')]),
          resolveContract: vi.fn().mockResolvedValue(createResolvedSnsContract('asyncapi-yaml', 'repo-asyncapi'))
        })
      );
      const eventBridgeClient = {
        listRegistries: vi.fn().mockResolvedValue([]),
        listSchemas: vi.fn().mockResolvedValue([]),
        exportSchema: vi.fn().mockResolvedValue('{}'),
        describeSchema: vi.fn().mockResolvedValue({ content: '{}', schemaVersion: '1' }),
        getTags: vi.fn().mockResolvedValue({}),
        probe: vi.fn().mockResolvedValue(true)
      };

      await runResolution(
        {
          mode: 'resolve-one',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'github', repoSlug: 'postman/orders-api' },
          expectedServiceName: 'orders',
          expectedGatewayIds: [],
          stage: undefined,
          apiFilter: undefined,
          serviceMapping: {},
          outputDir: 'discovered-specs',
          maxCandidates: 50,
          dryRun: false,
          preflightChecks: true,
          preflightPermissionProbe: true,
          requestTimeoutMs: 30000,
          maxAttempts: 3,
          includeV2: true
        },
        createAwsClientStub(),
        createCoreStub().core,
        vi.fn().mockResolvedValue(undefined),
        {
          createSnsProvider,
          eventBridgeClient,
          codeDerivedResolver: vi.fn().mockResolvedValue({ evidence: [] })
        }
      );

      expect(createSnsProvider).toHaveBeenCalledTimes(1);
      const call = createSnsProvider.mock.calls[0]?.[0];
      expect(call?.fetchSpecFromUrl).toBeTypeOf('function');
      expect(call?.catalogApis).toBeUndefined();
      expect(call?.eventBridgeClient).toBe(eventBridgeClient);
      expect(call?.codeDerivedResolver).toBeTypeOf('function');
    });
  });

  it.each([
    'repo-asyncapi',
    'repo-json-schema',
    'generated-asyncapi',
    'ssm-content',
    'ssm-url',
    'catalog-url',
    'manual-review'
  ] as const)('propagates SNS contract origin %s to resolution and outputs', async (origin) => {
    await withSnsSignals(async (tempDir) => {
      const snsProvider = createSnsProviderStub({
        listCandidates: vi.fn().mockResolvedValue([createSnsTopicCandidate('orders-topic')]),
        resolveContract: vi.fn().mockResolvedValue(createResolvedSnsContract('asyncapi-yaml', origin, 2))
      });

      const result = await runResolution(
        {
          mode: 'resolve-one',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'github', repoSlug: 'postman/orders-api' },
          expectedServiceName: 'orders',
          expectedGatewayIds: [],
          stage: undefined,
          apiFilter: undefined,
          serviceMapping: {},
          outputDir: 'discovered-specs',
          maxCandidates: 50,
          dryRun: false,
          preflightChecks: true,
          preflightPermissionProbe: true,
          requestTimeoutMs: 30000,
          maxAttempts: 3,
          includeV2: true
        },
        createAwsClientStub(),
        createCoreStub().core,
        vi.fn().mockResolvedValue(undefined),
        { snsProvider }
      );

      expect(result.sourceType).toBe('sns-contract');
      expect(result.contractOrigin).toBe(origin);
      expect(result.variantCount).toBe(2);
      const outputs = buildExecutionOutputs({ mode: 'resolve-one', discovered: [], resolution: result });
      expect(outputs['contract-origin']).toBe(origin);
      expect(outputs['variant-count']).toBe('2');
    });
  });

  it('registers all AWS providers in buildProviderRegistry with sns after ssm', () => {
    const inputs = resolveInputs({
      INPUT_AWS_REGION: 'us-east-1'
    });
    const registry = buildProviderRegistry(inputs, createAwsClientStub());
    const providerTypes = registry.all().map((provider) => provider.type);

    expect(providerTypes).toEqual([
      'api-gateway',
      'appsync',
      'appsync-events',
      'eventbridge-schemas',
      'eventbridge',
      'cloudformation',
      'glue',
      'bedrock-action-group',
      'alb-listener-rule',
      'ssm',
      'sns',
      'lambda-url',
      'lambda-event-source',
      'verified-permissions',
      'step-functions'
    ]);
    expect(providerTypes.indexOf('ssm')).toBeLessThan(providerTypes.indexOf('sns'));
  });

  it('includes SNS results in discover-many services output', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-discover-many-sns-'));
    const { core, warnings } = createCoreStub();
    const snsProvider = createDiscoverManySnsProvider({
      listCandidates: vi.fn().mockResolvedValue([createSnsTopicCandidate('orders-topic')])
    });
    const registry = new ProviderRegistry();
    registry.register(snsProvider);
    const awsClient = createAwsClientStub({
      listRestApis: vi.fn().mockResolvedValue([{ id: 'rest-1', name: 'orders-api' }]),
      listRestStages: vi.fn().mockResolvedValue([{ stageName: 'prod' }]),
      exportRestApi: vi.fn().mockResolvedValue([
        'openapi: 3.0.3',
        'info: { title: orders-api, version: "1" }',
        'paths:',
        '  /health:',
        '    get:',
        '      responses:',
        '        default: { description: Default response }'
      ].join('\n'))
    });

    try {
      const result = await execute(
        {
          mode: 'discover-many',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'unknown' },
          expectedGatewayIds: [],
          stage: undefined,
          apiFilter: undefined,
          serviceMapping: {},
          outputDir: 'discovered-specs',
          maxCandidates: 50,
          dryRun: false,
          preflightChecks: false,
          preflightPermissionProbe: false,
          requestTimeoutMs: 30000,
          maxAttempts: 3,
          includeV2: false
        },
        {
          core,
          aws: awsClient,
          providerRegistry: registry,
          writeSpecFile: async () => undefined
        }
      );

      const providerTypes = result.discovered.map((entry) => entry.providerType);
      expect(providerTypes).toContain('api-gateway');
      expect(providerTypes).toContain('sns');
      const services = JSON.parse(result.outputs['services-json'] ?? '[]') as Array<{
        providerType?: string;
        openapiContractAudit?: DiscoveredService['openapiContractAudit'];
      }>;
      expect(services.map((entry) => entry.providerType)).toContain('api-gateway');
      expect(services.map((entry) => entry.providerType)).toContain('sns');
      const discoveredGateway = result.discovered.find((entry) => entry.providerType === 'api-gateway');
      const outputGateway = services.find((entry) => entry.providerType === 'api-gateway');
      expect(discoveredGateway?.openapiContractAudit).toMatchObject({
        schemaVersion: 1,
        status: 'schema-incomplete',
        responsesWithoutContent: 1,
        defaultOnlyOperationCount: 1
      });
      expect(outputGateway?.openapiContractAudit).toEqual(discoveredGateway?.openapiContractAudit);
      expect(services.find((entry) => entry.providerType === 'sns')?.openapiContractAudit).toBeUndefined();
      expect(warnings.filter((message) => message.startsWith('AWS_OPENAPI_CONTRACT_INCOMPLETE:'))).toHaveLength(1);
      expect(warnings.some((message) =>
        message.includes('REST export remains schema-incomplete after deterministic enrichment')
        && message.includes('Bind API Gateway Models')
      )).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('writes SNS metadata sidecar in discover-many and records metadataPath', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-discover-many-meta-'));
    const { core } = createCoreStub();
    const writes = new Map<string, string>();
    const snsProvider = createDiscoverManySnsProvider({
      listCandidates: vi.fn().mockResolvedValue([createSnsTopicCandidate('orders-topic')]),
      exportSpec: vi.fn().mockResolvedValue({
        content: 'asyncapi: 2.6.0',
        format: 'asyncapi-yaml',
        filename: 'asyncapi.yaml',
        evidence: ['resolved'],
        sidecars: [{ filename: 'sns-resolution-metadata.json', content: '{"contractOrigin":"repo-asyncapi"}' }]
      })
    });
    const registry = new ProviderRegistry();
    registry.register(snsProvider);

    try {
      const result = await execute(
        {
          mode: 'discover-many',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'unknown' },
          expectedGatewayIds: [],
          stage: undefined,
          apiFilter: undefined,
          serviceMapping: {},
          outputDir: 'discovered-specs',
          maxCandidates: 50,
          dryRun: false,
          preflightChecks: false,
          preflightPermissionProbe: false,
          requestTimeoutMs: 30000,
          maxAttempts: 3,
          includeV2: false
        },
        {
          core,
          aws: createAwsClientStub(),
          providerRegistry: registry,
          writeSpecFile: async (outputPath: string, content: string) => {
            writes.set(outputPath.replace(/\\/g, '/'), content);
          }
        }
      );

      const service = result.discovered.find((entry) => entry.providerType === 'sns');
      expect(service?.metadataPath).toBe('discovered-specs/orders-topic/sns-resolution-metadata.json');
      expect([...writes.keys()].some((file) => file.endsWith('/discovered-specs/orders-topic/asyncapi.yaml'))).toBe(true);
      expect([...writes.keys()].some((file) => file.endsWith('/discovered-specs/orders-topic/sns-resolution-metadata.json'))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('propagates SNS contractOrigin and variantCount into discover-many services-json entries', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-discover-many-origin-'));
    const { core } = createCoreStub();
    const snsProvider = createDiscoverManySnsProvider({
      listCandidates: vi.fn().mockResolvedValue([createSnsTopicCandidate('orders-topic')]),
      exportSpec: vi.fn().mockResolvedValue({
        content: 'asyncapi: 2.6.0',
        format: 'asyncapi-yaml',
        filename: 'asyncapi.yaml',
        evidence: ['resolved'],
        sidecars: [
          {
            filename: 'sns-resolution-metadata.json',
            content: '{"contractOrigin":"repo-asyncapi","variantCount":2}'
          }
        ]
      })
    });
    const registry = new ProviderRegistry();
    registry.register(snsProvider);

    try {
      const result = await execute(
        {
          mode: 'discover-many',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'unknown' },
          expectedGatewayIds: [],
          stage: undefined,
          apiFilter: undefined,
          serviceMapping: {},
          outputDir: 'discovered-specs',
          maxCandidates: 50,
          dryRun: false,
          preflightChecks: false,
          preflightPermissionProbe: false,
          requestTimeoutMs: 30000,
          maxAttempts: 3,
          includeV2: false
        },
        {
          core,
          aws: createAwsClientStub(),
          providerRegistry: registry,
          writeSpecFile: async () => undefined
        }
      );

      const snsEntry = result.discovered.find((entry) => entry.providerType === 'sns');
      expect(snsEntry?.contractOrigin).toBe('repo-asyncapi');
      expect(snsEntry?.variantCount).toBe(2);

      const services = JSON.parse(result.outputs['services-json'] ?? '[]') as Array<{
        providerType?: string;
        contractOrigin?: string;
        variantCount?: number;
      }>;
      const serializedSns = services.find((entry) => entry.providerType === 'sns');
      expect(serializedSns?.contractOrigin).toBe('repo-asyncapi');
      expect(serializedSns?.variantCount).toBe(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('threads SNS discover-many resolution context so bridge-backed exports can emit eventbridge-derived origin', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sns-discover-many-bridge-'));
    try {
      await writeFile(
        path.join(root, 'template.yaml'),
        [
          'Resources:',
          '  Topic:',
          '    Type: AWS::SNS::Topic',
          '  HandlerFunction:',
          '    Type: AWS::Serverless::Function',
          '    Properties:',
          '      Events:',
          '        TopicEvent:',
          '          Type: SNS',
          '  BridgeRule:',
          '    Type: AWS::Events::Rule'
        ].join('\n')
      );

      const { core } = createCoreStub();
      const snsProvider = createDiscoverManySnsProvider({
        listCandidates: vi.fn().mockResolvedValue([createSnsTopicCandidate('orders-topic')]),
        exportSpec: vi.fn().mockImplementation(async (_candidate, options) => {
          const bridgeEvidence = options?.resolutionContext?.bridgeEvidence ?? [];
          const origin = bridgeEvidence.length > 0 ? 'eventbridge-derived' : 'manual-review';
          return {
            content: '{"type":"object"}',
            format: 'json-schema',
            filename: 'index.json',
            evidence: ['resolved'],
            sidecars: [
              {
                filename: 'sns-resolution-metadata.json',
                content: JSON.stringify({ contractOrigin: origin })
              }
            ]
          };
        })
      });
      const registry = new ProviderRegistry();
      registry.register(snsProvider);

      const result = await execute(
        {
          mode: 'discover-many',
          awsRegion: 'us-east-1',
          repoRoot: root,
          repoContext: { provider: 'unknown' },
          expectedGatewayIds: [],
          stage: undefined,
          apiFilter: undefined,
          serviceMapping: {},
          outputDir: 'discovered-specs',
          maxCandidates: 50,
          dryRun: false,
          preflightChecks: false,
          preflightPermissionProbe: false,
          requestTimeoutMs: 30000,
          maxAttempts: 3,
          includeV2: false
        },
        {
          core,
          aws: createAwsClientStub(),
          providerRegistry: registry,
          writeSpecFile: async () => undefined
        }
      );

      const snsEntry = result.discovered.find((entry) => entry.providerType === 'sns');
      expect(snsEntry?.contractOrigin).toBe('eventbridge-derived');
      expect(snsProvider.exportSpec).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          resolutionContext: expect.objectContaining({
            serviceHints: expect.any(Array),
            bridgeEvidence: expect.arrayContaining([expect.stringContaining('Detected SNS/EventBridge bridge pattern')])
          })
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('supports discover-many dry-run for SNS without exporting', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-discover-many-dry-run-'));
    const { core } = createCoreStub();
    const snsProvider = createDiscoverManySnsProvider({
      listCandidates: vi.fn().mockResolvedValue([createSnsTopicCandidate('orders-topic')])
    });
    const registry = new ProviderRegistry();
    registry.register(snsProvider);

    try {
      const result = await execute(
        {
          mode: 'discover-many',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'unknown' },
          expectedGatewayIds: [],
          stage: undefined,
          apiFilter: undefined,
          serviceMapping: {},
          outputDir: 'discovered-specs',
          maxCandidates: 50,
          dryRun: true,
          preflightChecks: false,
          preflightPermissionProbe: false,
          requestTimeoutMs: 30000,
          maxAttempts: 3,
          includeV2: false
        },
        {
          core,
          aws: createAwsClientStub(),
          providerRegistry: registry,
          writeSpecFile: async () => undefined
        }
      );

      expect(result.discovered).toEqual([]);
      expect(result.exportSummary?.skipped).toBe(1);
      expect(snsProvider.exportSpec).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('limits SNS candidates per provider with max-candidates', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-discover-many-limit-'));
    const { core } = createCoreStub();
    const snsProvider = createDiscoverManySnsProvider({
      listCandidates: vi.fn().mockResolvedValue([
        createSnsTopicCandidate('topic-1'),
        createSnsTopicCandidate('topic-2'),
        createSnsTopicCandidate('topic-3')
      ])
    });
    const registry = new ProviderRegistry();
    registry.register(snsProvider);

    try {
      const result = await execute(
        {
          mode: 'discover-many',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'unknown' },
          expectedGatewayIds: [],
          stage: undefined,
          apiFilter: undefined,
          serviceMapping: {},
          outputDir: 'discovered-specs',
          maxCandidates: 2,
          dryRun: false,
          preflightChecks: false,
          preflightPermissionProbe: false,
          requestTimeoutMs: 30000,
          maxAttempts: 3,
          includeV2: false
        },
        {
          core,
          aws: createAwsClientStub(),
          providerRegistry: registry,
          writeSpecFile: async () => undefined
        }
      );

      expect(snsProvider.exportSpec).toHaveBeenCalledTimes(2);
      expect(result.exportSummary?.skipped).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('writes SNS manual-review metadata sidecar and propagates metadataPath/contractOrigin in resolve-one', async () => {
    await withSnsSignals(async (tempDir) => {
      const writes = new Map<string, string>();
      const snsProvider = createSnsProviderStub({
        listCandidates: vi.fn().mockResolvedValue([createSnsTopicCandidate('orders-topic')]),
        resolveContract: vi.fn().mockResolvedValue({
          resolved: false,
          evidence: ['manual review'],
          metadata: {
            contractOrigin: 'manual-review',
            subscriptions: [],
            evidence: ['manual review'],
            subscriptionSummary: {
              topicArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic',
              total: 0,
              failed: 0,
              errors: []
            }
          }
        })
      });

      const result = await runResolution(
        {
          mode: 'resolve-one',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'github', repoSlug: 'postman/orders-api' },
          expectedServiceName: 'orders',
          expectedGatewayIds: [],
          stage: undefined,
          apiFilter: undefined,
          serviceMapping: {},
          outputDir: 'discovered-specs',
          maxCandidates: 50,
          dryRun: false,
          preflightChecks: true,
          preflightPermissionProbe: true,
          requestTimeoutMs: 30000,
          maxAttempts: 3,
          includeV2: true
        },
        createAwsClientStub(),
        createCoreStub().core,
        async (outputPath, content) => {
          writes.set(outputPath.replace(/\\/g, '/'), content);
        },
        { snsProvider }
      );

      expect(result.sourceType).toBe('manual-review');
      expect(result.contractOrigin).toBe('manual-review');
      expect(result.metadataPath).toBe('discovered-specs/orders/sns-resolution-metadata.json');
      expect([...writes.keys()].some((file) => file.endsWith('/discovered-specs/orders/sns-resolution-metadata.json'))).toBe(true);
    });
  });

  it('writes SNS metadata sidecar for successful resolve-one contract and sets metadataPath', async () => {
    await withSnsSignals(async (tempDir) => {
      const writes = new Map<string, string>();
      const snsProvider = createSnsProviderStub({
        listCandidates: vi.fn().mockResolvedValue([createSnsTopicCandidate('orders-topic')]),
        resolveContract: vi.fn().mockResolvedValue({
          resolved: true,
          origin: 'repo-asyncapi',
          evidence: ['resolved'],
          result: {
            content: 'asyncapi: 2.6.0',
            format: 'asyncapi-yaml',
            filename: 'asyncapi.yaml',
            evidence: ['resolved'],
            sidecars: [{ filename: 'webhook.openapi.json', content: '{"openapi":"3.1.0"}' }]
          },
          metadata: {
            contractOrigin: 'repo-asyncapi',
            subscriptions: [],
            evidence: ['resolved'],
            subscriptionSummary: {
              topicArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic',
              total: 0,
              failed: 0,
              errors: []
            }
          }
        })
      });

      const result = await runResolution(
        {
          mode: 'resolve-one',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'github', repoSlug: 'postman/orders-api' },
          expectedServiceName: 'orders',
          expectedGatewayIds: [],
          stage: undefined,
          apiFilter: undefined,
          serviceMapping: {},
          outputDir: 'discovered-specs',
          maxCandidates: 50,
          dryRun: false,
          preflightChecks: true,
          preflightPermissionProbe: true,
          requestTimeoutMs: 30000,
          maxAttempts: 3,
          includeV2: true
        },
        createAwsClientStub(),
        createCoreStub().core,
        async (outputPath, content) => {
          writes.set(outputPath.replace(/\\/g, '/'), content);
        },
        { snsProvider }
      );

      expect(result.sourceType).toBe('sns-contract');
      expect(result.metadataPath).toBe('discovered-specs/orders-topic/sns-resolution-metadata.json');
      expect([...writes.keys()].some((file) => file.endsWith('/discovered-specs/orders-topic/asyncapi.yaml'))).toBe(true);
      expect([...writes.keys()].some((file) => file.endsWith('/discovered-specs/orders-topic/webhook.openapi.json'))).toBe(true);
      expect([...writes.keys()].some((file) => file.endsWith('/discovered-specs/orders-topic/sns-resolution-metadata.json'))).toBe(true);
    });
  });
});

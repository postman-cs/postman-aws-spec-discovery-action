import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { DiscoveredService } from '../src/contracts.js';
import { runAction } from '../src/index.js';
import { ProviderRegistry } from '../src/lib/providers/registry.js';
import type { SpecProvider } from '../src/lib/providers/types.js';
import { buildExecutionOutputs, execute, runResolution } from '../src/runtime.js';
import { createAwsClientStub, createCoreStub } from './helpers/discovery-fixtures.js';

describe('provider-agnostic resolve-one', () => {
  function createGenericProvider(type: Exclude<SpecProvider['type'], 'api-gateway' | 'sns'>, format = 'graphql-sdl'): SpecProvider {
    return {
      type,
      probe: vi.fn().mockResolvedValue(true),
      listCandidates: vi.fn().mockResolvedValue([
        {
          id: `${type}/orders-api`,
          name: 'orders-api',
          providerType: type,
          tags: {},
          evidence: [`${type} candidate`],
          meta: {}
        }
      ]),
      exportSpec: vi.fn().mockResolvedValue({
        content: format === 'graphql-sdl' ? 'type Query { ok: String }' : '{"type":"object"}',
        format,
        filename: format === 'graphql-sdl' ? 'schema.graphql' : 'index.json',
        evidence: [`${type} exported`]
      })
    } as SpecProvider;
  }

  it.each([
    ['appsync', 'appsync-schema', 'graphql-sdl'],
    ['eventbridge-schemas', 'eventbridge-schema', 'json-schema'],
    ['eventbridge', 'eventbridge-surface', 'openapi-json'],
    ['appsync-events', 'appsync-event-api', 'openapi-json'],
    ['cloudformation', 'cfn-embedded', 'openapi-json'],
    ['glue', 'glue-schema', 'json-schema'],
    ['bedrock-action-group', 'bedrock-action-group', 'openapi-json'],
    ['alb-listener-rule', 'alb-listener-rule', 'openapi-json'],
    ['ssm', 'ssm-registry', 'openapi-json'],
    ['lambda-url', 'lambda-url-export', 'openapi-yaml'],
    ['lambda-event-source', 'lambda-event-source', 'openapi-json'],
    ['verified-permissions', 'verified-permissions-schema', 'openapi-json'],
    ['step-functions', 'step-functions-asl', 'openapi-json']
  ] as const)('selects %s candidates in resolve-one', async (providerType, sourceType, format) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'provider-resolution-'));
    try {
      const writes = new Map<string, string>();
      const provider = createGenericProvider(providerType, format);
      const result = await runResolution(
        {
          mode: 'resolve-one',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'github', repoSlug: 'postman/orders-api' },
          expectedServiceName: 'orders-api',
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
        { providers: [provider] }
      );

      expect(result.sourceType).toBe(sourceType);
      expect(result.providerType).toBe(providerType);
      expect(result.specFormat).toBe(format);
      expect([...writes.keys()].some((file) => file.includes('/discovered-specs/orders-api/'))).toBe(true);
      const derived = [...writes.entries()].find(([file]) => file.endsWith('/discovered-specs/orders-api/openapi.derived.json'));
      expect(derived).toBeDefined();
      expect(JSON.parse(derived?.[1] ?? '{}')).toHaveProperty('openapi');
      expect(result.derivedOpenApiPath).toBe('discovered-specs/orders-api/openapi.derived.json');
      expect(result.derivedOpenApiFormat).toBe('openapi-json');
      if (providerType === 'lambda-url') {
        expect(result.derivedOpenApiCompleteness).toBe('partial');
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('prefers Lambda Function URL candidates whose host appears in repo signals', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lambda-url-resolution-'));
    try {
      await writeFile(path.join(tempDir, 'README.md'), 'Production URL: https://selected.lambda-url.us-east-1.on.aws/orders');
      const writes = new Map<string, string>();
      const provider: SpecProvider = {
        type: 'lambda-url',
        probe: vi.fn().mockResolvedValue(true),
        listCandidates: vi.fn().mockResolvedValue([
          {
            id: 'other-fn',
            name: 'other-fn',
            providerType: 'lambda-url',
            tags: {},
            evidence: ['other lambda url'],
            meta: {
              gatewayType: 'LAMBDA_URL',
              functionUrl: 'https://other.lambda-url.us-east-1.on.aws/'
            }
          },
          {
            id: 'selected-fn',
            name: 'selected-fn',
            providerType: 'lambda-url',
            tags: {},
            evidence: ['selected lambda url'],
            meta: {
              gatewayType: 'LAMBDA_URL',
              functionUrl: 'https://selected.lambda-url.us-east-1.on.aws/'
            }
          }
        ]),
        exportSpec: vi.fn().mockResolvedValue({
          content: 'openapi: 3.0.3',
          format: 'openapi-yaml',
          filename: 'index.yaml',
          evidence: ['lambda url exported']
        })
      };

      const result = await runResolution(
        {
          mode: 'resolve-one',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'github', repoSlug: 'postman/unrelated-service' },
          expectedServiceName: 'unrelated-service',
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
        { providers: [provider] }
      );

      expect(result.sourceType).toBe('lambda-url-export');
      expect(result.gatewayId).toBe('selected-fn');
      expect(result.gatewayType).toBe('LAMBDA_URL');
      expect(result.evidence).toContain('Candidate selected-fn matched Lambda Function URL host hint selected.lambda-url.us-east-1.on.aws');
      expect([...writes.keys()].some((file) => file.endsWith('/discovered-specs/selected-fn/index.yaml'))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses API Gateway custom domain mappings as resolution evidence', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'domain-resolution-'));
    try {
      await writeFile(path.join(tempDir, 'README.md'), 'Production API: https://api.orders.test/v1', 'utf8');
      const awsClient = createAwsClientStub({
        listRestDomainMappings: vi.fn().mockResolvedValue([
          { domainName: 'api.orders.test', apiId: 'rest-1', basePath: 'v1', stage: 'prod', gatewayType: 'REST' }
        ]),
        getRestApi: vi.fn().mockResolvedValue({ id: 'rest-1', name: 'orders-api' }),
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
        vi.fn().mockResolvedValue(undefined)
      );

      expect(result.sourceType).toBe('gateway-export');
      expect(result.gatewayId).toBe('rest-1');
      expect(result.evidence).toContain('Matched API Gateway custom domain api.orders.test to API rest-1');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('routes explicit WebSocket API Gateway IDs to partial OpenAPI export', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ws-resolution-'));
    const written = new Map<string, string>();
    try {
      const result = await runResolution(
        {
          mode: 'resolve-one',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'github', repoSlug: 'postman/ws-api' },
          expectedServiceName: 'ws-api',
          expectedGatewayIds: ['ws-1'],
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
          getHttpApi: vi.fn().mockResolvedValue({ id: 'ws-1', name: 'ws-api', protocolType: 'WEBSOCKET' }),
          getHttpTags: vi.fn().mockResolvedValue({}),
          exportWebSocketApi: vi.fn().mockResolvedValue([
            'openapi: 3.0.3',
            'info:',
            '  title: ws-api',
            '  version: "1.0.0"',
            'paths:',
            '  /sendMessage:',
            '    post:',
            '      x-amazon-apigateway-route-key: sendMessage',
            '      responses:',
            '        "200":',
            '          description: WebSocket route accepted'
          ].join('\n'))
        }),
        createCoreStub().core,
        async (outputPath: string, content: string) => {
          written.set(outputPath.replace(/\\/g, '/'), content);
        }
      );

      expect(result.status).toBe('resolved');
      expect(result.sourceType).toBe('gateway-export');
      expect(result.providerType).toBe('api-gateway');
      expect(result.specFormat).toBe('openapi-yaml');
      expect(result.gatewayType).toBe('WEBSOCKET');
      expect(result.derivedOpenApiCompleteness).toBe('partial');
      expect(result.evidence).toContain('Synthesized partial OpenAPI 3.0 spec for WebSocket API ws-1');
      expect(result.evidence).toEqual(expect.arrayContaining([
        expect.stringMatching(/^AWS_WEBSOCKET_CONTRACT_PARTIAL:/)
      ]));
      expect(result.evidence.some((line) => line.startsWith('AWS_OPENAPI_CONTRACT_INCOMPLETE:'))).toBe(false);
      expect([...written.values()].some((content) => content.includes('x-amazon-apigateway-route-key: sendMessage'))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('runAction', () => {
  it('emits resolution outputs in resolve-one mode', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'run-action-resolution-'));
    const { core, outputs, warnings } = createCoreStub({
      'aws-region': 'us-east-1',
      'gateway-id': 'rest-1'
    });
    const previousWorkspace = process.env.GITHUB_WORKSPACE;

    const written = new Map<string, string>();
    const awsClient = createAwsClientStub({
      getRestApi: vi.fn().mockResolvedValue({ id: 'rest-1', name: 'billing' }),
      getRestTags: vi.fn().mockResolvedValue({}),
      listRestStages: vi.fn().mockResolvedValue([{ stageName: 'prod' }]),
      exportRestApi: vi.fn().mockResolvedValue([
        'openapi: 3.0.3',
        'info: { title: billing, version: "1" }',
        'paths:',
        '  /health:',
        '    get:',
        '      responses:',
        '        default: { description: Default response }'
      ].join('\n'))
    });

    try {
      process.env.GITHUB_WORKSPACE = tempDir;
      const result = await runAction(core, {
        createAwsClient: () => awsClient,
        writeSpecFile: async (outputPath: string, content: string) => {
          written.set(outputPath.replace(/\\/g, '/'), content);
        }
      });

      expect(result).toHaveLength(0);
      expect(outputs['resolution-status']).toBe('resolved');
      expect(outputs['source-type']).toBe('gateway-export');
      expect(outputs['service-name']).toBe('billing');
      expect(outputs['gateway-id']).toBe('rest-1');
      expect(outputs['spec-path']).toContain('discovered-specs/billing/index.yaml');
      expect(outputs['provider-type']).toBe('api-gateway');
      expect(outputs['spec-format']).toBe('openapi-yaml');
      expect(outputs['export-summary-json']).toContain('"attempted":0');
      expect([...written.keys()].some((entry) => entry.endsWith('/discovered-specs/billing/index.yaml'))).toBe(true);
      const resolution = JSON.parse(outputs['resolution-json'] ?? '{}') as {
        evidence?: string[];
        openapiContractAudit?: DiscoveredService['openapiContractAudit'];
      };
      expect(resolution.openapiContractAudit).toMatchObject({
        schemaVersion: 1,
        status: 'schema-incomplete',
        responsesWithoutContent: 1,
        defaultOnlyOperationCount: 1
      });
      expect(resolution.evidence).toEqual(expect.arrayContaining([
        expect.stringMatching(
          /^AWS_OPENAPI_CONTRACT_INCOMPLETE: REST export remains schema-incomplete after deterministic enrichment:/
        )
      ]));
      expect(warnings.filter((message) => message.startsWith('AWS_OPENAPI_CONTRACT_INCOMPLETE:'))).toHaveLength(1);
      expect(warnings.some((message) => message.includes('Bind API Gateway Models'))).toBe(true);
    } finally {
      if (previousWorkspace === undefined) {
        delete process.env.GITHUB_WORKSPACE;
      } else {
        process.env.GITHUB_WORKSPACE = previousWorkspace;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('downgrades export bad request errors to manual review', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'run-action-manual-review-'));
    const { core, outputs } = createCoreStub({
      'aws-region': 'us-east-1',
      'gateway-id': 'http-1'
    });
    const previousWorkspace = process.env.GITHUB_WORKSPACE;

    const awsClient = createAwsClientStub({
      getRestApi: vi.fn().mockResolvedValue(undefined),
      getHttpApi: vi.fn().mockResolvedValue({ id: 'http-1', name: 'http-service', protocolType: 'HTTP' }),
      getHttpTags: vi.fn().mockResolvedValue({}),
      listHttpStages: vi.fn().mockResolvedValue([]),
      exportHttpApi: vi.fn().mockRejectedValue(
        Object.assign(new Error('Unable to deploy API because no valid routes exist in this API'), {
          name: 'BadRequestException'
        })
      )
    });

    try {
      process.env.GITHUB_WORKSPACE = tempDir;
      await runAction(core, {
        createAwsClient: () => awsClient
      });

      expect(outputs['resolution-status']).toBe('unresolved');
      expect(outputs['source-type']).toBe('manual-review');
    } finally {
      if (previousWorkspace === undefined) {
        delete process.env.GITHUB_WORKSPACE;
      } else {
        process.env.GITHUB_WORKSPACE = previousWorkspace;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses REST API Gateway model fallback when native export hits a known limitation', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'run-action-rest-fallback-'));
    const { core, outputs } = createCoreStub({
      'aws-region': 'us-east-1',
      'gateway-id': 'rest-1'
    });
    const previousWorkspace = process.env.GITHUB_WORKSPACE;
    const written = new Map<string, string>();

    const awsClient = createAwsClientStub({
      getRestApi: vi.fn().mockResolvedValue({ id: 'rest-1', name: 'orders-rest' }),
      getRestTags: vi.fn().mockResolvedValue({}),
      listRestStages: vi.fn().mockResolvedValue([{ stageName: 'prod' }]),
      exportRestApi: vi.fn().mockRejectedValue(
        Object.assign(new Error('Only found non-JSON body models for REST API export'), {
          name: 'BadRequestException'
        })
      ),
      exportRestApiFallback: vi.fn().mockResolvedValue([
        'openapi: 3.0.3',
        'info:',
        '  title: orders-rest',
        '  version: "1.0.0"',
        'paths:',
        '  /orders:',
        '    post:',
        '      operationId: createOrder',
        '      responses:',
        '        "200":',
        '          description: Response',
        'x-postman-discovery:',
        '  apiGatewayFallback: true'
      ].join('\n'))
    });

    try {
      process.env.GITHUB_WORKSPACE = tempDir;
      await runAction(core, {
        createAwsClient: () => awsClient,
        writeSpecFile: async (outputPath: string, content: string) => {
          written.set(outputPath.replace(/\\/g, '/'), content);
        }
      });

      expect(outputs['resolution-status']).toBe('resolved');
      expect(outputs['source-type']).toBe('gateway-export');
      expect(outputs['spec-path']).toContain('discovered-specs/orders-rest/index.yaml');
      expect(outputs['derived-openapi-completeness']).toBe('partial');
      expect(JSON.parse(outputs['resolution-json'] ?? '{}').evidence).toEqual(
        expect.arrayContaining([expect.stringContaining('fallback')])
      );
      expect([...written.values()].some((content) => content.includes('apiGatewayFallback: true'))).toBe(true);
    } finally {
      if (previousWorkspace === undefined) {
        delete process.env.GITHUB_WORKSPACE;
      } else {
        process.env.GITHUB_WORKSPACE = previousWorkspace;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('propagates provider-type and spec-format for non-gateway resolve-one results', () => {
    const outputs = buildExecutionOutputs({
      mode: 'resolve-one',
      discovered: [],
      resolution: {
        status: 'resolved',
        sourceType: 'sns-contract',
        serviceName: 'orders-topic',
        confidence: 100,
        gatewayId: 'arn:aws:sns:us-east-1:123456789012:orders-topic',
        gatewayType: 'SNS',
        providerType: 'sns',
        specFormat: 'asyncapi-yaml',
        contractOrigin: 'repo-asyncapi',
        metadataPath: 'discovered-specs/orders-topic/sns-resolution-metadata.json',
        variantCount: 2,
        evidence: ['Resolved SNS contract']
      }
    });

    expect(outputs['source-type']).toBe('sns-contract');
    expect(outputs['provider-type']).toBe('sns');
    expect(outputs['spec-format']).toBe('asyncapi-yaml');
    expect(outputs['contract-origin']).toBe('repo-asyncapi');
    expect(outputs['contract-metadata-path']).toBe('discovered-specs/orders-topic/sns-resolution-metadata.json');
    expect(outputs['variant-count']).toBe('2');
  });

  it('emits derived OpenAPI scalar outputs in resolve-one mode', () => {
    const outputs = buildExecutionOutputs({
      mode: 'resolve-one',
      discovered: [],
      resolution: {
        status: 'resolved',
        sourceType: 'repo-spec',
        serviceName: 'orders-api',
        confidence: 100,
        specPath: 'openapi.yaml',
        specFormat: 'openapi-yaml',
        derivedOpenApiPath: 'discovered-specs/orders-api/openapi.derived.json',
        derivedOpenApiVersion: '3.0.3',
        derivedOpenApiCompleteness: 'full',
        derivedOpenApiFormat: 'openapi-json',
        derivedOpenApiEvidence: ['Source artifact is already OpenAPI 3.x'],
        evidence: ['Resolved from repository specification openapi.yaml']
      }
    });

    expect(outputs['derived-openapi-path']).toBe('discovered-specs/orders-api/openapi.derived.json');
    expect(outputs['derived-openapi-version']).toBe('3.0.3');
    expect(outputs['derived-openapi-completeness']).toBe('full');
    expect(outputs['derived-openapi-format']).toBe('openapi-json');
    expect(JSON.parse(outputs['derived-openapi-evidence-json'] ?? '[]')).toEqual(['Source artifact is already OpenAPI 3.x']);
  });

  it('keeps discover-many derived OpenAPI scalar outputs blank while preserving per-service metadata', () => {
    const outputs = buildExecutionOutputs({
      mode: 'discover-many',
      discovered: [
        {
          serviceName: 'orders-api',
          specPath: 'discovered-specs/orders-api/index.yaml',
          gatewayId: 'rest-1',
          gatewayType: 'REST',
          stage: 'prod',
          providerType: 'api-gateway',
          specFormat: 'openapi-yaml',
          derivedOpenApiPath: 'discovered-specs/orders-api/openapi.derived.json',
          derivedOpenApiVersion: '3.0.3',
          derivedOpenApiCompleteness: 'full',
          derivedOpenApiFormat: 'openapi-json',
          derivedOpenApiEvidence: ['Source artifact is already OpenAPI 3.x']
        }
      ]
    });

    expect(outputs['derived-openapi-path']).toBe('');
    expect(outputs['derived-openapi-version']).toBe('');
    expect(outputs['derived-openapi-completeness']).toBe('');
    expect(outputs['derived-openapi-format']).toBe('');
    expect(outputs['derived-openapi-evidence-json']).toBe('');
    const services = JSON.parse(outputs['services-json'] ?? '[]') as Array<{ derivedOpenApiPath?: string }>;
    expect(services[0]?.derivedOpenApiPath).toBe('discovered-specs/orders-api/openapi.derived.json');
  });

  it.each([
    'repo-asyncapi',
    'repo-json-schema',
    'generated-asyncapi',
    'ssm-content',
    'ssm-url',
    'catalog-url',
    'eventbridge-derived',
    'code-derived'
  ] as const)('keeps existing consumer fields stable for sns origin %s', (origin) => {
    const outputs = buildExecutionOutputs({
      mode: 'resolve-one',
      discovered: [],
      resolution: {
        status: 'resolved',
        sourceType: 'sns-contract',
        serviceName: 'orders-topic',
        confidence: 80,
        specPath: `discovered-specs/orders-topic/${origin === 'repo-asyncapi' ? 'asyncapi.yaml' : 'index.json'}`,
        gatewayId: 'arn:aws:sns:us-east-1:123456789012:orders-topic',
        gatewayType: 'SNS',
        providerType: 'sns',
        specFormat: origin === 'repo-asyncapi' ? 'asyncapi-yaml' : 'json-schema',
        contractOrigin: origin,
        evidence: ['resolved']
      }
    });

    expect(outputs['source-type']).toBe('sns-contract');
    expect(outputs['provider-type']).toBe('sns');
    expect(outputs['spec-path']).toContain('discovered-specs/orders-topic/');
  });

  it('marks discover-many unresolved on export failures by default', async () => {
    const previousMode = process.env.INPUT_MODE;
    process.env.INPUT_MODE = 'discover-many';
    const { core, outputs, warnings } = createCoreStub({
      'aws-region': 'us-east-1'
    });
    const awsClient = createAwsClientStub({
      listRestApis: vi.fn().mockResolvedValue([{ id: 'rest-1', name: 'billing' }]),
      listRestStages: vi.fn().mockResolvedValue([{ stageName: 'prod' }]),
      exportRestApi: vi.fn().mockRejectedValue(new Error('exploded'))
    });
    try {
      await runAction(core, {
        createAwsClient: () => awsClient
      });
      expect(outputs['resolution-status']).toBe('unresolved');
      expect(outputs['export-summary-json']).toContain('"failed":1');
      const warning = warnings.find((message) => /discover-many partial success/i.test(message));
      expect(warning).toBeDefined();
      expect(warning).toMatch(/attempted=\d+/);
      expect(warning).toMatch(/exported=\d+/);
      expect(warning).toMatch(/failed=1/);
      expect(warning).toMatch(/skipped=\d+/);
      expect(warning).toMatch(/resolution-status is unresolved/i);
      expect(warning).toMatch(/export-summary-json/i);
      expect(warning).toMatch(/fix IAM\/stage\/source errors/i);
      expect(warning).toMatch(/re-run/i);
    } finally {
      if (previousMode === undefined) {
        delete process.env.INPUT_MODE;
      } else {
        process.env.INPUT_MODE = previousMode;
      }
    }
  });

  it('warns when a non-API-Gateway provider listCandidates rejects in discover-many', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-discover-many-list-fail-'));
    const { core, warnings } = createCoreStub();
    const failingProvider: SpecProvider = {
      type: 'appsync',
      probe: vi.fn().mockResolvedValue(true),
      listCandidates: vi.fn().mockRejectedValue(
        new Error('AccessDeniedException: User is not authorized to perform: appsync:ListGraphqlApis')
      ),
      exportSpec: vi.fn()
    };
    const registry = new ProviderRegistry();
    registry.register(failingProvider);

    try {
      const result = await execute(
        {
          mode: 'discover-many',
          awsRegion: 'us-west-2',
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

      expect(result.exportSummary?.failed).toBeGreaterThanOrEqual(1);
      expect(result.outputs['resolution-status']).toBe('unresolved');
      expect(result.outputs['export-summary-json']).toMatch(/"failed":\s*[1-9]/);
      const warning = warnings.find((message) => /listing candidates from appsync/i.test(message));
      expect(warning).toBeDefined();
      expect(warning).toMatch(/Attempted listing candidates from appsync/i);
      expect(warning).toMatch(/us-west-2/);
      expect(warning).toMatch(/appsync:ListGraphqlApis|AccessDeniedException|not authorized/i);
      expect(warning).toMatch(/Continuing with other providers|export summary failed count/i);
      expect(warning).toMatch(/Grant appsync read permission|service is available/i);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('warns when a non-API-Gateway provider exportSpec rejects in discover-many', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-discover-many-export-fail-'));
    const { core, warnings } = createCoreStub();
    const failingProvider: SpecProvider = {
      type: 'appsync',
      probe: vi.fn().mockResolvedValue(true),
      listCandidates: vi.fn().mockResolvedValue([
        {
          id: 'appsync-api-1',
          name: 'orders-gql',
          providerType: 'appsync',
          tags: {},
          evidence: ['appsync candidate'],
          meta: {}
        }
      ]),
      exportSpec: vi.fn().mockRejectedValue(new Error('GetIntrospectionSchema failed: AccessDeniedException'))
    };
    const registry = new ProviderRegistry();
    registry.register(failingProvider);

    try {
      const result = await execute(
        {
          mode: 'discover-many',
          awsRegion: 'eu-central-1',
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

      expect(result.exportSummary?.failed).toBeGreaterThanOrEqual(1);
      expect(result.outputs['resolution-status']).toBe('unresolved');
      expect(result.outputs['export-summary-json']).toMatch(/"failed":\s*[1-9]/);
      const warning = warnings.find((message) => /export of appsync candidate appsync-api-1/i.test(message));
      expect(warning).toBeDefined();
      expect(warning).toMatch(/Attempted export of appsync candidate appsync-api-1 \(orders-gql\)/i);
      expect(warning).toMatch(/eu-central-1/);
      expect(warning).toMatch(/GetIntrospectionSchema failed|AccessDeniedException/i);
      expect(warning).toMatch(/Continuing with remaining candidates|export summary failed count/i);
      expect(warning).toMatch(/Grant appsync export\/read permission|service is available/i);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

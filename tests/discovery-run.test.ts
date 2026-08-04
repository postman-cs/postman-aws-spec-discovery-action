import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { runDiscovery } from '../src/index.js';
import { createRemoteFetchPolicy } from '../src/lib/fetch/spec-fetcher.js';
import { runResolution } from '../src/runtime.js';
import { createAwsClientStub, createCoreStub } from './helpers/discovery-fixtures.js';

describe('runDiscovery', () => {
  it('exports REST and HTTP specs, resolves names by priority, and continues on single API failure', async () => {
    const { core, warnings } = createCoreStub();
    const written = new Map<string, string>();

    const aws = {
      listRestApis: vi.fn().mockResolvedValue([
        { id: 'rest-1', name: 'rest-api-one' },
        { id: 'rest-2', name: 'legacy-name' }
      ]),
      listHttpApis: vi.fn().mockResolvedValue([{ id: 'http-1', name: 'checkout-http', protocolType: 'HTTP' }]),
      getRestApi: vi.fn(),
      getHttpApi: vi.fn(),
      listRestStages: vi
        .fn()
        .mockImplementation(async (id: string) => (id === 'rest-2' ? [{ stageName: 'staging' }] : [{ stageName: 'prod' }])),
      listHttpStages: vi.fn().mockResolvedValue([{ stageName: '$default' }]),
      getRestTags: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'rest-1') {
          return {
            'postman:project-name': 'payments-core',
            Name: 'ignored'
          };
        }

        return {
          Name: 'name-tag-service'
        };
      }),
      getHttpTags: vi.fn().mockResolvedValue({}),
      getCallerIdentity: vi.fn().mockResolvedValue({
        accountId: '123456789012',
        arn: 'arn:aws:iam::123456789012:role/test'
      }),
      probeApiGatewayReadAccess: vi.fn().mockResolvedValue(undefined),
      exportRestApi: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'rest-2') {
          throw new Error('simulated export failure');
        }
        return `openapi: 3.0.1\ninfo:\n  title: ${id}`;
      }),
      exportHttpApi: vi.fn().mockResolvedValue('openapi: 3.0.1\ninfo:\n  title: http'),
      exportWebSocketApi: vi.fn().mockResolvedValue('openapi: 3.0.3\ninfo:\n  title: websocket')
    };

    const result = await runDiscovery(
      {
        mode: 'discover-many',
        awsRegion: 'us-east-1',
        repoRoot: '.',
        repoContext: { provider: 'unknown' },
        expectedGatewayIds: [],
        stage: undefined,
        apiFilter: undefined,
        serviceMapping: {
          'http-1': 'checkout-service'
        },
        outputDir: 'discovered-specs',
        maxCandidates: 50,
        dryRun: false,
        preflightChecks: true,
        preflightPermissionProbe: true,
        requestTimeoutMs: 30000,
        maxAttempts: 3,
        includeV2: true
      },
      {
        core,
        aws,
        writeSpecFile: async (outputPath: string, content: string) => {
          written.set(outputPath.replace(/\\/g, '/'), content);
        }
      }
    );
    const discovered = result.discovered;

    expect(discovered).toHaveLength(2);
    expect(discovered[0]).toMatchObject({
      serviceName: 'payments-core',
      specPath: 'discovered-specs/payments-core/index.yaml',
      gatewayId: 'rest-1',
      gatewayType: 'REST',
      stage: 'prod',
      providerType: 'api-gateway',
      specFormat: 'openapi-yaml',
      derivedOpenApiPath: 'discovered-specs/payments-core/openapi.derived.json',
      derivedOpenApiVersion: '3.0.3',
      derivedOpenApiCompleteness: 'full',
      derivedOpenApiFormat: 'openapi-json',
      derivedOpenApiEvidence: ['Source artifact is already OpenAPI 3.x'],
      provenance: {
        configurationMode: 'deployed-stage',
        stage: 'prod',
        accountIndicator: '***9012',
        region: 'us-east-1',
        protocol: 'REST'
      }
    });
    expect(discovered[1]).toMatchObject({
      serviceName: 'checkout-service',
      specPath: 'discovered-specs/checkout-service/index.yaml',
      gatewayId: 'http-1',
      gatewayType: 'HTTP',
      stage: '$default',
      providerType: 'api-gateway',
      specFormat: 'openapi-yaml',
      derivedOpenApiPath: 'discovered-specs/checkout-service/openapi.derived.json',
      derivedOpenApiVersion: '3.0.3',
      derivedOpenApiCompleteness: 'full',
      derivedOpenApiFormat: 'openapi-json',
      derivedOpenApiEvidence: ['Source artifact is already OpenAPI 3.x'],
      provenance: {
        configurationMode: 'deployed-stage',
        stage: '$default',
        accountIndicator: '***9012',
        region: 'us-east-1',
        protocol: 'HTTP'
      }
    });

    expect(
      [...written.keys()].some((entry) => entry.endsWith('/discovered-specs/payments-core/index.yaml'))
    ).toBe(true);
    expect(
      [...written.keys()].some((entry) => entry.endsWith('/discovered-specs/checkout-service/index.yaml'))
    ).toBe(true);
    expect(
      [...written.keys()].some((entry) => entry.endsWith('/discovered-specs/payments-core/openapi.derived.json'))
    ).toBe(true);
    expect(
      [...written.keys()].some((entry) => entry.endsWith('/discovered-specs/checkout-service/openapi.derived.json'))
    ).toBe(true);
    const exportFailureWarning = warnings.find((message) => message.includes('simulated export failure'));
    expect(exportFailureWarning).toBeDefined();
    expect(exportFailureWarning).toMatch(/Attempted export of REST API rest-2 \(legacy-name\)/i);
    expect(exportFailureWarning).toMatch(/us-east-1/);
    expect(exportFailureWarning).toMatch(/simulated export failure/);
    expect(exportFailureWarning).toMatch(/Grant API Gateway export\/read permission|fix stage\/export errors|re-run/i);
    expect(result.summary.failed).toBe(1);
  });

  it('warns with operation, region, cause, and remediation when REST enumeration fails', async () => {
    const { core, warnings } = createCoreStub();
    const aws = createAwsClientStub({
      listRestApis: vi.fn().mockRejectedValue(new Error('AccessDeniedException: User is not authorized to perform: apigateway:GET')),
      listHttpApis: vi.fn().mockResolvedValue([])
    });

    const result = await runDiscovery(
      {
        mode: 'discover-many',
        awsRegion: 'us-west-2',
        repoRoot: '.',
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
        aws,
        writeSpecFile: async () => undefined
      }
    );

    expect(result.discovered).toHaveLength(0);
    const warning = warnings.find((message) => /REST API enumeration/i.test(message));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/Attempted REST API enumeration/i);
    expect(warning).toMatch(/us-west-2/);
    expect(warning).toMatch(/AccessDeniedException|not authorized|apigateway:GET/i);
    expect(warning).toMatch(/Continuing without REST candidates/i);
    expect(warning).toMatch(/Grant API Gateway read permission|correct role/i);
  });

  it('warns with operation, region, cause, and remediation when HTTP enumeration fails', async () => {
    const { core, warnings } = createCoreStub();
    const aws = createAwsClientStub({
      listRestApis: vi.fn().mockResolvedValue([]),
      listHttpApis: vi.fn().mockRejectedValue(
        new Error('AccessDeniedException: User is not authorized to perform: apigateway:GET on HTTP APIs')
      )
    });

    const result = await runDiscovery(
      {
        mode: 'discover-many',
        awsRegion: 'ap-southeast-2',
        repoRoot: '.',
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
        includeV2: true
      },
      {
        core,
        aws,
        writeSpecFile: async () => undefined
      }
    );

    expect(result.discovered).toHaveLength(0);
    expect(result.summary.exported).toBe(0);
    expect(aws.listHttpApis).toHaveBeenCalled();
    const warning = warnings.find((message) => /HTTP API enumeration/i.test(message));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/Attempted HTTP API enumeration/i);
    expect(warning).toMatch(/ap-southeast-2/);
    expect(warning).toMatch(/AccessDeniedException|not authorized|HTTP APIs/i);
    expect(warning).toMatch(/Continuing without HTTP candidates/i);
    expect(warning).toMatch(/Grant API Gateway read permission|correct role/i);
  });

  it('skips HTTP discovery when include-v2=false and applies API filter', async () => {
    const { core } = createCoreStub();

    const aws = {
      listRestApis: vi.fn().mockResolvedValue([
        { id: 'rest-a', name: 'payments-public' },
        { id: 'rest-b', name: 'internal-tools' }
      ]),
      listHttpApis: vi.fn().mockResolvedValue([{ id: 'http-1', name: 'payments-http', protocolType: 'HTTP' }]),
      getRestApi: vi.fn(),
      getHttpApi: vi.fn(),
      listRestStages: vi.fn().mockResolvedValue([{ stageName: 'prod' }]),
      listHttpStages: vi.fn().mockResolvedValue([{ stageName: 'prod' }]),
      getRestTags: vi.fn().mockResolvedValue({}),
      getHttpTags: vi.fn().mockResolvedValue({}),
      getCallerIdentity: vi.fn().mockResolvedValue({
        accountId: '123456789012',
        arn: 'arn:aws:iam::123456789012:role/test'
      }),
      probeApiGatewayReadAccess: vi.fn().mockResolvedValue(undefined),
      exportRestApi: vi.fn().mockResolvedValue('openapi: 3.0.1'),
      exportHttpApi: vi.fn().mockResolvedValue('openapi: 3.0.1'),
      exportWebSocketApi: vi.fn().mockResolvedValue('openapi: 3.0.3')
    };

    const result = await runDiscovery(
      {
        mode: 'discover-many',
        awsRegion: 'us-east-1',
        repoRoot: '.',
        repoContext: { provider: 'unknown' },
        expectedGatewayIds: [],
        stage: 'prod',
        apiFilter: /^payments/,
        serviceMapping: {},
        outputDir: 'discovered-specs',
        maxCandidates: 50,
        dryRun: false,
        preflightChecks: true,
        preflightPermissionProbe: true,
        requestTimeoutMs: 30000,
        maxAttempts: 3,
        includeV2: false
      },
      {
        core,
        aws,
        writeSpecFile: async () => undefined
      }
    );
    const discovered = result.discovered;

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.gatewayId).toBe('rest-a');
    expect(aws.listHttpApis).not.toHaveBeenCalled();
    expect(aws.exportHttpApi).not.toHaveBeenCalled();
  });

  it('supports dry-run without exporting any specs', async () => {
    const { core } = createCoreStub();
    const aws = createAwsClientStub({
      listRestApis: vi.fn().mockResolvedValue([{ id: 'rest-a', name: 'payments-public' }]),
      listRestStages: vi.fn().mockResolvedValue([{ stageName: 'prod' }])
    });
    const result = await runDiscovery(
      {
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
        dryRun: true,
        preflightChecks: true,
        preflightPermissionProbe: true,
        requestTimeoutMs: 30000,
        maxAttempts: 3,
        includeV2: false
      },
      {
        core,
        aws,
        writeSpecFile: async () => undefined
      }
    );
    expect(result.discovered).toHaveLength(0);
    expect(result.summary.skipped).toBeGreaterThan(0);
    expect(aws.exportRestApi).not.toHaveBeenCalled();
  });

  it('predicts API Gateway native and derived paths in resolve-one dry-run without exporting', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-dry-run-'));
    try {
      const writeSpecFile = vi.fn().mockResolvedValue(undefined);
      const aws = createAwsClientStub({
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
          expectedServiceName: 'orders-api',
          expectedGatewayIds: ['rest-1'],
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
        aws,
        createCoreStub().core,
        writeSpecFile
      );

      expect(result.sourceType).toBe('gateway-export');
      expect(result.specPath).toBe('discovered-specs/orders-api/index.yaml');
      expect(result.derivedOpenApiPath).toBe('discovered-specs/orders-api/openapi.derived.json');
      expect(result.derivedOpenApiFormat).toBe('openapi-json');
      expect(result.openapiContractAudit).toBeUndefined();
      expect(result.derivedOpenApiEvidence).toEqual(expect.arrayContaining([expect.stringContaining('Dry run enabled')]));
      expect(aws.exportRestApi).not.toHaveBeenCalled();
      expect(writeSpecFile).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('routes allowlisted Backstage remote specs through the shared writer and writes nothing in dry-run', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'catalog-remote-dry-run-'));
    const writeSpecFile = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue({
      content: 'openapi: 3.0.3\ninfo:\n  title: Orders\n  version: "1.0.0"\npaths: {}\n',
      contentType: 'application/yaml',
      finalUrl: 'https://example.com/openapi.yaml'
    });
    try {
      await writeFile(
        path.join(tempDir, 'catalog-info.yaml'),
        [
          'apiVersion: backstage.io/v1alpha1',
          'kind: API',
          'metadata:',
          '  name: orders-api',
          'spec:',
          '  type: openapi',
          '  definition:',
          '    $text: https://example.com/openapi.yaml'
        ].join('\n'),
        'utf8'
      );

      const result = await runResolution(
        {
          mode: 'resolve-one',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'github', repoSlug: 'postman/orders-api' },
          expectedServiceName: undefined,
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
          includeV2: true,
          remoteFetchPolicy: createRemoteFetchPolicy({
            enabled: true,
            allowlist: [{ hostname: 'example.com', pathPrefix: '/' }]
          })
        },
        createAwsClientStub(),
        createCoreStub().core,
        writeSpecFile,
        { fetchSpecFromUrl: fetchMock }
      );

      expect(result.sourceType).toBe('repo-spec');
      expect(result.specPath).toBe('discovered-specs/orders-api/openapi.yaml');
      expect(result.derivedOpenApiPath).toBe('discovered-specs/orders-api/openapi.derived.json');
      expect(result.derivedOpenApiFormat).toBe('openapi-json');
      expect(result.derivedOpenApiEvidence).toEqual(expect.arrayContaining([expect.stringContaining('Dry run enabled')]));
      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.com/openapi.yaml',
        expect.objectContaining({
          timeoutMs: 15000,
          policy: expect.objectContaining({ enabled: true })
        })
      );
      expect(writeSpecFile).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('denies Backstage remote fetches when remote-fetch-allowlist-json is absent', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'catalog-remote-deny-'));
    const writeSpecFile = vi.fn().mockResolvedValue(undefined);
    const { core, warnings } = createCoreStub();
    const fetchMock = vi.fn(async (_url: string, options?: { policy?: { enabled?: boolean } }) => {
      if (!options?.policy?.enabled) {
        throw new Error('Remote spec fetch is disabled by default');
      }
      return {
        content: 'openapi: 3.0.3\ninfo:\n  title: Orders\n  version: "1.0.0"\npaths: {}\n',
        contentType: 'application/yaml',
        finalUrl: 'https://example.com/openapi.yaml'
      };
    });
    try {
      await writeFile(
        path.join(tempDir, 'catalog-info.yaml'),
        [
          'apiVersion: backstage.io/v1alpha1',
          'kind: API',
          'metadata:',
          '  name: orders-api',
          'spec:',
          '  type: openapi',
          '  definition:',
          '    $text: https://example.com/openapi.yaml'
        ].join('\n'),
        'utf8'
      );

      const result = await runResolution(
        {
          mode: 'resolve-one',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'github', repoSlug: 'postman/orders-api' },
          expectedServiceName: undefined,
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
        core,
        writeSpecFile,
        { fetchSpecFromUrl: fetchMock }
      );

      expect(result.sourceType).not.toBe('repo-spec');
      expect(fetchMock).toHaveBeenCalled();
      expect(writeSpecFile).not.toHaveBeenCalled();
      const warning = warnings.find((message) => /Backstage entity orders-api/i.test(message));
      expect(warning).toBeDefined();
      expect(warning).toMatch(/Attempted fetch of Backstage entity orders-api/i);
      expect(warning).toContain('https://example.com/openapi.yaml');
      expect(warning).toMatch(/Remote spec fetch is disabled by default/i);
      expect(warning).toMatch(/allowlist the HTTPS host\/path|allowlist/i);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('warns and continues when Backstage local catalog definition cannot be read', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'catalog-local-miss-'));
    const writeSpecFile = vi.fn().mockResolvedValue(undefined);
    const { core, warnings } = createCoreStub();
    try {
      await writeFile(
        path.join(tempDir, 'catalog-info.yaml'),
        [
          'apiVersion: backstage.io/v1alpha1',
          'kind: API',
          'metadata:',
          '  name: billing-api',
          'spec:',
          '  type: openapi',
          '  definition:',
          '    $text: ./specs/missing-openapi.yaml'
        ].join('\n'),
        'utf8'
      );

      const result = await runResolution(
        {
          mode: 'resolve-one',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'github', repoSlug: 'postman/billing-api' },
          expectedServiceName: undefined,
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
        core,
        writeSpecFile
      );

      expect(result.sourceType).not.toBe('repo-spec');
      expect(writeSpecFile).not.toHaveBeenCalled();
      const warning = warnings.find((message) => /Backstage entity billing-api/i.test(message));
      expect(warning).toBeDefined();
      expect(warning).toMatch(/Attempted read of Backstage entity billing-api/i);
      expect(warning).toMatch(/specs\/missing-openapi\.yaml/);
      expect(warning).toMatch(/ENOENT|no such file|not found|not usable|Unable|cannot|failed/i);
      expect(warning).toMatch(/Continuing discovery without this catalog contract/i);
      expect(warning).toMatch(/Correct the catalog definition or local path/i);
      expect(warning).toMatch(/re-run/i);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

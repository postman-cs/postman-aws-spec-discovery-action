import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { DiscoveredService } from '../src/contracts.js';
import { readActionInputs, resolveInputs, runDiscovery, runAction } from '../src/index.js';
import type { AwsGatewayClient } from '../src/lib/aws/client.js';
import { parseCliArgs, toDotenv } from '../src/cli.js';
import { detectCatalogApis } from '../src/lib/repo/catalog.js';
import { findExistingRepoSpec, findExistingRepoSpecTyped } from '../src/lib/repo/specs.js';
import { collectRepoSignals } from '../src/lib/repo/signals.js';
import { resolveServiceCandidate } from '../src/lib/resolve/service-resolver.js';
import { chooseSource } from '../src/lib/resolve/source-selector.js';
import { ProviderRegistry } from '../src/lib/providers/registry.js';
import type { SpecProvider } from '../src/lib/providers/types.js';
import { createRemoteFetchPolicy } from '../src/lib/fetch/spec-fetcher.js';
import { buildExecutionOutputs, buildProviderRegistry, execute, runResolution, type ResolutionDependencies } from '../src/runtime.js';

function createCoreStub(values: Record<string, string> = {}) {
  const outputs: Record<string, string> = {};
  const infos: string[] = [];
  const warnings: string[] = [];

  return {
    core: {
      getInput: (name: string, options?: { required?: boolean }) => {
        const value = values[name] ?? '';
        if (options?.required && !value) {
          throw new Error(`Input required and not supplied: ${name}`);
        }
        return value;
      },
      group: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      info: (message: string) => {
        infos.push(message);
      },
      warning: (message: string) => {
        warnings.push(message);
      },
      setOutput: (name: string, value: string) => {
        outputs[name] = value;
      },
      setFailed: vi.fn()
    },
    outputs,
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
    exportRestApi: vi.fn().mockResolvedValue('openapi: 3.0.1'),
    exportHttpApi: vi.fn().mockResolvedValue('openapi: 3.0.1'),
    exportWebSocketApi: vi.fn().mockResolvedValue('openapi: 3.0.3'),
    getCallerIdentity: vi.fn().mockResolvedValue({
      accountId: '123456789012',
      arn: 'arn:aws:iam::123456789012:role/test'
    }),
    probeApiGatewayReadAccess: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe('input parsing', () => {
  it('reads the simplified public action inputs', () => {
    const { core } = createCoreStub({
      'aws-region': 'us-west-2',
      'gateway-id': 'rest-1',
      stage: 'prod',
      'output-dir': 'out/specs'
    });

    // Clear CI workspace env vars to avoid fallback pollution in test
    const origGH = process.env.GITHUB_WORKSPACE;
    const origGL = process.env.CI_PROJECT_DIR;
    const origBB = process.env.BITBUCKET_CLONE_DIR;
    const origADO = process.env.BUILD_SOURCESDIRECTORY;
    delete process.env.GITHUB_WORKSPACE;
    delete process.env.CI_PROJECT_DIR;
    delete process.env.BITBUCKET_CLONE_DIR;
    delete process.env.BUILD_SOURCESDIRECTORY;

    try {
      const inputs = readActionInputs(core);

      expect(inputs.mode).toBe('resolve-one');
      expect(inputs.awsRegion).toBe('us-west-2');
      expect(inputs.repoRoot).toBe('.');
      expect(inputs.expectedGatewayIds).toEqual(['rest-1']);
      expect(inputs.stage).toBe('prod');
      expect(inputs.outputDir).toBe('out/specs');
      expect(inputs.includeV2).toBe(true);
    } finally {
      if (origGH !== undefined) process.env.GITHUB_WORKSPACE = origGH;
      if (origGL !== undefined) process.env.CI_PROJECT_DIR = origGL;
      if (origBB !== undefined) process.env.BITBUCKET_CLONE_DIR = origBB;
      if (origADO !== undefined) process.env.BUILD_SOURCESDIRECTORY = origADO;
    }
  });

  it('fails fast on invalid include-v2 values', () => {
    expect(() =>
      resolveInputs({
        INPUT_MODE: 'resolve-one',
        INPUT_AWS_REGION: 'us-east-1',
        INPUT_INCLUDE_V2: 'sometimes'
      })
    ).toThrow(/include-v2 must be a boolean-like value/);
  });

  it('resolves AWS region by input, AWS_REGION, then AWS_DEFAULT_REGION', () => {
    expect(resolveInputs({ INPUT_AWS_REGION: 'input-region', AWS_REGION: 'aws-region', AWS_DEFAULT_REGION: 'default-region' }).awsRegion).toBe(
      'input-region'
    );
    expect(resolveInputs({ AWS_REGION: 'aws-region', AWS_DEFAULT_REGION: 'default-region' }).awsRegion).toBe('aws-region');
    expect(resolveInputs({ AWS_DEFAULT_REGION: 'default-region' }).awsRegion).toBe('default-region');
    expect(() => resolveInputs({})).toThrow(/aws-region is required/);
  });

  it('accepts runner-form INPUT aliases and rejects conflicting alias values', () => {
    expect(resolveInputs({ INPUT_AWS_REGION: 'us-east-1', 'INPUT_DRY-RUN': 'true' } as NodeJS.ProcessEnv).dryRun).toBe(true);
    expect(() =>
      resolveInputs({
        INPUT_AWS_REGION: 'us-east-1',
        INPUT_DRY_RUN: 'false',
        'INPUT_DRY-RUN': 'true'
      } as NodeJS.ProcessEnv)
    ).toThrow(/Conflicting values for dry-run/);
    expect(() =>
      resolveInputs({ INPUT_AWS_REGION: 'us-east-1', 'INPUT_DRY-RUN': 'not-a-boolean' } as NodeJS.ProcessEnv)
    ).toThrow(/dry-run must be a boolean-like value/);
  });

  it.each([
    ['INPUT_MAX_CANDIDATES', '10items', 'max-candidates'],
    ['INPUT_MAX_CANDIDATES', '10001', 'max-candidates'],
    ['INPUT_REQUEST_TIMEOUT_MS', '1.5', 'request-timeout-ms'],
    ['INPUT_REQUEST_TIMEOUT_MS', '300001', 'request-timeout-ms'],
    ['INPUT_MAX_ATTEMPTS', '+3', 'max-attempts'],
    ['INPUT_MAX_ATTEMPTS', '101', 'max-attempts']
  ])('rejects non-full-string or out-of-bounds numeric %s=%s', (envName, value, inputName) => {
    expect(() => resolveInputs({ INPUT_AWS_REGION: 'us-east-1', [envName]: value })).toThrow(
      new RegExp(`${inputName} must be a non-negative integer between`)
    );
  });

  it('accepts bounded integer controls', () => {
    const inputs = resolveInputs({
      INPUT_AWS_REGION: 'us-east-1',
      INPUT_MAX_CANDIDATES: '10000',
      INPUT_REQUEST_TIMEOUT_MS: '300000',
      INPUT_MAX_ATTEMPTS: '100'
    });
    expect(inputs.maxCandidates).toBe(10000);
    expect(inputs.requestTimeoutMs).toBe(300000);
    expect(inputs.maxAttempts).toBe(100);
  });

  it('auto-resolves repo-root from CI workspace variables when omitted', () => {
    const inputs = resolveInputs({
      INPUT_MODE: 'resolve-one',
      INPUT_AWS_REGION: 'us-east-1',
      GITHUB_WORKSPACE: '/tmp/github-workspace'
    });

    expect(inputs.repoRoot).toBe('/tmp/github-workspace');
  });

  it('auto-resolves repo-root from Bitbucket BITBUCKET_CLONE_DIR', () => {
    const inputs = resolveInputs({
      INPUT_MODE: 'resolve-one',
      INPUT_AWS_REGION: 'us-east-1',
      BITBUCKET_CLONE_DIR: '/opt/atlassian/pipelines/agent/build'
    });

    expect(inputs.repoRoot).toBe('/opt/atlassian/pipelines/agent/build');
  });

  it('auto-resolves repo-root from Azure DevOps BUILD_SOURCESDIRECTORY', () => {
    const inputs = resolveInputs({
      INPUT_MODE: 'resolve-one',
      INPUT_AWS_REGION: 'us-east-1',
      BUILD_SOURCESDIRECTORY: '/home/vsts/work/1/s'
    });

    expect(inputs.repoRoot).toBe('/home/vsts/work/1/s');
  });

  it('explicit repo-root input overrides all CI env vars', () => {
    const inputs = resolveInputs({
      INPUT_MODE: 'resolve-one',
      INPUT_AWS_REGION: 'us-east-1',
      INPUT_REPO_ROOT: '/explicit/path',
      GITHUB_WORKSPACE: '/tmp/github-workspace',
      CI_PROJECT_DIR: '/tmp/gitlab',
      BITBUCKET_CLONE_DIR: '/tmp/bitbucket',
      BUILD_SOURCESDIRECTORY: '/tmp/azure'
    });

    expect(inputs.repoRoot).toBe('/explicit/path');
  });
});

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

describe('hardening helpers', () => {
  it('marks equal-confidence candidates as ambiguous', () => {
    const candidate = resolveServiceCandidate(
      [
        { id: 'aaaaabbbbb', name: 'payments-api', gatewayType: 'REST', tags: {} },
        { id: 'ccccdddddd', name: 'payments-api-copy', gatewayType: 'REST', tags: {} }
      ],
      {
        serviceHints: ['payments'],
        explicitGatewayIdHints: [],
        inferredGatewayIdHints: [],
        evidence: []
      }
    );

    expect(candidate?.ambiguous).toBe(true);
  });

  it('routes ambiguous candidates to manual review', () => {
    const result = chooseSource({
      fallbackServiceName: 'payments',
      candidate: {
        serviceName: 'payments',
        gatewayId: 'aaaaabbbbb',
        gatewayType: 'REST',
        confidence: 50,
        ambiguous: true,
        evidence: ['ambiguous']
      }
    });

    expect(result.status).toBe('unresolved');
    expect(result.sourceType).toBe('manual-review');
  });

  it('U1.7 cap-after-partition: 250 candidates narrow to one-candidate intersection then cap keeps 1+49 prefix', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-cap-partition-'));
    try {
      const enumerated = Array.from({ length: 249 }, (_, index) => ({ id: `rest-${String(index + 1).padStart(3, '0')}`, name: `unrelated-${index + 1}` }));
      enumerated.splice(120, 0, { id: 'rest-payments', name: 'payments-api' });
      expect(enumerated).toHaveLength(250);
      const taggedIds: string[] = [];
      const aws = createAwsClientStub({
        listRestApis: vi.fn().mockResolvedValue(enumerated),
        getRestTags: vi.fn().mockImplementation(async (id: string) => {
          taggedIds.push(id);
          return {};
        })
      });
      const { core, infos, warnings } = createCoreStub();
      const resolution = await runResolution(
        {
          mode: 'resolve-one',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'github', repoSlug: 'org/payments' },
          expectedServiceName: 'payments',
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
        aws,
        core,
        vi.fn().mockResolvedValue(undefined),
        { narrowingClients: {} }
      );

      // Narrowing saw the FULL 250 (no pre-partition cap) and demoted 249, not deleted.
      expect(infos.join(' ')).toContain('ranked 1 of 250 candidates first and demoted 249 (not deleted)');
      // Cap runs only after partitioning: warning fired, exactly 50 survive.
      expect(warnings.join(' ')).toContain('250 candidates after narrowing still exceeds limit (50). Using top 50');
      expect(taggedIds).toHaveLength(50);
      // Prefix composition: intersecting candidate first, then exactly 49 remainders in enumeration order.
      expect(taggedIds[0]).toBe('rest-payments');
      const expectedRemainder = enumerated.filter((candidate) => candidate.id !== 'rest-payments').slice(0, 49).map((candidate) => candidate.id);
      expect(taggedIds.slice(1)).toEqual(expectedRemainder);
      expect(resolution.narrowing).toEqual({ tier: 'naming-heuristic', mode: 'narrow', droppedCount: 249 });
      expect(resolution.serviceName).toBe('payments');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('U3.3 populates candidates-json with ranked candidate views for ambiguous resolve-one', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-ambiguity-'));
    try {
      const aws = createAwsClientStub({
        listRestApis: vi.fn().mockResolvedValue([
          { id: 'ccccdddddd', name: 'payments-api-copy' },
          { id: 'aaaaabbbbb', name: 'payments-api' }
        ])
      });
      const resolution = await runResolution(
        {
          mode: 'resolve-one',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'github', repoSlug: 'postman/payments' },
          expectedServiceName: 'payments',
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
        aws,
        createCoreStub().core,
        vi.fn().mockResolvedValue(undefined)
      );

      expect(resolution.status).toBe('unresolved');
      expect(resolution.sourceType).toBe('manual-review');
      expect(resolution.rankedCandidates).toBeDefined();

      const outputs = buildExecutionOutputs({ mode: 'resolve-one', discovered: [], resolution });
      expect(outputs['resolution-status']).toBe('unresolved');
      expect(outputs['source-type']).toBe('manual-review');
      const parsed = JSON.parse(outputs['candidates-json'] ?? '') as Array<Record<string, unknown>>;
      expect(parsed).toHaveLength(2);
      expect(parsed.map((candidate) => candidate.rank)).toEqual([1, 2]);
      for (const candidate of parsed) {
        expect(Object.keys(candidate).sort()).toEqual(['confidence', 'evidence', 'gatewayId', 'gatewayType', 'rank', 'serviceName']);
      }
      expect(parsed[0]?.gatewayId).toBe('aaaaabbbbb');
      expect(parsed[1]?.gatewayId).toBe('ccccdddddd');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('finds only valid OpenAPI repo specs', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-spec-test-'));
    try {
      await writeFile(path.join(tempDir, 'swagger.yml'), 'not actually yaml for openapi', 'utf8');
      await writeFile(path.join(tempDir, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'x', version: '1.0.0' } }), 'utf8');

      const result = await findExistingRepoSpec(tempDir);

      expect(result).toBe('openapi.json');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('finds common non-OpenAPI repo spec artifacts with formats', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-spec-test-'));
    try {
      await mkdir(path.join(tempDir, 'packages', 'orders'), { recursive: true });
      await writeFile(
        path.join(tempDir, 'packages', 'orders', 'asyncapi.yaml'),
        'asyncapi: "2.6.0"\ninfo:\n  title: Orders\n  version: "1.0.0"\nchannels: {}',
        'utf8'
      );

      const result = await findExistingRepoSpecTyped(tempDir);

      expect(result?.path).toBe('packages/orders/asyncapi.yaml');
      expect(result?.type).toBe('asyncapi');
      expect(result?.format).toBe('asyncapi-yaml');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('finds versioned and alternate OpenAPI spec filenames in reference docs', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-spec-test-'));
    try {
      await mkdir(path.join(tempDir, 'docs', 'reference'), { recursive: true });
      await writeFile(
        path.join(tempDir, 'docs', 'reference', 'openapi.v1.yaml'),
        'openapi: 3.0.3\ninfo:\n  title: Reference\n  version: "1.0.0"\npaths: {}',
        'utf8'
      );

      const result = await findExistingRepoSpecTyped(tempDir);

      expect(result?.path).toBe('docs/reference/openapi.v1.yaml');
      expect(result?.format).toBe('openapi-yaml');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('collects provider hints from non-deploy workflow and serverless config files', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-signal-test-'));
    try {
      await mkdir(path.join(tempDir, '.github', 'workflows'), { recursive: true });
      await writeFile(
        path.join(tempDir, '.github', 'workflows', 'release.yml'),
        'env:\n  API_URL: https://abc123def4.execute-api.us-east-1.amazonaws.com/prod\n  CUSTOM_DOMAIN: api.orders.example.test\n',
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'serverless.ts'),
        [
          'export default {',
          '  functions: { handler: { events: [{ sns: "orders-topic" }] } },',
          '  resources: { Resources: { Url: { Type: "AWS::Lambda::Url" } } }',
          '};'
        ].join('\n'),
        'utf8'
      );

      const signals = await collectRepoSignals(tempDir, 'postman/orders', undefined, []);

      expect(signals.inferredGatewayIdHints).toContain('abc123def4');
      expect(signals.customDomainHints).toContain('api.orders.example.test');
      expect(signals.providerHints).toEqual(expect.arrayContaining(['sns', 'lambda-url']));
      expect(signals.evidence).toEqual(expect.arrayContaining([
        expect.stringContaining('.github/workflows/release.yml'),
        expect.stringContaining('serverless.ts')
      ]));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('detects nested Backstage catalog API references within bounded service directories', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-catalog-test-'));
    try {
      await mkdir(path.join(tempDir, 'services', 'orders'), { recursive: true });
      await writeFile(
        path.join(tempDir, 'services', 'orders', 'catalog-info.yaml'),
        [
          'apiVersion: backstage.io/v1alpha1',
          'kind: API',
          'metadata:',
          '  name: orders-api',
          'spec:',
          '  type: openapi',
          '  definition:',
          '    $text: ./openapi.yaml'
        ].join('\n'),
        'utf8'
      );

      const apis = await detectCatalogApis(tempDir);

      expect(apis?.[0]).toEqual({
        name: 'orders-api',
        type: 'openapi',
        specPath: 'services/orders/openapi.yaml',
        specUrl: undefined,
        catalogPath: 'services/orders/catalog-info.yaml'
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('collects provider hints from deployment configs and CDK/Pulumi language variants', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-expanded-signal-test-'));
    try {
      await mkdir(path.join(tempDir, 'helm', 'orders', 'templates'), { recursive: true });
      await mkdir(path.join(tempDir, 'k8s'), { recursive: true });
      await mkdir(path.join(tempDir, 'ecs'), { recursive: true });
      await mkdir(path.join(tempDir, 'src', 'main', 'resources'), { recursive: true });
      await mkdir(path.join(tempDir, 'src', 'Orders'), { recursive: true });
      await mkdir(path.join(tempDir, 'lib'), { recursive: true });
      await writeFile(path.join(tempDir, 'cdk.json'), '{"app":"python app.py"}', 'utf8');
      await writeFile(path.join(tempDir, 'Pulumi.yaml'), 'name: orders\nruntime: yaml\n', 'utf8');
      await writeFile(
        path.join(tempDir, 'helm', 'orders', 'templates', 'ingress.yaml'),
        'kind: Ingress\nspec:\n  rules:\n    - host: api.orders.example.test\n',
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'k8s', 'ingress.yaml'),
        'apiVersion: networking.k8s.io/v1\nkind: Ingress\nspec:\n  rules:\n    - host: orders.internal.example.test\n',
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'docker-compose.yml'),
        'services:\n  api:\n    environment:\n      API_URL: https://abc123def4.execute-api.us-east-1.amazonaws.com/prod\n',
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'ecs', 'task-definition.json'),
        '{"containerDefinitions":[{"environment":[{"name":"PUBLIC_API_URL","value":"https://bcdef12345.execute-api.us-east-1.amazonaws.com/prod"}]}]}',
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'src', 'main', 'resources', 'application.yml'),
        'service:\n  callback-url: https://orders-lambda.lambda-url.us-east-1.on.aws/\n',
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'src', 'Orders', 'appsettings.json'),
        '{"ApiGateway":{"Url":"https://cdef123456.execute-api.us-east-1.amazonaws.com/prod"}}',
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'lib', 'app.py'),
        'from aws_cdk import aws_apigatewayv2 as apigatewayv2\napi = apigatewayv2.CfnApi(self, "Api", protocol_type="HTTP")\n',
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'Pulumi.yaml'),
        'name: orders\nruntime: yaml\nresources:\n  api:\n    type: aws:apigatewayv2/api:Api\n',
        'utf8'
      );

      const signals = await collectRepoSignals(tempDir, 'postman/orders', undefined, []);

      expect(signals.providerHints).toContain('api-gateway');
      expect(signals.inferredGatewayIdHints).toEqual(expect.arrayContaining(['abc123def4', 'bcdef12345', 'cdef123456']));
      expect(signals.customDomainHints).toEqual(expect.arrayContaining(['api.orders.example.test', 'orders.internal.example.test']));
      expect(signals.lambdaUrlHints).toContain('orders-lambda.lambda-url.us-east-1.on.aws');
      expect((signals.evidence as string[]).map((e) => e.replace(/\\/g, '/'))).toEqual(expect.arrayContaining([
        expect.stringContaining('helm/orders/templates/ingress.yaml'),
        expect.stringContaining('docker-compose.yml'),
        expect.stringContaining('ecs/task-definition.json'),
        expect.stringContaining('application.yml'),
        expect.stringContaining('appsettings.json'),
        expect.stringContaining('lib/app.py'),
        expect.stringContaining('Pulumi.yaml')
      ]));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('extracts only contextual gateway IDs from repo files', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-signal-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'README.md'),
        'URL https://abc123def4.execute-api.us-east-1.amazonaws.com/prod and random token qwerty1234',
        'utf8'
      );

      const signals = await collectRepoSignals(tempDir, 'postman/payments', undefined, []);

      expect(signals.inferredGatewayIdHints).toEqual(['abc123def4']);
      expect(signals.inferredGatewayIdHints).not.toContain('qwerty1234');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('parses CLI flags into action-style input env', () => {
    const parsed = parseCliArgs(['--aws-region', 'us-east-1', '--repo-root', '/tmp/repo', '--result-json', '/tmp/out.json']);

    expect(parsed.kind).toBe('run');
    if (parsed.kind !== 'run') {
      return;
    }
    expect(parsed.inputEnv.INPUT_AWS_REGION).toBe('us-east-1');
    expect(parsed.inputEnv.INPUT_REPO_ROOT).toBe('/tmp/repo');
    expect(parsed.resultJsonPath).toBe('/tmp/out.json');
  });

  it('formats CLI dotenv output for downstream jobs', () => {
    const dotenv = toDotenv({
      'resolution-json': '{"status":"resolved"}',
      'resolution-status': 'resolved',
      'source-type': 'gateway-export',
      'mapping-confidence': '100',
      'spec-path': 'discovered-specs/payments/index.yaml',
      'gateway-id': 'abc123def4',
      'service-name': 'payments',
      'services-json': '[]',
      'service-count': '0',
      'contract-origin': 'repo-asyncapi',
      'contract-metadata-path': 'discovered-specs/payments/sns-resolution-metadata.json',
      'variant-count': '2',
      'derived-openapi-path': 'discovered-specs/payments/openapi.derived.json',
      'derived-openapi-version': '3.0.3',
      'derived-openapi-completeness': 'full',
      'derived-openapi-format': 'openapi-json',
      'derived-openapi-evidence-json': '["Source artifact is already OpenAPI 3.x"]'
    });

    expect(dotenv).toContain('POSTMAN_AWS_SPEC_RESOLUTION_STATUS=');
    expect(dotenv).toContain('POSTMAN_AWS_SPEC_SERVICE_NAME=');
    expect(dotenv).toContain('POSTMAN_AWS_SPEC_CONTRACT_ORIGIN=');
    expect(dotenv).toContain('POSTMAN_AWS_SPEC_CONTRACT_METADATA_PATH=');
    expect(dotenv).toContain('POSTMAN_AWS_SPEC_VARIANT_COUNT=');
    expect(dotenv).toContain('POSTMAN_AWS_SPEC_DERIVED_OPENAPI_PATH=');
    expect(dotenv).toContain('POSTMAN_AWS_SPEC_DERIVED_OPENAPI_VERSION=');
    expect(dotenv).toContain('POSTMAN_AWS_SPEC_DERIVED_OPENAPI_COMPLETENESS=');
    expect(dotenv).toContain('POSTMAN_AWS_SPEC_DERIVED_OPENAPI_FORMAT=');
    expect(dotenv).toContain('POSTMAN_AWS_SPEC_DERIVED_OPENAPI_EVIDENCE_JSON=');
  });
});


// ---------------------------------------------------------------------------
// U2.x: narrowing-strategy output (v2.1)
// ---------------------------------------------------------------------------
describe('U2 narrowing-strategy output', () => {
  const baseResolution = {
    status: 'resolved' as const,
    sourceType: 'gateway-export' as const,
    serviceName: 'orders-api',
    confidence: 100,
    gatewayId: 'rest-1',
    gatewayType: 'REST' as const,
    evidence: ['x']
  };

  it('U2.1 applied narrowing scalar and JSON object', () => {
    const outputs = buildExecutionOutputs({
      mode: 'resolve-one',
      discovered: [],
      resolution: {
        ...baseResolution,
        narrowing: { tier: 'iac-fingerprint', mode: 'narrow', droppedCount: 3 }
      }
    });
    expect(outputs['narrowing-strategy']).toBe('iac-fingerprint');
    const parsed = JSON.parse(outputs['resolution-json'] ?? '{}') as { narrowing?: unknown };
    expect(parsed.narrowing).toEqual({ tier: 'iac-fingerprint', mode: 'narrow', droppedCount: 3 });
  });

  it('U2.2 none and absent JSON object when no tier ran', () => {
    const outputs = buildExecutionOutputs({ mode: 'resolve-one', discovered: [], resolution: baseResolution });
    expect(outputs['narrowing-strategy']).toBe('none');
    const parsed = JSON.parse(outputs['resolution-json'] ?? '{}') as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, 'narrowing')).toBe(false);
  });

  it('U2.2b discover-many always emits none and no narrowing member', () => {
    const outputs = buildExecutionOutputs({ mode: 'discover-many', discovered: [] });
    expect(outputs['narrowing-strategy']).toBe('none');
    const parsed = JSON.parse(outputs['resolution-json'] ?? '{}') as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, 'narrowing')).toBe(false);
  });

  it('U2.4 prior output fields unchanged when narrowing present', () => {
    const outputs = buildExecutionOutputs({
      mode: 'resolve-one',
      discovered: [],
      resolution: { ...baseResolution, narrowing: { tier: 'naming-heuristic', mode: 'narrow', droppedCount: 1 } }
    });
    expect(outputs['resolution-status']).toBe('resolved');
    expect(outputs['source-type']).toBe('gateway-export');
    expect(outputs['service-name']).toBe('orders-api');
    expect(outputs['gateway-id']).toBe('rest-1');
    expect(outputs['mapping-confidence']).toBe('100');
  });

  it('U2.3 toDotenv exposes POSTMAN_AWS_SPEC_NARROWING_STRATEGY', () => {
    const dotenv = toDotenv({
      'resolution-json': '{}',
      'resolution-status': 'resolved',
      'source-type': 'gateway-export',
      'mapping-confidence': '100',
      'narrowing-strategy': 'tag-prefilter'
    });
    const line = dotenv.split('\n').find((l) => l.startsWith('POSTMAN_AWS_SPEC_NARROWING_STRATEGY='));
    expect(line).toBe('POSTMAN_AWS_SPEC_NARROWING_STRATEGY="tag-prefilter"');
  });
});

// ---------------------------------------------------------------------------
// U4.4: providerProbes JSON propagation (v2.1)
// ---------------------------------------------------------------------------
describe('U4.4 providerProbes propagation', () => {
  const baseResolution = {
    status: 'resolved' as const,
    sourceType: 'gateway-export' as const,
    serviceName: 'orders-api',
    confidence: 100,
    gatewayId: 'rest-1',
    gatewayType: 'REST' as const,
    evidence: ['x']
  };

  it('U4.4 injected (unprobed) registry path emits providerProbes: [] in resolve-one', () => {
    const outputs = buildExecutionOutputs({ mode: 'resolve-one', discovered: [], resolution: baseResolution });
    const parsed = JSON.parse(outputs['resolution-json'] ?? '{}') as { providerProbes?: unknown };
    expect(parsed.providerProbes).toEqual([]);
  });

  it('U4.4 resolve-one carries typed probe results into resolution-json', () => {
    const outputs = buildExecutionOutputs({
      mode: 'resolve-one',
      discovered: [],
      resolution: {
        ...baseResolution,
        providerProbes: [
          { provider: 'api-gateway', status: 'available' },
          { provider: 'appsync', status: 'skipped', reason: 'iam' }
        ]
      }
    });
    const parsed = JSON.parse(outputs['resolution-json'] ?? '{}') as { providerProbes?: unknown };
    expect(parsed.providerProbes).toEqual([
      { provider: 'api-gateway', status: 'available' },
      { provider: 'appsync', status: 'skipped', reason: 'iam' }
    ]);
  });

  it('U4.4 discover-many carries typed probe results into resolution-json and defaults to []', () => {
    const probes = [
      { provider: 'api-gateway' as const, status: 'available' as const },
      { provider: 'appsync' as const, status: 'skipped' as const, reason: 'timeout' as const }
    ];
    const withProbes = buildExecutionOutputs({ mode: 'discover-many', discovered: [], providerProbes: probes });
    expect(JSON.parse(withProbes['resolution-json'] ?? '{}').providerProbes).toEqual(probes);
    const without = buildExecutionOutputs({ mode: 'discover-many', discovered: [] });
    expect(JSON.parse(without['resolution-json'] ?? '{}').providerProbes).toEqual([]);
  });

  it('U4.4 registry probeAvailableDetailed ordering matches registration order', async () => {
    const registry = new ProviderRegistry();
    const fake = (type: string, probe: () => Promise<boolean>): SpecProvider =>
      ({ type, probe, listCandidates: async () => [], exportSpec: async () => { throw new Error('unused'); } }) as unknown as SpecProvider;
    registry.register(fake('appsync', () => Promise.resolve(true)));
    registry.register(fake('eventbridge-schemas', () => Promise.resolve(false)));
    registry.register(fake('glue', () => Promise.reject(Object.assign(new Error('x'), { name: 'AccessDeniedException' }))));
    const { probes } = await registry.probeAvailableDetailed();
    expect(probes.map((p) => p.provider)).toEqual(['appsync', 'eventbridge-schemas', 'glue']);
    expect(probes[2]).toEqual({ provider: 'glue', status: 'skipped', reason: 'iam' });
  });
});

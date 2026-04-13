import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { DiscoveredService } from '../src/contracts.js';
import { readActionInputs, resolveInputs, runDiscovery, runAction } from '../src/index.js';
import type { AwsGatewayClient } from '../src/lib/aws/client.js';
import { parseCliArgs, toDotenv } from '../src/cli.js';
import { findExistingRepoSpec } from '../src/lib/repo/specs.js';
import { collectRepoSignals } from '../src/lib/repo/signals.js';
import { resolveServiceCandidate } from '../src/lib/resolve/service-resolver.js';
import { chooseSource } from '../src/lib/resolve/source-selector.js';
import { ProviderRegistry } from '../src/lib/providers/registry.js';
import type { SpecProvider } from '../src/lib/providers/types.js';
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
        .mockImplementation(async (id: string) => (id === 'rest-2' ? ['staging'] : ['prod'])),
      listHttpStages: vi.fn().mockResolvedValue(['$default']),
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
      exportHttpApi: vi.fn().mockResolvedValue('openapi: 3.0.1\ninfo:\n  title: http')
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

    expect(discovered).toEqual<DiscoveredService[]>([
      {
        serviceName: 'payments-core',
        specPath: 'discovered-specs/payments-core/index.yaml',
        gatewayId: 'rest-1',
        gatewayType: 'REST',
        stage: 'prod',
        providerType: 'api-gateway',
        specFormat: 'openapi-yaml'
      },
      {
        serviceName: 'checkout-service',
        specPath: 'discovered-specs/checkout-service/index.yaml',
        gatewayId: 'http-1',
        gatewayType: 'HTTP',
        stage: '$default',
        providerType: 'api-gateway',
        specFormat: 'openapi-yaml'
      }
    ]);

    expect(
      [...written.keys()].some((entry) => entry.endsWith('/discovered-specs/payments-core/index.yaml'))
    ).toBe(true);
    expect(
      [...written.keys()].some((entry) => entry.endsWith('/discovered-specs/checkout-service/index.yaml'))
    ).toBe(true);
    expect(warnings.some((message) => message.includes('simulated export failure'))).toBe(true);
    expect(result.summary.failed).toBe(1);
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
      listRestStages: vi.fn().mockResolvedValue(['prod']),
      listHttpStages: vi.fn().mockResolvedValue(['prod']),
      getRestTags: vi.fn().mockResolvedValue({}),
      getHttpTags: vi.fn().mockResolvedValue({}),
      getCallerIdentity: vi.fn().mockResolvedValue({
        accountId: '123456789012',
        arn: 'arn:aws:iam::123456789012:role/test'
      }),
      probeApiGatewayReadAccess: vi.fn().mockResolvedValue(undefined),
      exportRestApi: vi.fn().mockResolvedValue('openapi: 3.0.1'),
      exportHttpApi: vi.fn().mockResolvedValue('openapi: 3.0.1')
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
      listRestStages: vi.fn().mockResolvedValue(['prod'])
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
    origin: 'repo-asyncapi' | 'repo-json-schema' | 'ssm-content'
  ) {
    return {
      resolved: true as const,
      origin,
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
        listRestStages: vi.fn().mockResolvedValue(['prod'])
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

  it('resolves gateway-export when gateway confidence beats SNS confidence', async () => {
    await withSnsSignals(async (tempDir) => {
      const snsProvider = createSnsProviderStub({
        listCandidates: vi.fn().mockResolvedValue([createSnsTopicCandidate('orders-topic')]),
        resolveContract: vi.fn().mockResolvedValue(createResolvedSnsContract('asyncapi-yaml', 'repo-asyncapi'))
      });
      const awsClient = createAwsClientStub({
        getRestApi: vi.fn().mockResolvedValue({ id: 'rest-1', name: 'payments-api' }),
        getRestTags: vi.fn().mockResolvedValue({}),
        listRestStages: vi.fn().mockResolvedValue(['prod']),
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
        listRestStages: vi.fn().mockResolvedValue(['prod']),
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
      await writeFile(path.join(tempDir, 'openapi.yaml'), 'openapi: 3.0.0\ninfo:\n  title: Local', 'utf8');
      await writeFile(path.join(tempDir, 'template.yaml'), 'Resources:\n  Topic:\n    Type: AWS::SNS::Topic', 'utf8');
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
        vi.fn().mockResolvedValue(undefined),
        { snsProvider }
      );
      expect(result.sourceType).toBe('repo-spec');
      expect(result.specPath).toBe('openapi.yaml');
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
          listRestStages: vi.fn().mockResolvedValue(['prod']),
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

  it('registers sns in buildProviderRegistry after ssm', () => {
    const inputs = resolveInputs({
      INPUT_AWS_REGION: 'us-east-1'
    });
    const registry = buildProviderRegistry(inputs, createAwsClientStub());
    const providerTypes = registry.all().map((provider) => provider.type);

    expect(registry.get('sns')).toBeDefined();
    expect(providerTypes).toContain('sns');
    expect(providerTypes.indexOf('ssm')).toBeLessThan(providerTypes.indexOf('sns'));
  });

  it('includes SNS results in discover-many services output', async () => {
    const { core } = createCoreStub();
    const snsProvider = createDiscoverManySnsProvider({
      listCandidates: vi.fn().mockResolvedValue([createSnsTopicCandidate('orders-topic')])
    });
    const registry = new ProviderRegistry();
    registry.register(snsProvider);
    const awsClient = createAwsClientStub({
      listRestApis: vi.fn().mockResolvedValue([{ id: 'rest-1', name: 'orders-api' }]),
      listRestStages: vi.fn().mockResolvedValue(['prod']),
      exportRestApi: vi.fn().mockResolvedValue('openapi: 3.0.1')
    });

    const result = await execute(
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
    const services = JSON.parse(result.outputs['services-json'] ?? '[]') as Array<{ providerType?: string }>;
    expect(services.map((entry) => entry.providerType)).toContain('api-gateway');
    expect(services.map((entry) => entry.providerType)).toContain('sns');
  });

  it('supports discover-many dry-run for SNS without exporting', async () => {
    const { core } = createCoreStub();
    const snsProvider = createDiscoverManySnsProvider({
      listCandidates: vi.fn().mockResolvedValue([createSnsTopicCandidate('orders-topic')])
    });
    const registry = new ProviderRegistry();
    registry.register(snsProvider);

    const result = await execute(
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
  });

  it('limits SNS candidates per provider with max-candidates', async () => {
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

    const result = await execute(
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
  });
});

describe('runAction', () => {
  it('emits resolution outputs in resolve-one mode', async () => {
    const { core, outputs } = createCoreStub({
      'aws-region': 'us-east-1',
      'gateway-id': 'rest-1'
    });

    const written = new Map<string, string>();
    const awsClient = createAwsClientStub({
      getRestApi: vi.fn().mockResolvedValue({ id: 'rest-1', name: 'billing' }),
      getRestTags: vi.fn().mockResolvedValue({}),
      listRestStages: vi.fn().mockResolvedValue(['prod']),
      exportRestApi: vi.fn().mockResolvedValue('openapi: 3.0.1\ninfo:\n  title: billing')
    });

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
    expect(outputs['export-summary-json']).toContain('"attempted":0');
    expect([...written.keys()].some((entry) => entry.endsWith('/discovered-specs/billing/index.yaml'))).toBe(true);
    expect(() => JSON.parse(outputs['resolution-json'] ?? '{}')).not.toThrow();
  });

  it('downgrades export bad request errors to manual review', async () => {
    const { core, outputs } = createCoreStub({
      'aws-region': 'us-east-1',
      'gateway-id': 'http-1'
    });

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

    await runAction(core, {
      createAwsClient: () => awsClient
    });

    expect(outputs['resolution-status']).toBe('unresolved');
    expect(outputs['source-type']).toBe('manual-review');
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

  it('marks discover-many unresolved on export failures by default', async () => {
    const previousMode = process.env.INPUT_MODE;
    process.env.INPUT_MODE = 'discover-many';
    const { core, outputs } = createCoreStub({
      'aws-region': 'us-east-1'
    });
    const awsClient = createAwsClientStub({
      listRestApis: vi.fn().mockResolvedValue([{ id: 'rest-1', name: 'billing' }]),
      listRestStages: vi.fn().mockResolvedValue(['prod']),
      exportRestApi: vi.fn().mockRejectedValue(new Error('exploded'))
    });
    try {
      await runAction(core, {
        createAwsClient: () => awsClient
      });
      expect(outputs['resolution-status']).toBe('unresolved');
      expect(outputs['export-summary-json']).toContain('"failed":1');
    } finally {
      if (previousMode === undefined) {
        delete process.env.INPUT_MODE;
      } else {
        process.env.INPUT_MODE = previousMode;
      }
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
      'variant-count': '2'
    });

    expect(dotenv).toContain('POSTMAN_AWS_SPEC_RESOLUTION_STATUS=');
    expect(dotenv).toContain('POSTMAN_AWS_SPEC_SERVICE_NAME=');
    expect(dotenv).toContain('POSTMAN_AWS_SPEC_CONTRACT_ORIGIN=');
    expect(dotenv).toContain('POSTMAN_AWS_SPEC_CONTRACT_METADATA_PATH=');
    expect(dotenv).toContain('POSTMAN_AWS_SPEC_VARIANT_COUNT=');
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { AwsGatewayClient } from '../src/lib/aws/client.js';
import { ProviderRegistry } from '../src/lib/providers/registry.js';
import type { ResolvedInputs } from '../src/runtime.js';
import { execute } from '../src/runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseInputs(overrides: Partial<ResolvedInputs> = {}): ResolvedInputs {
  return {
    mode: 'resolve-one',
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
    includeV2: false,
    ...overrides
  };
}

function createCoreStub() {
  const infos: string[] = [];
  const warnings: string[] = [];
  return {
    core: {
      getInput: () => '',
      group: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      info: (msg: string) => { infos.push(msg); },
      warning: (msg: string) => { warnings.push(msg); },
      setOutput: vi.fn(),
      setFailed: vi.fn()
    },
    infos,
    warnings
  };
}

function makeAwsClient(overrides: Partial<AwsGatewayClient> = {}): AwsGatewayClient {
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

// ---------------------------------------------------------------------------
// STS error helpers
// ---------------------------------------------------------------------------

function makeAwsError(name: string, message = 'simulated'): Error {
  return Object.assign(new Error(message), { name });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPreflight STS error mappings', () => {
  it('getCallerIdentity ExpiredToken -> actionable message', async () => {
    const { core } = createCoreStub();
    const aws = makeAwsClient({
      getCallerIdentity: vi.fn().mockRejectedValue(makeAwsError('ExpiredTokenException', 'The security token included in the request is expired'))
    });

    // discover-many with no APIs found completes quickly; preflightChecks=true forces the STS call
    // The mapped error is re-thrown with the actionable message text
    const err = await execute(
      baseInputs({ mode: 'discover-many' }),
      { core, aws, writeSpecFile: async () => undefined }
    ).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/Attempted sts:GetCallerIdentity/i);
    expect(message).toMatch(/us-east-1/);
    expect(message).toMatch(/expired/i);
    expect(message).toMatch(/re-assume|rotate/i);
    expect(message).toMatch(/re-run/i);
  });

  it('getCallerIdentity AccessDenied on sts:GetCallerIdentity -> actionable message', async () => {
    const { core } = createCoreStub();
    const aws = makeAwsClient({
      getCallerIdentity: vi.fn().mockRejectedValue(makeAwsError('AccessDeniedException', 'User is not authorized to perform sts:GetCallerIdentity'))
    });

    const err = await execute(
      baseInputs({ mode: 'discover-many' }),
      { core, aws, writeSpecFile: async () => undefined }
    ).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/Attempted sts:GetCallerIdentity/i);
    expect(message).toMatch(/us-east-1/);
    expect(message).toMatch(/not authorized to perform sts:GetCallerIdentity/i);
    expect(message).toMatch(/trust policy|malformed|denied STS/i);
  });

  it('getCallerIdentity CredentialsProviderError -> actionable message', async () => {
    const { core } = createCoreStub();
    const aws = makeAwsClient({
      getCallerIdentity: vi.fn().mockRejectedValue(makeAwsError('CredentialsProviderError', 'Could not load credentials from any providers'))
    });

    const err = await execute(
      baseInputs({ mode: 'discover-many' }),
      { core, aws, writeSpecFile: async () => undefined }
    ).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/Attempted sts:GetCallerIdentity/i);
    expect(message).toMatch(/us-east-1/);
    expect(message).toMatch(/Could not load credentials from any providers/i);
    expect(message).toMatch(/provider chain|env|profile|OIDC|instance role/i);
  });

  it('getCallerIdentity unmapped STS error -> actionable generic message', async () => {
    const { core } = createCoreStub();
    const aws = makeAwsClient({
      getCallerIdentity: vi.fn().mockRejectedValue(
        makeAwsError('ThrottlingException', 'Rate exceeded for sts:GetCallerIdentity')
      )
    });

    const err = await execute(
      baseInputs({ mode: 'discover-many', awsRegion: 'eu-west-1' }),
      { core, aws, writeSpecFile: async () => undefined }
    ).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/Attempted sts:GetCallerIdentity/i);
    expect(message).toMatch(/eu-west-1/);
    expect(message).toMatch(/Rate exceeded for sts:GetCallerIdentity/i);
    expect(message).toMatch(/Verify AWS credentials|region|IAM permission/i);
    expect(message).toMatch(/re-run/i);
  });

  it('permission probe failure warns with operation, region, cause, and remediation', async () => {
    const { core, warnings } = createCoreStub();
    const aws = makeAwsClient({
      probeApiGatewayReadAccess: vi.fn().mockRejectedValue(
        makeAwsError('AccessDeniedException', 'User is not authorized to perform: apigateway:GET')
      )
    });
    const providerRegistry = new ProviderRegistry();

    await execute(
      baseInputs({ mode: 'discover-many', preflightPermissionProbe: true }),
      { core, aws, writeSpecFile: async () => undefined, providerRegistry }
    );

    const warning = warnings.find((message) => /API Gateway REST read preflight/i.test(message));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/Attempted API Gateway REST read preflight/i);
    expect(warning).toMatch(/us-east-1/);
    expect(warning).toMatch(/apigateway:GET|not authorized/i);
    expect(warning).toMatch(/REST discovery\/export may be unavailable/i);
    expect(warning).toMatch(/Grant API Gateway read permission|correct role/i);
  });

  it('preflight-off still early-returns without calling getCallerIdentity', async () => {
    const { core } = createCoreStub();
    const getCallerIdentity = vi.fn().mockResolvedValue({ accountId: '123456789012', arn: 'arn:aws:iam::123456789012:role/test' });
    const aws = makeAwsClient({ getCallerIdentity });
    // Inject an empty registry so execute does not attempt real AWS provider probing
    const providerRegistry = new ProviderRegistry();

    await execute(
      baseInputs({ preflightChecks: false, mode: 'discover-many' }),
      { core, aws, writeSpecFile: async () => undefined, providerRegistry }
    );

    expect(getCallerIdentity).not.toHaveBeenCalled();
  });
});

describe('preflight message style ban', () => {
  it('STS and permission-probe messages avoid banned shapes', async () => {
    const cases: Array<{ name: string; message: string; probe?: boolean }> = [
      { name: 'ExpiredTokenException', message: 'The security token included in the request is expired' },
      { name: 'AccessDeniedException', message: 'User is not authorized to perform sts:GetCallerIdentity' },
      { name: 'CredentialsProviderError', message: 'Could not load credentials from any providers' },
      {
        name: 'AccessDeniedException',
        message: 'User is not authorized to perform: apigateway:GET',
        probe: true
      }
    ];
    const observed: string[] = [];

    for (const testCase of cases) {
      const { core, warnings } = createCoreStub();
      if (testCase.probe) {
        const aws = makeAwsClient({
          probeApiGatewayReadAccess: vi.fn().mockRejectedValue(makeAwsError(testCase.name, testCase.message))
        });
        await execute(
          baseInputs({ mode: 'discover-many', preflightPermissionProbe: true }),
          { core, aws, writeSpecFile: async () => undefined, providerRegistry: new ProviderRegistry() }
        );
        const warning = warnings.find((entry) => /API Gateway REST read preflight/i.test(entry));
        expect(warning).toBeDefined();
        observed.push(warning!);
        continue;
      }

      const aws = makeAwsClient({
        getCallerIdentity: vi.fn().mockRejectedValue(makeAwsError(testCase.name, testCase.message))
      });
      const err = await execute(
        baseInputs({ mode: 'discover-many' }),
        { core, aws, writeSpecFile: async () => undefined }
      ).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      observed.push((err as Error).message);
    }

    for (const msg of observed) {
      expect(msg).not.toContain('Bearer ');
      expect(msg).not.toContain('x-access-token:');
      expect(msg).not.toContain('\u2014');
      expect(msg).not.toContain(' , not ');
      expect(msg).not.toContain(' - not ');
    }
  });
});

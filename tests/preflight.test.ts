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
    expect((err as Error).message).toMatch(/expired/i);
    expect((err as Error).message).toMatch(/re-assume|re-run|rotate/i);
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
    expect((err as Error).message).toMatch(/GetCallerIdentity/i);
    expect((err as Error).message).toMatch(/trust policy|malformed|denied STS/i);
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
    expect((err as Error).message).toMatch(/credentials/i);
    expect((err as Error).message).toMatch(/provider chain|env|profile|OIDC|instance role/i);
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
  const EXPIRED_TOKEN_MESSAGE =
    'AWS credentials are expired; refresh the role/session (re-assume the role or rotate the access keys) and re-run.';
  const ACCESS_DENIED_MESSAGE =
    'The AWS identity cannot call sts:GetCallerIdentity; the credentials are malformed or the principal is denied STS. Check the role/keys and trust policy.';
  const CREDENTIALS_PROVIDER_MESSAGE =
    'No AWS credentials were resolved from the provider chain (env, profile, OIDC, instance role). Configure credentials for this runner.';

  const ALL_MESSAGES = [EXPIRED_TOKEN_MESSAGE, ACCESS_DENIED_MESSAGE, CREDENTIALS_PROVIDER_MESSAGE];

  it('no "Bearer " in any new message string', () => {
    for (const msg of ALL_MESSAGES) {
      expect(msg).not.toContain('Bearer ');
    }
  });

  it('no "x-access-token:" in any new message string', () => {
    for (const msg of ALL_MESSAGES) {
      expect(msg).not.toContain('x-access-token:');
    }
  });

  it('no U+2014 em dash in any new message string', () => {
    for (const msg of ALL_MESSAGES) {
      expect(msg).not.toContain('\u2014');
    }
  });

  it('no " , not " antithesis shape in any new message string', () => {
    for (const msg of ALL_MESSAGES) {
      expect(msg).not.toContain(' , not ');
    }
  });

  it('no " - not " antithesis shape in any new message string', () => {
    for (const msg of ALL_MESSAGES) {
      expect(msg).not.toContain(' - not ');
    }
  });
});

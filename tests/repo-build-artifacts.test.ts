import { cp, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { AwsGatewayClient } from '../src/lib/aws/client.js';
import { findLocalCfnArtifactSpecs } from '../src/lib/repo/specs.js';
import { buildExecutionOutputs, runResolution, type ResolvedInputs } from '../src/runtime.js';

const EMBEDDED_OPENAPI = {
  openapi: '3.0.3',
  info: { title: 'Api', version: '1.0.0' },
  paths: {
    '/ping': {
      get: {
        operationId: 'ping',
        responses: { '200': { description: 'ok' } }
      }
    }
  }
};

function cfnTemplate(logicalId: string): string {
  return JSON.stringify({
    Resources: {
      [logicalId]: {
        Type: 'AWS::ApiGateway::RestApi',
        Properties: { Body: EMBEDDED_OPENAPI }
      }
    }
  });
}

const FIXTURES = path.join(__dirname, 'fixtures', 'build-artifacts');

function createCoreStub() {
  const warnings: string[] = [];
  return {
    core: {
      group: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      info: () => undefined,
      warning: (message: string) => {
        warnings.push(message);
      }
    },
    warnings
  };
}

function createAwsClientStub(): AwsGatewayClient {
  return {
    listRestApis: vi.fn().mockResolvedValue([]),
    listHttpApis: vi.fn().mockResolvedValue([]),
    getRestApi: vi.fn().mockResolvedValue(undefined),
    getHttpApi: vi.fn().mockResolvedValue(undefined),
    listRestStages: vi.fn().mockResolvedValue([]),
    listHttpStages: vi.fn().mockResolvedValue([]),
    getRestTags: vi.fn().mockResolvedValue({}),
    getHttpTags: vi.fn().mockResolvedValue({}),
    getDomainMappings: vi.fn().mockResolvedValue([]),
    exportRestApi: vi.fn().mockResolvedValue(''),
    exportHttpApi: vi.fn().mockResolvedValue(''),
    exportWebSocketApi: vi.fn().mockResolvedValue(''),
    getCallerIdentity: vi.fn().mockResolvedValue({ account: '', arn: '' })
  } as unknown as AwsGatewayClient;
}

function inputsFor(repoRoot: string, overrides: Partial<ResolvedInputs> = {}): ResolvedInputs {
  return {
    mode: 'resolve-one',
    awsRegion: 'us-east-1',
    repoRoot,
    repoContext: { provider: 'github', repoSlug: 'postman/orders' },
    expectedServiceName: undefined,
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
    includeV2: false,
    ...overrides
  };
}

async function withFixtureCopy<T>(fixture: string, fn: (repoRoot: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-build-artifacts-'));
  try {
    await cp(path.join(FIXTURES, fixture), tempDir, { recursive: true });
    return await fn(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe('findLocalCfnArtifactSpecs', () => {
  it('U5.1 extracts the embedded OpenAPI document from a CDK template', async () => {
    await withFixtureCopy('cdk-single', async (repoRoot) => {
      const specs = await findLocalCfnArtifactSpecs(repoRoot);
      expect(specs).toHaveLength(1);
      expect(specs[0]?.logicalId).toBe('OrdersApi');
      expect(specs[0]?.gatewayType).toBe('REST');
      expect(specs[0]?.format).toBe('openapi-json');
      expect(specs[0]?.artifactRef).toBe('cdk.out/orders.template.json#OrdersApi');
      expect(specs[0]?.content).toContain('/orders');
    });
  });

  it('U5.2 extracts DefinitionBody from the SAM build template', async () => {
    await withFixtureCopy('sam-single', async (repoRoot) => {
      const specs = await findLocalCfnArtifactSpecs(repoRoot);
      expect(specs).toHaveLength(1);
      expect(specs[0]?.logicalId).toBe('PaymentsApi');
      expect(specs[0]?.artifactRef).toBe('.aws-sam/build/template.yaml#PaymentsApi');
      expect(specs[0]?.content).toContain('/payments');
    });
  });

  it('U5.3 returns nothing and stays silent when neither artifact path exists', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-build-artifacts-empty-'));
    try {
      const specs = await findLocalCfnArtifactSpecs(tempDir);
      expect(specs).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('U5.6 does not read symlinked artifacts escaping the repo root', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'pm-outside-'));
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-symlink-'));
    try {
      await cp(path.join(FIXTURES, 'cdk-single'), outside, { recursive: true });
      await mkdir(path.join(tempDir, '.aws-sam'), { recursive: true });
      await symlink(path.join(outside, 'cdk.out'), path.join(tempDir, 'cdk.out'));
      await symlink(path.join(outside, 'cdk.out', 'orders.template.json'), path.join(tempDir, '.aws-sam', 'build'));
      const specs = await findLocalCfnArtifactSpecs(tempDir);
      expect(specs).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('runResolution local build artifacts', () => {
  it('U5.1/U5.2 resolves a single embedded artifact as cfn-embedded', async () => {
    await withFixtureCopy('cdk-single', async (repoRoot) => {
      const writes = new Map<string, string>();
      const { core } = createCoreStub();
      const resolution = await runResolution(
        inputsFor(repoRoot),
        createAwsClientStub(),
        core,
        async (outputPath, content) => {
          writes.set(outputPath, content);
        }
      );
      expect(resolution.status).toBe('resolved');
      expect(resolution.sourceType).toBe('cfn-embedded');
      expect(resolution.providerType).toBe('cloudformation');
      expect(resolution.specFormat).toBe('openapi-json');
      expect(resolution.serviceName).toBe('OrdersApi');
      expect([...writes.keys()].some((file) => file.includes('discovered-specs'))).toBe(true);
      expect([...writes.values()].some((content) => content.includes('/orders'))).toBe(true);
      expect(resolution.evidence.join(' ')).toContain('OrdersApi');
    });
  });

  it('U5.4 returns manual-review with both candidates and writes nothing when ambiguous', async () => {
    await withFixtureCopy('ambiguous', async (repoRoot) => {
      const writes = new Map<string, string>();
      const { core } = createCoreStub();
      const resolution = await runResolution(
        inputsFor(repoRoot),
        createAwsClientStub(),
        core,
        async (outputPath, content) => {
          writes.set(outputPath, content);
        }
      );
      expect(resolution.status).toBe('unresolved');
      expect(resolution.sourceType).toBe('manual-review');
      expect(resolution.rankedCandidates).toHaveLength(2);
      expect(resolution.rankedCandidates?.map((candidate) => candidate.gatewayId)).toEqual([
        '.aws-sam/build/template.yaml#PaymentsApi',
        'cdk.out/alpha.template.json#AlphaApi'
      ]);
      expect(writes.size).toBe(0);
      const outputs = buildExecutionOutputs({ mode: 'resolve-one', discovered: [], resolution });
      const parsed = JSON.parse(outputs['candidates-json'] ?? '') as Array<{ rank: number }>;
      expect(parsed.map((candidate) => candidate.rank)).toEqual([1, 2]);
    });
  });

  it('U5.5 keeps a direct repository spec ahead of build artifacts', async () => {
    await withFixtureCopy('cdk-single', async (repoRoot) => {
      await writeFile(
        path.join(repoRoot, 'openapi.yaml'),
        ['openapi: 3.0.3', 'info:', '  title: Direct', '  version: 1.0.0', 'paths: {}'].join('\n'),
        'utf8'
      );
      const { core } = createCoreStub();
      const resolution = await runResolution(inputsFor(repoRoot), createAwsClientStub(), core, async () => undefined);
      expect(resolution.sourceType).toBe('repo-spec');
      expect(resolution.specPath).toBe('openapi.yaml');
    });
  });

  it('does not resolve a single generated-stale CDK/SAM fallback as current', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-stale-single-'));
    try {
      await mkdir(path.join(tempDir, 'cdk.out'), { recursive: true });
      await writeFile(path.join(tempDir, 'cdk.json'), JSON.stringify({ app: 'node bin.js' }), 'utf8');
      await writeFile(path.join(tempDir, 'cdk.out', 'orders.template.json'), cfnTemplate('OrdersApi'), 'utf8');
      const past = new Date('2020-01-01T00:00:00Z');
      const future = new Date('2026-06-01T00:00:00Z');
      await utimes(path.join(tempDir, 'cdk.out', 'orders.template.json'), past, past);
      await utimes(path.join(tempDir, 'cdk.json'), future, future);

      const specs = await findLocalCfnArtifactSpecs(tempDir);
      expect(specs).toHaveLength(1);
      expect(specs[0]?.artifactClass).toBe('generated-stale');

      const { core } = createCoreStub();
      const resolution = await runResolution(
        inputsFor(tempDir, { dryRun: true }),
        createAwsClientStub(),
        core,
        async () => undefined
      );
      expect(resolution.sourceType).not.toBe('cfn-embedded');
      expect(resolution.status).not.toBe('resolved');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('ranks generated-fresh ahead of freshness-unknown and generated-stale with class in evidence', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-freshness-rank-'));
    try {
      // cdk.json lives under cdk.out so SAM walk-to-root stays freshness-unknown while CDK templates classify.
      await mkdir(path.join(tempDir, 'cdk.out'), { recursive: true });
      await mkdir(path.join(tempDir, '.aws-sam', 'build'), { recursive: true });
      await writeFile(path.join(tempDir, 'cdk.out', 'cdk.json'), JSON.stringify({ app: 'node bin.js' }), 'utf8');
      // Lexically first CDK path is stale; fresh must still outrank via artifactClassRank.
      await writeFile(path.join(tempDir, 'cdk.out', 'a-stale.template.json'), cfnTemplate('StaleApi'), 'utf8');
      await writeFile(path.join(tempDir, 'cdk.out', 'z-fresh.template.json'), cfnTemplate('FreshApi'), 'utf8');
      await writeFile(
        path.join(tempDir, '.aws-sam', 'build', 'template.yaml'),
        [
          'AWSTemplateFormatVersion: "2010-09-09"',
          'Resources:',
          '  UnknownApi:',
          '    Type: AWS::Serverless::Api',
          '    Properties:',
          '      StageName: prod',
          '      DefinitionBody:',
          '        openapi: 3.0.3',
          '        info:',
          '          title: Unknown',
          '          version: 1.0.0',
          '        paths:',
          '          /unknown:',
          '            get:',
          '              responses:',
          "                '200':",
          '                  description: ok'
        ].join('\n'),
        'utf8'
      );

      const past = new Date('2020-01-01T00:00:00Z');
      const mid = new Date('2024-01-01T00:00:00Z');
      const future = new Date('2026-06-01T00:00:00Z');
      await utimes(path.join(tempDir, 'cdk.out', 'cdk.json'), mid, mid);
      await utimes(path.join(tempDir, 'cdk.out', 'a-stale.template.json'), past, past);
      await utimes(path.join(tempDir, 'cdk.out', 'z-fresh.template.json'), future, future);

      const specs = await findLocalCfnArtifactSpecs(tempDir);
      expect(specs.map((spec) => spec.artifactClass)).toEqual([
        'generated-fresh',
        'freshness-unknown',
        'generated-stale'
      ]);
      expect(specs.map((spec) => spec.logicalId)).toEqual(['FreshApi', 'UnknownApi', 'StaleApi']);

      const { core } = createCoreStub();
      const resolution = await runResolution(
        inputsFor(tempDir, { dryRun: true }),
        createAwsClientStub(),
        core,
        async () => undefined
      );
      expect(resolution.status).toBe('unresolved');
      expect(resolution.sourceType).toBe('manual-review');
      expect(resolution.rankedCandidates?.map((candidate) => candidate.gatewayId)).toEqual([
        'cdk.out/z-fresh.template.json#FreshApi',
        '.aws-sam/build/template.yaml#UnknownApi',
        'cdk.out/a-stale.template.json#StaleApi'
      ]);
      expect(resolution.rankedCandidates?.[0]?.evidence?.join(' ')).toContain('generated-fresh');
      expect(resolution.rankedCandidates?.[1]?.evidence?.join(' ')).toContain('freshness-unknown');
      expect(resolution.rankedCandidates?.[2]?.evidence?.join(' ')).toContain('generated-stale');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('bounds cdk.out streaming enumeration and still ranks deterministically', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-cdk-out-bound-'));
    try {
      await mkdir(path.join(tempDir, 'cdk.out'), { recursive: true });
      // Far more directory entries than the template cap; streaming opendir must stop.
      for (let index = 0; index < 80; index += 1) {
        const pad = String(index).padStart(3, '0');
        await writeFile(path.join(tempDir, 'cdk.out', `noise-${pad}.txt`), 'x', 'utf8');
        await writeFile(
          path.join(tempDir, 'cdk.out', `stack-${pad}.template.json`),
          cfnTemplate(`Api${pad}`),
          'utf8'
        );
      }

      const specs = await findLocalCfnArtifactSpecs(tempDir);
      expect(specs.length).toBeLessThanOrEqual(40);
      expect(specs.length).toBeGreaterThan(0);
      // Deterministic lexical order among the bounded/sorted template set.
      const paths = specs.map((spec) => spec.artifactPath);
      expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps direct authored repo specs ahead of fresher generated CDK/SAM fallbacks', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-authored-wins-'));
    try {
      await mkdir(path.join(tempDir, 'cdk.out'), { recursive: true });
      await writeFile(path.join(tempDir, 'cdk.json'), JSON.stringify({ app: 'node bin.js' }), 'utf8');
      await writeFile(path.join(tempDir, 'cdk.out', 'orders.template.json'), cfnTemplate('OrdersApi'), 'utf8');
      await writeFile(
        path.join(tempDir, 'openapi.yaml'),
        ['openapi: 3.0.3', 'info:', '  title: Direct', '  version: 1.0.0', 'paths: {}'].join('\n'),
        'utf8'
      );
      const past = new Date('2020-01-01T00:00:00Z');
      const future = new Date('2026-06-01T00:00:00Z');
      await utimes(path.join(tempDir, 'cdk.json'), past, past);
      await utimes(path.join(tempDir, 'cdk.out', 'orders.template.json'), future, future);

      const { core } = createCoreStub();
      const resolution = await runResolution(
        inputsFor(tempDir, { dryRun: true }),
        createAwsClientStub(),
        core,
        async () => undefined
      );
      expect(resolution.sourceType).toBe('repo-spec');
      expect(resolution.specPath).toBe('openapi.yaml');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

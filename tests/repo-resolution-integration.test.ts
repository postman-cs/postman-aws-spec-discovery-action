import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRemoteFetchPolicy, DEFAULT_REMOTE_FETCH_POLICY } from '../src/lib/fetch/spec-fetcher.js';
import { resolveStaticIacCandidates } from '../src/lib/iac/index.js';
import { ProviderRegistry } from '../src/lib/providers/registry.js';
import { SsmProvider } from '../src/lib/providers/ssm.js';
import type { SsmSpecClient } from '../src/lib/aws/ssm-client.js';
import { collectRepoSignals } from '../src/lib/repo/signals.js';
import { inventoryRepoSpecs } from '../src/lib/repo/specs.js';
import {
  execute,
  resolveInputs,
  runResolution,
  type ResolvedInputs
} from '../src/runtime.js';
import type { AwsGatewayClient } from '../src/lib/aws/client.js';

const FIXTURES = path.join(__dirname, 'fixtures', 'repo-spec-inventory');

function createCoreStub() {
  return {
    group: async <T>(_name: string, fn: () => Promise<T>) => fn(),
    info: vi.fn(),
    warning: vi.fn()
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
    exportRestApi: vi.fn().mockResolvedValue('openapi: 3.0.1'),
    exportHttpApi: vi.fn().mockResolvedValue('openapi: 3.0.1'),
    exportWebSocketApi: vi.fn().mockResolvedValue('openapi: 3.0.3'),
    getCallerIdentity: vi.fn().mockResolvedValue({
      accountId: '123456789012',
      arn: 'arn:aws:iam::123456789012:role/test'
    }),
    probeApiGatewayReadAccess: vi.fn().mockResolvedValue(undefined)
  };
}

function baseInputs(repoRoot: string, overrides: Partial<ResolvedInputs> = {}): ResolvedInputs {
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
    dryRun: true,
    preflightChecks: false,
    preflightPermissionProbe: false,
    requestTimeoutMs: 30000,
    maxAttempts: 3,
    includeV2: true,
    remoteFetchPolicy: DEFAULT_REMOTE_FETCH_POLICY,
    ...overrides
  };
}

async function withFixtureCopy<T>(fixture: string, fn: (repoRoot: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-repo-resolution-'));
  try {
    await cp(path.join(FIXTURES, fixture), tempDir, { recursive: true });
    return await fn(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('repo resolution integration (POS-388 / POS-393)', () => {
  it('honors explicit spec-path and rejects traversal at input parse time', async () => {
    await withFixtureCopy('json-schema', async (repoRoot) => {
      const inputs = resolveInputs({
        INPUT_AWS_REGION: 'us-east-1',
        INPUT_REPO_ROOT: repoRoot,
        INPUT_SPEC_PATH: 'order.schema.json'
      });
      const result = await runResolution(inputs, createAwsClientStub(), createCoreStub(), vi.fn());
      expect(result.status).toBe('resolved');
      expect(result.sourceType).toBe('repo-spec');
      expect(result.specPath).toBe('order.schema.json');
      expect(result.specFormat).toBe('json-schema');
    });

    expect(() =>
      resolveInputs({
        INPUT_AWS_REGION: 'us-east-1',
        INPUT_REPO_ROOT: '.',
        INPUT_SPEC_PATH: '../../etc/passwd'
      })
    ).toThrow(/spec-path/);
  });

  it('resolves JSON Schema and Avro inventory candidates as repo-spec', async () => {
    await withFixtureCopy('json-schema', async (repoRoot) => {
      const result = await runResolution(baseInputs(repoRoot), createAwsClientStub(), createCoreStub(), vi.fn());
      expect(result).toMatchObject({
        status: 'resolved',
        sourceType: 'repo-spec',
        specPath: 'order.schema.json',
        specFormat: 'json-schema'
      });
    });

    await withFixtureCopy('avro', async (repoRoot) => {
      const result = await runResolution(baseInputs(repoRoot), createAwsClientStub(), createCoreStub(), vi.fn());
      expect(result).toMatchObject({
        status: 'resolved',
        sourceType: 'repo-spec',
        specPath: 'order.avsc',
        specFormat: 'avro'
      });
    });
  });

  it('resolves WSDL and MCP inventory candidates as repo-spec without byte mutation', async () => {
    await withFixtureCopy('wsdl', async (repoRoot) => {
      const writeSpecFile = vi.fn().mockResolvedValue(undefined);
      const source = await readFile(path.join(repoRoot, 'service.wsdl'), 'utf8');
      const result = await runResolution(
        baseInputs(repoRoot, { dryRun: false }),
        createAwsClientStub(),
        createCoreStub(),
        writeSpecFile
      );
      expect(result).toMatchObject({
        status: 'resolved',
        sourceType: 'repo-spec',
        specPath: 'service.wsdl',
        specFormat: 'wsdl'
      });
      // Native WSDL stays at the source path; only optional derived OpenAPI sidecars may be written.
      const nativeWrites = writeSpecFile.mock.calls.filter(
        (call) => String(call[0]).replace(/\\/g, '/').endsWith('.wsdl')
      );
      expect(nativeWrites).toHaveLength(0);
      const inventory = await inventoryRepoSpecs(repoRoot);
      expect(inventory.candidates[0]?.content).toBe(source);
    });

    await withFixtureCopy('mcp', async (repoRoot) => {
      const writeSpecFile = vi.fn().mockResolvedValue(undefined);
      const source = await readFile(path.join(repoRoot, 'mcp.json'), 'utf8');
      const result = await runResolution(
        baseInputs(repoRoot, { dryRun: false }),
        createAwsClientStub(),
        createCoreStub(),
        writeSpecFile
      );
      expect(result).toMatchObject({
        status: 'resolved',
        sourceType: 'repo-spec',
        specPath: 'mcp.json',
        specFormat: 'mcp-json'
      });
      const nativeWrites = writeSpecFile.mock.calls.filter(
        (call) => String(call[0]).replace(/\\/g, '/').endsWith('mcp.json')
          && !String(call[0]).includes('derived')
      );
      expect(nativeWrites).toHaveLength(0);
      const inventory = await inventoryRepoSpecs(repoRoot);
      expect(inventory.candidates[0]?.content).toBe(source);
    });
  });

  it('preserves exact WSDL and MCP bytes through the SSM content-bearing seam', async () => {
    const wsdl = [
      '<?xml version="1.0"?>',
      '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" name="SsmOrders">',
      '  <portType name="Orders"/>',
      '</definitions>'
    ].join('\n');
    const mcp = JSON.stringify({
      mcpServers: { orders: { command: 'npx', args: ['orders-mcp'] } }
    });

    const wsdlClient: SsmSpecClient = {
      probe: vi.fn().mockResolvedValue(true),
      listSpecParameters: vi.fn().mockResolvedValue([
        { serviceName: 'orders-soap', key: 'content', value: wsdl }
      ])
    };
    const wsdlExport = await new SsmProvider(wsdlClient).exportSpec({
      id: 'ssm/orders-soap',
      name: 'orders-soap',
      providerType: 'ssm',
      tags: {},
      evidence: [],
      meta: {}
    });
    expect(wsdlExport.format).toBe('wsdl');
    expect(wsdlExport.filename).toBe('service.wsdl');
    expect(wsdlExport.content).toBe(wsdl);

    const mcpClient: SsmSpecClient = {
      probe: vi.fn().mockResolvedValue(true),
      listSpecParameters: vi.fn().mockResolvedValue([
        { serviceName: 'orders-mcp', key: 'content', value: mcp }
      ])
    };
    const mcpExport = await new SsmProvider(mcpClient).exportSpec({
      id: 'ssm/orders-mcp',
      name: 'orders-mcp',
      providerType: 'ssm',
      tags: {},
      evidence: [],
      meta: {}
    });
    expect(mcpExport.format).toBe('mcp-json');
    expect(mcpExport.filename).toBe('mcp.json');
    expect(mcpExport.content).toBe(mcp);
  });

  it('uses aggregated Smithy and GraphQL content for composed contracts', async () => {
    await withFixtureCopy('smithy/sources', async (repoRoot) => {
      const writeSpecFile = vi.fn().mockResolvedValue(undefined);
      const result = await runResolution(
        baseInputs(repoRoot, { dryRun: false }),
        createAwsClientStub(),
        createCoreStub(),
        writeSpecFile
      );
      expect(result.status).toBe('resolved');
      expect(result.sourceType).toBe('repo-spec');
      expect(result.specFormat).toBe('smithy');
      expect(result.specPath).toBe('discovered-specs/orders/model.smithy');
      expect(result.specPath).not.toContain('smithy-build.json');
      expect(result.evidence.join('\n')).toMatch(/Smithy project closure|Included Smithy|Materialized aggregated Smithy/i);
      const nativeWrite = writeSpecFile.mock.calls.find(
        (call) => String(call[0]).replace(/\\/g, '/').endsWith('discovered-specs/orders/model.smithy')
      );
      expect(nativeWrite?.[1]).toContain('namespace example.orders');
      expect(nativeWrite?.[1]).not.toContain('"version"');
    });

    await withFixtureCopy('graphql-multi', async (repoRoot) => {
      const writeSpecFile = vi.fn().mockResolvedValue(undefined);
      const result = await runResolution(
        baseInputs(repoRoot, { dryRun: false }),
        createAwsClientStub(),
        createCoreStub(),
        writeSpecFile
      );
      expect(result.status).toBe('resolved');
      expect(result.sourceType).toBe('repo-spec');
      expect(result.specFormat).toBe('graphql-sdl');
      expect(result.specPath).toBe('discovered-specs/orders/schema.graphql');
      expect(result.evidence.join('\n')).toMatch(/GraphQL|Grouped|Materialized aggregated GraphQL/i);
      const nativeWrite = writeSpecFile.mock.calls.find(
        (call) => String(call[0]).replace(/\\/g, '/').endsWith('discovered-specs/orders/schema.graphql')
      );
      expect(nativeWrite?.[1]).toContain('type Query');
      expect(nativeWrite?.[1]).toContain('type Order');
    });
  });

  it('returns ranked manual-review on same-tier monorepo ambiguity and scopes with service-root', async () => {
    await withFixtureCopy('same-tier', async (repoRoot) => {
      const ambiguous = await runResolution(baseInputs(repoRoot), createAwsClientStub(), createCoreStub(), vi.fn());
      expect(ambiguous.status).toBe('unresolved');
      expect(ambiguous.sourceType).toBe('manual-review');
      expect(ambiguous.rankedCandidates?.length).toBeGreaterThanOrEqual(2);
    });

    await withFixtureCopy('monorepo', async (repoRoot) => {
      const unscoped = await runResolution(baseInputs(repoRoot), createAwsClientStub(), createCoreStub(), vi.fn());
      expect(unscoped.status).toBe('unresolved');
      expect(unscoped.sourceType).toBe('manual-review');
      expect(unscoped.rankedCandidates?.length).toBeGreaterThanOrEqual(2);
      expect(unscoped.rankedCandidates?.map((candidate) => candidate.gatewayId).sort()).toEqual([
        'packages/orders/openapi.yaml',
        'packages/payments/asyncapi.yaml'
      ]);

      const scoped = await runResolution(
        baseInputs(repoRoot, { serviceRoot: 'packages/payments' }),
        createAwsClientStub(),
        createCoreStub(),
        vi.fn()
      );
      expect(scoped).toMatchObject({
        status: 'resolved',
        sourceType: 'repo-spec',
        specPath: 'packages/payments/asyncapi.yaml'
      });
    });
  });

  it('treats multi-document Backstage catalogs as ambiguity instead of first-document wins', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-backstage-multi-'));
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
          '  definition: ./orders.yaml',
          '---',
          'apiVersion: backstage.io/v1alpha1',
          'kind: API',
          'metadata:',
          '  name: billing-api',
          'spec:',
          '  type: openapi',
          '  definition: ./billing.yaml'
        ].join('\n'),
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'orders.yaml'),
        'openapi: 3.0.3\ninfo:\n  title: Orders\n  version: "1.0.0"\npaths: {}\n',
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'billing.yaml'),
        'openapi: 3.0.3\ninfo:\n  title: Billing\n  version: "1.0.0"\npaths: {}\n',
        'utf8'
      );

      const result = await runResolution(baseInputs(tempDir), createAwsClientStub(), createCoreStub(), vi.fn());
      expect(result.status).toBe('unresolved');
      expect(result.sourceType).toBe('manual-review');
      expect(result.rankedCandidates?.map((candidate) => candidate.serviceName).sort()).toEqual([
        'billing-api',
        'orders-api'
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('emits deterministic repo service groups before AWS results in discover-many', async () => {
    await withFixtureCopy('monorepo', async (repoRoot) => {
      const registry = new ProviderRegistry();
      const result = await execute(baseInputs(repoRoot, { mode: 'discover-many' }), {
        core: createCoreStub(),
        aws: createAwsClientStub(),
        writeSpecFile: vi.fn(),
        providerRegistry: registry
      });

      expect(result.discovered.length).toBeGreaterThanOrEqual(2);
      expect(result.discovered.slice(0, 2).map((service) => service.specPath)).toEqual([
        'packages/orders/openapi.yaml',
        'packages/payments/asyncapi.yaml'
      ]);
      expect(result.discovered.every((service) => service.gatewayId.startsWith('repo-spec:'))).toBe(true);
    });
  });

  it('shares one aggregate fetch byte budget across multiple remote callers in one resolution', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-shared-budget-'));
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
          '  definition: https://specs.example.com/v1/orders.yaml',
          '---',
          'apiVersion: backstage.io/v1alpha1',
          'kind: API',
          'metadata:',
          '  name: billing-api',
          'spec:',
          '  type: openapi',
          '  definition: https://specs.example.com/v1/billing.yaml'
        ].join('\n'),
        'utf8'
      );

      const seenBudgets: Array<{ totalBytes: number } | undefined> = [];
      const fetchMock = vi.fn(
        async (_url: string, options?: { budget?: { totalBytes: number }; maxTotalBytes?: number; policy?: { enabled?: boolean } }) => {
          seenBudgets.push(options?.budget);
          if (options?.budget) {
            options.budget.totalBytes += 30;
          }
          return {
            content: 'openapi: 3.0.3\ninfo:\n  title: X\n  version: "1.0.0"\npaths: {}\n',
            contentType: 'application/yaml',
            finalUrl: _url
          };
        }
      );

      const result = await runResolution(
        baseInputs(tempDir, {
          remoteFetchPolicy: createRemoteFetchPolicy({
            enabled: true,
            allowlist: [{ hostname: 'specs.example.com', pathPrefix: '/v1/' }]
          })
        }),
        createAwsClientStub(),
        createCoreStub(),
        vi.fn(),
        { fetchSpecFromUrl: fetchMock as never }
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(seenBudgets[0]).toBeTruthy();
      expect(seenBudgets[1]).toBe(seenBudgets[0]);
      expect(seenBudgets[0]?.totalBytes).toBe(60);
      // Two remote catalog APIs remain ambiguity-safe.
      expect(result.status).toBe('unresolved');
      expect(result.sourceType).toBe('manual-review');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('allows and denies SSM remote URL fetches according to remoteFetchPolicy', async () => {
    const client: SsmSpecClient = {
      probe: vi.fn().mockResolvedValue(true),
      listSpecParameters: vi.fn().mockResolvedValue([
        { serviceName: 'orders', key: 'url', value: 'https://specs.example.com/v1/orders.yaml' }
      ])
    };
    const fetchMock = vi.fn(async (_url: string, options?: { policy?: { enabled?: boolean; allowlist?: unknown[] } }) => {
      if (!options?.policy?.enabled || !options.policy.allowlist?.length) {
        throw new Error('Remote spec fetch is disabled by default');
      }
      return {
        content: 'openapi: 3.0.3\ninfo:\n  title: Orders\n  version: "1.0.0"\npaths: {}\n',
        contentType: 'application/yaml',
        finalUrl: 'https://specs.example.com/v1/orders.yaml'
      };
    });

    const denied = new SsmProvider(client, {
      remoteFetchPolicy: DEFAULT_REMOTE_FETCH_POLICY,
      fetchSpecFromUrl: fetchMock
    });
    const deniedCandidates = await denied.listCandidates();
    // Fetch failure must fail closed — never become a resolved OpenAPI pointer artifact.
    await expect(denied.exportSpec(deniedCandidates[0]!)).rejects.toThrow(/SSM remote spec fetch failed|disabled by default/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const allowed = new SsmProvider(client, {
      remoteFetchPolicy: createRemoteFetchPolicy({
        enabled: true,
        allowlist: [{ hostname: 'specs.example.com', pathPrefix: '/v1/' }]
      }),
      fetchSpecFromUrl: fetchMock
    });
    const allowedCandidates = await allowed.listCandidates();
    expect(allowedCandidates[0]?.meta.url).toBe('https://specs.example.com/v1/orders.yaml');
    const allowedExport = await allowed.exportSpec(allowedCandidates[0]!);
    expect(allowedExport.filename).toBe('orders.yaml');
    expect(allowedExport.format).toBe('openapi-yaml');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('resolves GraphQL introspection JSON as repo-spec without mutating source bytes', async () => {
    await withFixtureCopy('graphql-introspection', async (repoRoot) => {
      const source = await readFile(path.join(repoRoot, 'introspection.json'), 'utf8');
      const result = await runResolution(baseInputs(repoRoot), createAwsClientStub(), createCoreStub(), vi.fn());
      expect(result).toMatchObject({
        status: 'resolved',
        sourceType: 'repo-spec',
        specPath: 'introspection.json',
        specFormat: 'graphql-introspection-json'
      });
      const inventory = await inventoryRepoSpecs(repoRoot);
      expect(inventory.candidates[0]?.content).toBe(source);
    });
  });

  it('classifies SSM content strictly: Avro, introspection, declared mismatch, and unknown fail closed', async () => {
    const avro = JSON.stringify({
      type: 'record',
      name: 'OrderEvent',
      fields: [{ name: 'id', type: 'string' }]
    });
    const introspection = JSON.stringify({
      data: { __schema: { queryType: { name: 'Query' }, types: [] } }
    });
    const unknown = JSON.stringify({ hello: 'world', count: 1 });

    const avroExport = await new SsmProvider({
      probe: vi.fn().mockResolvedValue(true),
      listSpecParameters: vi.fn().mockResolvedValue([
        { serviceName: 'orders-avro', key: 'content', value: avro },
        { serviceName: 'orders-avro', key: 'format', value: 'avro' }
      ])
    }).exportSpec({
      id: 'ssm/orders-avro',
      name: 'orders-avro',
      providerType: 'ssm',
      tags: {},
      evidence: [],
      meta: { format: 'avro' }
    });
    expect(avroExport.format).toBe('avro');
    expect(avroExport.content).toBe(avro);

    const introExport = await new SsmProvider({
      probe: vi.fn().mockResolvedValue(true),
      listSpecParameters: vi.fn().mockResolvedValue([
        { serviceName: 'orders-gql', key: 'content', value: introspection }
      ])
    }).exportSpec({
      id: 'ssm/orders-gql',
      name: 'orders-gql',
      providerType: 'ssm',
      tags: {},
      evidence: [],
      meta: {}
    });
    expect(introExport.format).toBe('graphql-introspection-json');
    expect(introExport.filename).toBe('introspection.json');
    expect(introExport.content).toBe(introspection);

    await expect(
      new SsmProvider({
        probe: vi.fn().mockResolvedValue(true),
        listSpecParameters: vi.fn().mockResolvedValue([
          { serviceName: 'mismatch', key: 'content', value: avro },
          { serviceName: 'mismatch', key: 'format', value: 'openapi-yaml' }
        ])
      }).exportSpec({
        id: 'ssm/mismatch',
        name: 'mismatch',
        providerType: 'ssm',
        tags: {},
        evidence: [],
        meta: { format: 'openapi-yaml' }
      })
    ).rejects.toThrow(/does not match declared format/i);

    await expect(
      new SsmProvider({
        probe: vi.fn().mockResolvedValue(true),
        listSpecParameters: vi.fn().mockResolvedValue([
          { serviceName: 'unknown', key: 'content', value: unknown }
        ])
      }).exportSpec({
        id: 'ssm/unknown',
        name: 'unknown',
        providerType: 'ssm',
        tags: {},
        evidence: [],
        meta: {}
      })
    ).rejects.toThrow(/could not be classified/i);
  });

  it('resolves Backstage inline OpenAPI/WSDL/MCP/introspection and $yaml local refs', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-catalog-resolve-'));
    try {
      await writeFile(
        path.join(tempDir, 'openapi.yaml'),
        'openapi: 3.0.3\ninfo:\n  title: Yaml Ref\n  version: "1.0.0"\npaths: {}\n',
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'catalog-info.yaml'),
        [
          'apiVersion: backstage.io/v1alpha1',
          'kind: API',
          'metadata:',
          '  name: yaml-ref-api',
          'spec:',
          '  type: openapi',
          '  definition:',
          '    $yaml: ./openapi.yaml'
        ].join('\n'),
        'utf8'
      );
      const yamlRef = await runResolution(baseInputs(tempDir), createAwsClientStub(), createCoreStub(), vi.fn());
      expect(yamlRef).toMatchObject({
        status: 'resolved',
        sourceType: 'repo-spec',
        specPath: 'openapi.yaml',
        specFormat: 'openapi-yaml'
      });

      const inlineDir = await mkdtemp(path.join(os.tmpdir(), 'pm-catalog-inline-resolve-'));
      try {
        const writes = new Map<string, string>();
        await writeFile(
          path.join(inlineDir, 'catalog-info.yaml'),
          [
            'apiVersion: backstage.io/v1alpha1',
            'kind: API',
            'metadata:',
            '  name: intro-inline',
            'spec:',
            '  type: graphql',
            '  definition:',
            '    __schema:',
            '      queryType:',
            '        name: Query',
            '      types: []'
          ].join('\n'),
          'utf8'
        );
        const inline = await runResolution(
          baseInputs(inlineDir, { dryRun: false }),
          createAwsClientStub(),
          createCoreStub(),
          async (outputPath, content) => {
            writes.set(outputPath.replace(/\\/g, '/'), content);
          }
        );
        expect(inline).toMatchObject({
          status: 'resolved',
          sourceType: 'repo-spec',
          specFormat: 'graphql-introspection-json'
        });
        expect([...writes.keys()].some((file) => file.endsWith('/introspection.json'))).toBe(true);
      } finally {
        await rm(inlineDir, { recursive: true, force: true });
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not resolve Backstage entities when declared type mismatches invalid native bytes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-catalog-mismatch-'));
    try {
      await writeFile(
        path.join(tempDir, 'catalog-info.yaml'),
        [
          'apiVersion: backstage.io/v1alpha1',
          'kind: API',
          'metadata:',
          '  name: fake-wsdl',
          'spec:',
          '  type: wsdl',
          '  definition: |',
          '    openapi: 3.0.3',
          '    info:',
          '      title: Fake',
          '      version: "1.0.0"',
          '    paths: {}'
        ].join('\n'),
        'utf8'
      );
      const core = createCoreStub();
      const result = await runResolution(baseInputs(tempDir), createAwsClientStub(), core, vi.fn());
      // Declared wsdl must not rescue OpenAPI bytes as WSDL (or invent a resolved WSDL contract).
      expect(result.status).toBe('unresolved');
      expect(result.specFormat).not.toBe('wsdl');
      expect(result.specFormat).not.toBe('openapi-yaml');
      expect(core.warning.mock.calls.some((call) => /could not be classified/i.test(String(call[0])))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps SSM fetch failures unresolved through provider failure in resolve-one and discover-many', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-ssm-fetch-fail-'));
    try {
      const ssmClient: SsmSpecClient = {
        probe: vi.fn().mockResolvedValue(true),
        listSpecParameters: vi.fn().mockResolvedValue([
          { serviceName: 'orders', key: 'url', value: 'https://specs.example.com/v1/orders.yaml' }
        ])
      };
      const fetchFail = vi.fn(async () => {
        throw new Error('Remote spec fetch is disabled by default');
      });
      const ssmProvider = new SsmProvider(ssmClient, {
        remoteFetchPolicy: DEFAULT_REMOTE_FETCH_POLICY,
        fetchSpecFromUrl: fetchFail
      });
      const registry = new ProviderRegistry();
      registry.register(ssmProvider);

      const resolveOne = await runResolution(
        baseInputs(tempDir),
        createAwsClientStub(),
        createCoreStub(),
        vi.fn(),
        { providers: [ssmProvider] }
      );
      // No repo spec; SSM export failure must not resolve as OpenAPI.
      expect(resolveOne.status).toBe('unresolved');
      expect(resolveOne.specFormat).not.toBe('openapi-json');
      expect(resolveOne.specPath ?? '').not.toMatch(/spec-pointer|index\.json$/);

      const discoverMany = await execute(baseInputs(tempDir, { mode: 'discover-many' }), {
        core: createCoreStub(),
        aws: createAwsClientStub(),
        writeSpecFile: vi.fn(),
        providerRegistry: registry
      });
      expect(discoverMany.discovered.every((svc) => !String(svc.specPath ?? '').endsWith('spec-pointer.json'))).toBe(true);
      expect(
        discoverMany.discovered.every(
          (svc) => !(svc.specFormat === 'openapi-json' && String(svc.specPath ?? '').includes('pointer'))
        )
      ).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('shares one lazy memoized static IaC resolution (and S3 reads) across inventory and signals', async () => {
    const iacFixtures = path.join(__dirname, 'fixtures', 'iac-static');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-static-iac-shared-'));
    try {
      await cp(path.join(iacFixtures, 'cfn-s3'), tempDir, { recursive: true });
      const openapi = JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'S3', version: '1.0.0' },
        paths: { '/s3': { get: { responses: { '200': { description: 'ok' } } } } }
      });
      const s3Client = { getObject: vi.fn().mockResolvedValue(openapi) };
      let cached: ReturnType<typeof resolveStaticIacCandidates> | undefined;
      const resolveStaticIac = () => {
        cached ??= resolveStaticIacCandidates(tempDir, { s3Client });
        return cached;
      };

      const inventory = await inventoryRepoSpecs(tempDir, { staticIac: { s3Client, resolveStaticIac } });
      const signals = await collectRepoSignals(tempDir, 'postman/orders', undefined, [], {
        staticIac: { s3Client, resolveStaticIac }
      });

      // BodyS3Location + DefinitionUri => 2 reads for one resolution; double compute would be 4.
      expect(s3Client.getObject).toHaveBeenCalledTimes(2);
      expect(inventory.candidates.some((c) => c.evidence.some((e) => /Static IaC|S3/i.test(e)))).toBe(true);
      expect(signals.evidence.length).toBeGreaterThan(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('performs static IaC / S3 object reads only once per resolve-one execution that needs inventory+signals', async () => {
    const iacFixtures = path.join(__dirname, 'fixtures', 'iac-static');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-static-iac-once-'));
    try {
      await cp(path.join(iacFixtures, 'cfn-s3'), tempDir, { recursive: true });
      const openapi = JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'S3', version: '1.0.0' },
        paths: { '/s3': { get: { responses: { '200': { description: 'ok' } } } } }
      });
      const s3Client = { getObject: vi.fn().mockResolvedValue(openapi) };

      await runResolution(
        baseInputs(tempDir, { dryRun: true }),
        createAwsClientStub(),
        createCoreStub(),
        vi.fn(),
        { staticIac: { s3Client } }
      );

      // BodyS3Location + DefinitionUri both resolve via the injected client during the
      // single lazy run-scoped static IaC computation (not duplicated across consumers).
      expect(s3Client.getObject).toHaveBeenCalledTimes(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not start static IaC / S3 work for explicit spec-path (lazy resolver unconsumed)', async () => {
    const iacFixtures = path.join(__dirname, 'fixtures', 'iac-static');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-static-iac-explicit-'));
    try {
      await cp(path.join(iacFixtures, 'cfn-s3'), tempDir, { recursive: true });
      await writeFile(
        path.join(tempDir, 'openapi.yaml'),
        ['openapi: 3.0.3', 'info:', '  title: Explicit', '  version: 1.0.0', 'paths: {}'].join('\n'),
        'utf8'
      );
      const openapi = JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'S3', version: '1.0.0' },
        paths: { '/s3': { get: { responses: { '200': { description: 'ok' } } } } }
      });
      const s3Client = { getObject: vi.fn().mockResolvedValue(openapi) };

      const result = await runResolution(
        baseInputs(tempDir, { dryRun: true, specPath: 'openapi.yaml' }),
        createAwsClientStub(),
        createCoreStub(),
        vi.fn(),
        { staticIac: { s3Client } }
      );

      expect(result.status).toBe('resolved');
      expect(result.sourceType).toBe('repo-spec');
      expect(result.specPath).toBe('openapi.yaml');
      expect(s3Client.getObject).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

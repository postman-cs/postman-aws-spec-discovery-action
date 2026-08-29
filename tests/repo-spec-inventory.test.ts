import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { groupGraphqlByServiceRoot, serviceRootFor } from '../src/lib/repo/graphql-compose.js';
import {
  findExistingRepoSpec,
  findExistingRepoSpecTyped,
  inventoryRepoSpecs
} from '../src/lib/repo/specs.js';
import { resolveSmithyProject } from '../src/lib/repo/smithy-project.js';

const FIXTURES = path.join(__dirname, 'fixtures', 'repo-spec-inventory');

async function withFixtureCopy<T>(fixture: string, fn: (repoRoot: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-repo-spec-inv-'));
  try {
    await cp(path.join(FIXTURES, fixture), tempDir, { recursive: true });
    return await fn(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe('inventoryRepoSpecs', () => {
  it('detects validated repo-local JSON Schema candidates', async () => {
    await withFixtureCopy('json-schema', async (repoRoot) => {
      const inventory = await inventoryRepoSpecs(repoRoot);
      expect(inventory.candidates).toHaveLength(1);
      expect(inventory.candidates[0]).toMatchObject({
        path: 'order.schema.json',
        type: 'json-schema',
        format: 'json-schema',
        artifactClass: 'authored',
        rank: 1
      });
      expect(inventory.candidates[0]?.content).toContain('OrderCreated');
    });
  });

  it('detects validated repo-local Avro candidates', async () => {
    await withFixtureCopy('avro', async (repoRoot) => {
      const inventory = await inventoryRepoSpecs(repoRoot);
      expect(inventory.candidates).toHaveLength(1);
      expect(inventory.candidates[0]).toMatchObject({
        path: 'order.avsc',
        type: 'avro',
        format: 'avro',
        artifactClass: 'authored',
        rank: 1
      });
      expect(inventory.candidates[0]?.content).toContain('OrderEvent');
    });
  });

  it('detects GraphQL introspection JSON before generic JSON Schema and preserves bytes', async () => {
    await withFixtureCopy('graphql-introspection', async (repoRoot) => {
      const inventory = await inventoryRepoSpecs(repoRoot);
      expect(inventory.candidates).toHaveLength(1);
      expect(inventory.candidates[0]).toMatchObject({
        path: 'introspection.json',
        type: 'graphql-introspection',
        format: 'graphql-introspection-json',
        artifactClass: 'authored',
        rank: 1
      });
      const source = await readFile(path.join(repoRoot, 'introspection.json'), 'utf8');
      expect(inventory.candidates[0]?.content).toBe(source);
      expect(inventory.candidates[0]?.content).toContain('"__schema"');
    });
  });

  it('rejects arbitrary JSON false positives for GraphQL introspection', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-gql-intro-neg-'));
    try {
      await writeFile(
        path.join(tempDir, 'introspection.json'),
        JSON.stringify({ schema: { queryType: { name: 'Query' } }, data: { hello: true } }),
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'wrapped.json'),
        JSON.stringify({ data: { __typename: 'Query' } }),
        'utf8'
      );
      const inventory = await inventoryRepoSpecs(tempDir);
      expect(inventory.candidates.filter((c) => c.type === 'graphql-introspection')).toHaveLength(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('detects validated WSDL 1.1 candidates and preserves exact bytes', async () => {
    await withFixtureCopy('wsdl', async (repoRoot) => {
      const inventory = await inventoryRepoSpecs(repoRoot);
      expect(inventory.candidates).toHaveLength(1);
      expect(inventory.candidates[0]).toMatchObject({
        path: 'service.wsdl',
        type: 'wsdl',
        format: 'wsdl',
        artifactClass: 'authored',
        rank: 1
      });
      expect(inventory.candidates[0]?.content).toContain('schemas.xmlsoap.org/wsdl');
      expect(inventory.candidates[0]?.content).toContain('OrdersService');
      const source = await readFile(path.join(repoRoot, 'service.wsdl'), 'utf8');
      expect(inventory.candidates[0]?.content).toBe(source);
    });
  });

  it('detects validated WSDL 2.0 description documents', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-wsdl20-'));
    try {
      const wsdl20 = [
        '<?xml version="1.0"?>',
        '<description xmlns="http://www.w3.org/ns/wsdl"',
        '             targetNamespace="http://example.test/v2">',
        '  <interface name="Orders"/>',
        '</description>'
      ].join('\n');
      await writeFile(path.join(tempDir, 'api.wsdl'), wsdl20, 'utf8');
      const inventory = await inventoryRepoSpecs(tempDir);
      expect(inventory.candidates).toHaveLength(1);
      expect(inventory.candidates[0]).toMatchObject({
        path: 'api.wsdl',
        type: 'wsdl',
        format: 'wsdl'
      });
      expect(inventory.candidates[0]?.content).toBe(wsdl20);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('detects validated MCP client-config and registry server.json candidates without mutation', async () => {
    await withFixtureCopy('mcp', async (repoRoot) => {
      const inventory = await inventoryRepoSpecs(repoRoot);
      expect(inventory.candidates).toHaveLength(1);
      expect(inventory.candidates[0]).toMatchObject({
        path: 'mcp.json',
        type: 'mcp',
        format: 'mcp-json',
        artifactClass: 'authored',
        rank: 1
      });
      expect(inventory.candidates[0]?.content).toContain('mcpServers');
      const source = await readFile(path.join(repoRoot, 'mcp.json'), 'utf8');
      expect(inventory.candidates[0]?.content).toBe(source);
    });

    await withFixtureCopy('mcp-registry', async (repoRoot) => {
      const inventory = await inventoryRepoSpecs(repoRoot);
      expect(inventory.candidates).toHaveLength(1);
      expect(inventory.candidates[0]).toMatchObject({
        path: 'server.json',
        type: 'mcp',
        format: 'mcp-json',
        artifactClass: 'authored',
        rank: 1
      });
      expect(inventory.candidates[0]?.content).toContain('modelcontextprotocol');
      expect(inventory.candidates[0]?.content).toContain('remotes');
    });
  });

  it('rejects arbitrary XML/JSON false positives for WSDL and MCP', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-wsdl-mcp-neg-'));
    try {
      await writeFile(
        path.join(tempDir, 'service.wsdl'),
        '<?xml version="1.0"?><root><child>not-wsdl</child></root>\n',
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'noise.xml'),
        '<?xml version="1.0"?><definitions><message name="X"/></definitions>\n',
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'mcp.json'),
        JSON.stringify({ servers: { local: { command: 'echo' } } }),
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'server.json'),
        JSON.stringify({ name: 'io.example/orders', version: '1.0.0' }),
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'config.json'),
        JSON.stringify({
          mcpServers: { local: { command: 'run' } }
        }),
        'utf8'
      );

      const inventory = await inventoryRepoSpecs(tempDir);
      expect(inventory.candidates.filter((candidate) => candidate.type === 'wsdl')).toHaveLength(0);
      expect(inventory.candidates.filter((candidate) => candidate.type === 'mcp')).toHaveLength(0);
      expect(inventory.candidates.every((candidate) => candidate.path !== 'noise.xml')).toBe(true);
      expect(inventory.candidates.every((candidate) => candidate.path !== 'config.json')).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('ranks WSDL and MCP among other families without collapsing ambiguity', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-wsdl-mcp-rank-'));
    try {
      await writeFile(
        path.join(tempDir, 'openapi.yaml'),
        'openapi: 3.0.3\ninfo:\n  title: Orders\n  version: "1.0.0"\npaths: {}\n',
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'service.wsdl'),
        [
          '<?xml version="1.0"?>',
          '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" name="Demo">',
          '  <portType name="DemoPort"/>',
          '</definitions>'
        ].join('\n'),
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'mcp.json'),
        JSON.stringify({ mcpServers: { demo: { command: 'run-demo' } } }),
        'utf8'
      );

      const inventory = await inventoryRepoSpecs(tempDir);
      expect(inventory.candidates.length).toBeGreaterThanOrEqual(3);
      expect(inventory.candidates.map((candidate) => candidate.rank)).toEqual(
        inventory.candidates.map((_, index) => index + 1)
      );
      expect(inventory.candidates.some((candidate) => candidate.format === 'wsdl')).toBe(true);
      expect(inventory.candidates.some((candidate) => candidate.format === 'mcp-json')).toBe(true);
      expect(inventory.candidates.some((candidate) => candidate.type === 'openapi')).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolves smithy-build sources into aggregated .smithy model content', async () => {
    await withFixtureCopy('smithy/sources', async (repoRoot) => {
      const inventory = await inventoryRepoSpecs(repoRoot);
      const smithy = inventory.candidates.find((candidate) => candidate.type === 'smithy');
      expect(smithy).toBeDefined();
      expect(smithy?.path).toBe('smithy-build.json');
      expect(smithy?.memberPaths).toEqual(['model/main.smithy']);
      expect(smithy?.content).toContain('namespace example.orders');
      expect(smithy?.content).not.toContain('"version"');
      expect(smithy?.projections).toEqual(['source']);
      expect(smithy?.evidence.some((line) => line.includes('Smithy project closure'))).toBe(true);
    });
  });

  it('includes smithy imports in deterministic closure order', async () => {
    await withFixtureCopy('smithy/imports', async (repoRoot) => {
      const closure = await resolveSmithyProject(repoRoot, 'smithy-build.json');
      expect(closure.errors).toEqual([]);
      expect(closure.memberPaths).toEqual(['model/service.smithy', 'shared/common.smithy']);
      expect(closure.content.indexOf('example.imports')).toBeLessThan(closure.content.indexOf('example.shared'));

      const inventory = await inventoryRepoSpecs(repoRoot);
      const smithy = inventory.candidates.find((candidate) => candidate.path === 'smithy-build.json');
      expect(smithy?.memberPaths).toEqual(['model/service.smithy', 'shared/common.smithy']);
    });
  });

  it('pulls projection imports into smithy closure without deriving from JSON config', async () => {
    await withFixtureCopy('smithy/projections', async (repoRoot) => {
      const inventory = await inventoryRepoSpecs(repoRoot);
      const smithy = inventory.candidates.find((candidate) => candidate.type === 'smithy');
      expect(smithy?.memberPaths).toEqual(['extra/addon.smithy', 'model/core.smithy']);
      expect(smithy?.projections).toEqual(['external', 'source']);
      expect(smithy?.content).toContain('ProjectionService');
      expect(smithy?.content).toContain('namespace example.projections.extra');
      expect(smithy?.content).not.toContain('"imports"');
      expect(smithy?.content).not.toContain('smithy-build');
    });
  });

  it('records missing smithy sources/imports as inventory errors without a false candidate', async () => {
    await withFixtureCopy('smithy/missing', async (repoRoot) => {
      const inventory = await inventoryRepoSpecs(repoRoot);
      expect(inventory.candidates.filter((candidate) => candidate.type === 'smithy')).toHaveLength(0);
      expect(inventory.errors.some((error) => error.code === 'missing-import')).toBe(true);
    });
  });

  it('rejects smithy import cycles through a clean error contract', async () => {
    await withFixtureCopy('smithy/cycle', async (repoRoot) => {
      const inventory = await inventoryRepoSpecs(repoRoot);
      expect(inventory.errors.some((error) => error.code === 'cycle')).toBe(true);
      expect(inventory.candidates.filter((candidate) => candidate.type === 'smithy')).toHaveLength(0);
    });
  });

  it('rejects smithy path escapes', async () => {
    await withFixtureCopy('smithy/escape', async (repoRoot) => {
      const inventory = await inventoryRepoSpecs(repoRoot);
      const escape = inventory.errors.find((error) => error.code === 'path-escape');
      expect(escape).toBeDefined();
      expect(escape?.message).toMatch(/escapes repository root/);
      expect(inventory.candidates.filter((candidate) => candidate.type === 'smithy')).toHaveLength(0);
      expect(inventory.errors.some((error) => (error.path ?? '').includes('passwd') || error.message.includes('passwd') || error.message.includes('escapes'))).toBe(true);
    });
  });

  it('rejects intermediate directory symlinks in Smithy imports', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pm-smithy-parent-symlink-'));
    try {
      const repoRoot = path.join(sandbox, 'repo');
      const outside = path.join(sandbox, 'outside');
      await mkdir(repoRoot, { recursive: true });
      await mkdir(outside, { recursive: true });
      const marker = 'namespace stolen.outside';
      await writeFile(path.join(outside, 'stolen.smithy'), `${marker}\n`, 'utf8');
      await symlink(outside, path.join(repoRoot, 'linked-models'));
      await writeFile(
        path.join(repoRoot, 'smithy-build.json'),
        JSON.stringify({ version: '1.0', imports: ['linked-models/stolen.smithy'] }),
        'utf8'
      );

      const closure = await resolveSmithyProject(repoRoot, 'smithy-build.json');
      expect(closure.errors.some((error) => error.code === 'path-escape')).toBe(true);
      expect(closure.memberPaths).toEqual([]);
      expect(closure.content).not.toContain(marker);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('rejects oversized root smithy-build.json via closure bounds without model content', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-smithy-root-bounds-'));
    try {
      const marker = 'namespace example.oversized.root';
      await writeFile(
        path.join(tempDir, 'smithy-build.json'),
        `${'x'.repeat(500)}`,
        'utf8'
      );
      await writeFile(path.join(tempDir, 'model.smithy'), `${marker}\n`, 'utf8');

      const closure = await resolveSmithyProject(tempDir, 'smithy-build.json', {
        maxFiles: 10,
        maxFileBytes: 100,
        maxCumulativeBytes: 10_000
      });

      expect(closure.errors.some((error) => error.code === 'bounds-exceeded')).toBe(true);
      expect(closure.memberPaths).toEqual([]);
      expect(closure.content).toBe('');
      expect(closure.content).not.toContain(marker);
      expect(closure.errors.every((error) => !error.message.includes('x'.repeat(50)))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects oversized nested smithy-build.json via closure bounds without model content', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-smithy-nested-bounds-'));
    try {
      const marker = 'namespace example.oversized.nested';
      await mkdir(path.join(tempDir, 'nested'), { recursive: true });
      await writeFile(
        path.join(tempDir, 'smithy-build.json'),
        JSON.stringify({ version: '1.0', imports: ['nested/smithy-build.json'] }),
        'utf8'
      );
      await writeFile(path.join(tempDir, 'nested', 'smithy-build.json'), 'y'.repeat(500), 'utf8');
      await writeFile(path.join(tempDir, 'nested', 'model.smithy'), `${marker}\n`, 'utf8');

      const closure = await resolveSmithyProject(tempDir, 'smithy-build.json', {
        maxFiles: 10,
        maxFileBytes: 100,
        maxCumulativeBytes: 10_000
      });

      expect(closure.errors.some((error) => error.code === 'bounds-exceeded')).toBe(true);
      expect(closure.memberPaths).toEqual([]);
      expect(closure.content).toBe('');
      expect(closure.content).not.toContain(marker);
      expect(closure.errors.every((error) => !error.message.includes('y'.repeat(50)))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects oversized .smithy model via opened-file size before content acceptance', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-smithy-model-bounds-'));
    try {
      const marker = 'namespace example.oversized.model';
      await writeFile(
        path.join(tempDir, 'smithy-build.json'),
        JSON.stringify({ version: '1.0', sources: ['model.smithy'] }),
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'model.smithy'),
        `${marker}\n${'z'.repeat(500)}`,
        'utf8'
      );

      const closure = await resolveSmithyProject(tempDir, 'smithy-build.json', {
        maxFiles: 10,
        maxFileBytes: 100,
        maxCumulativeBytes: 10_000
      });

      expect(closure.errors.some((error) => error.code === 'bounds-exceeded')).toBe(true);
      expect(closure.errors.some((error) => /maxFileBytes=/i.test(error.message))).toBe(true);
      expect(closure.memberPaths).toEqual([]);
      expect(closure.content).toBe('');
      expect(closure.content).not.toContain(marker);
      expect(closure.errors.every((error) => !error.message.includes(marker))).toBe(true);
      expect(closure.errors.every((error) => !error.message.includes('z'.repeat(50)))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('bounds cumulative smithy config and model bytes together', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-smithy-cumulative-bounds-'));
    try {
      const marker = 'namespace example.cumulative.bound';
      const config = JSON.stringify({ version: '1.0', sources: ['model.smithy'] });
      const model = `${marker}\n${'a'.repeat(200)}`;
      await writeFile(path.join(tempDir, 'smithy-build.json'), config, 'utf8');
      await writeFile(path.join(tempDir, 'model.smithy'), model, 'utf8');

      const configBytes = Buffer.byteLength(config, 'utf8');
      const modelBytes = Buffer.byteLength(model, 'utf8');
      expect(configBytes + modelBytes).toBeGreaterThan(configBytes + 50);

      const closure = await resolveSmithyProject(tempDir, 'smithy-build.json', {
        maxFiles: 10,
        maxFileBytes: 10_000,
        maxCumulativeBytes: configBytes + 50
      });

      expect(closure.errors.some((error) => error.code === 'bounds-exceeded')).toBe(true);
      expect(closure.memberPaths).toEqual([]);
      expect(closure.content).toBe('');
      expect(closure.content).not.toContain(marker);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('bounds smithy directory entry inspection so junk entries cannot bypass maxFiles', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-smithy-entry-bounds-'));
    try {
      const modelsDir = path.join(tempDir, 'models');
      await mkdir(modelsDir, { recursive: true });
      await writeFile(
        path.join(tempDir, 'smithy-build.json'),
        JSON.stringify({ version: '1.0', sources: ['models'] }),
        'utf8'
      );

      const maxFiles = 5;
      const junkCount = 40;
      for (let index = 0; index < junkCount; index += 1) {
        await writeFile(
          path.join(modelsDir, `noise-${String(index).padStart(2, '0')}.txt`),
          `irrelevant-${index}`,
          'utf8'
        );
      }
      const marker = 'namespace example.entry.bound';
      await writeFile(path.join(modelsDir, 'service.smithy'), `${marker}\n`, 'utf8');

      const closure = await resolveSmithyProject(tempDir, 'smithy-build.json', {
        maxFiles,
        maxFileBytes: 10_000,
        maxCumulativeBytes: 100_000
      });

      expect(closure.errors.some((error) => error.code === 'bounds-exceeded')).toBe(true);
      expect(closure.errors.some((error) => /entry inspection exceeded maxFiles=/i.test(error.message))).toBe(true);
      // Observable aggregate stays sorted; do not claim lexical subset from filesystem walk order.
      expect(closure.memberPaths).toEqual([...closure.memberPaths].sort((a, b) => a.localeCompare(b)));
      // At most one model can be accepted under this cap (config already consumed one filesRead slot).
      expect(closure.memberPaths.length).toBeLessThanOrEqual(maxFiles - 1);
      expect(closure.memberPaths.length).toBeLessThan(junkCount);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('groups multi-file GraphQL SDL by service root with deterministic concatenation', async () => {
    await withFixtureCopy('graphql-multi', async (repoRoot) => {
      const inventory = await inventoryRepoSpecs(repoRoot);
      const graphql = inventory.candidates.filter((candidate) => candidate.type === 'graphql');
      expect(graphql).toHaveLength(1);
      expect(graphql[0]?.path).toBe('graphql/schema.graphql');
      expect(graphql[0]?.serviceRoot).toBe('.');
      expect(graphql[0]?.memberPaths).toEqual(['graphql/schema.graphql', 'graphql/types.graphql']);
      expect(graphql[0]?.content).toContain('type Query');
      expect(graphql[0]?.content).toContain('type Order');
      expect(graphql[0]?.content?.indexOf('type Query') ?? -1).toBeLessThan(graphql[0]?.content?.indexOf('type Order') ?? -1);
    });
  });

  it('assigns monorepo service roots and supports scoped inventory', async () => {
    await withFixtureCopy('monorepo', async (repoRoot) => {
      const inventory = await inventoryRepoSpecs(repoRoot);
      const orders = inventory.candidates.find((candidate) => candidate.path === 'packages/orders/openapi.yaml');
      const payments = inventory.candidates.find((candidate) => candidate.path === 'packages/payments/asyncapi.yaml');
      expect(orders?.serviceRoot).toBe('packages/orders');
      expect(payments?.serviceRoot).toBe('packages/payments');
      expect(orders?.rank).toBeLessThan(payments?.rank ?? Number.POSITIVE_INFINITY);

      const scoped = await inventoryRepoSpecs(repoRoot, { serviceRoot: 'packages/payments' });
      expect(scoped.candidates.map((candidate) => candidate.path)).toEqual(['packages/payments/asyncapi.yaml']);
    });
  });

  it('returns ranked same-tier candidates instead of collapsing the inventory', async () => {
    await withFixtureCopy('same-tier', async (repoRoot) => {
      const inventory = await inventoryRepoSpecs(repoRoot);
      expect(inventory.candidates.length).toBeGreaterThanOrEqual(2);
      expect(inventory.candidates.map((candidate) => candidate.rank)).toEqual(
        inventory.candidates.map((_, index) => index + 1)
      );
      expect(new Set(inventory.candidates.map((candidate) => candidate.path)).size).toBe(inventory.candidates.length);

      const first = await findExistingRepoSpecTyped(repoRoot);
      expect(first?.path).toBe(inventory.candidates[0]?.path);
    });
  });

  it('keeps authored contracts above generated artifacts with conventional names', async () => {
    await withFixtureCopy('generated-vs-authored', async (repoRoot) => {
      const inventory = await inventoryRepoSpecs(repoRoot);
      expect(inventory.candidates.length).toBeGreaterThanOrEqual(2);
      expect(inventory.candidates[0]?.path).toBe('openapi.yaml');
      expect(inventory.candidates[0]?.artifactClass).toBe('authored');
      const generated = inventory.candidates.find((candidate) => candidate.path === 'dist/openapi.yaml');
      expect(generated?.artifactClass).toBe('generated');
      expect(generated?.rank).toBeGreaterThan(inventory.candidates[0]?.rank ?? 0);
    });
  });

  it('is deterministic across repeated scans', async () => {
    await withFixtureCopy('same-tier', async (repoRoot) => {
      const first = await inventoryRepoSpecs(repoRoot);
      const second = await inventoryRepoSpecs(repoRoot);
      expect(second.candidates.map((candidate) => ({ path: candidate.path, rank: candidate.rank, score: candidate.score })))
        .toEqual(first.candidates.map((candidate) => ({ path: candidate.path, rank: candidate.rank, score: candidate.score })));
    });
  });

  it('enforces scan bounds for depth/file/byte limits', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-repo-spec-bounds-'));
    try {
      await mkdir(path.join(tempDir, 'deep', 'a', 'b', 'c'), { recursive: true });
      for (let index = 0; index < 5; index += 1) {
        await writeFile(
          path.join(tempDir, `schema-${index}.schema.json`),
          JSON.stringify({ $id: `https://example.test/${index}`, type: 'object', properties: { id: { type: 'string' } } }),
          'utf8'
        );
      }
      await writeFile(
        path.join(tempDir, 'deep', 'a', 'b', 'c', 'nested.schema.json'),
        JSON.stringify({ $id: 'https://example.test/nested', type: 'object', properties: { id: { type: 'string' } } }),
        'utf8'
      );

      const inventory = await inventoryRepoSpecs(tempDir, {
        maxFiles: 2,
        maxDepth: 1,
        maxFileBytes: 10_000,
        maxCumulativeBytes: 10_000
      });
      expect(inventory.errors.some((error) => error.code === 'bounds-exceeded')).toBe(true);
      expect(inventory.candidates.length).toBeLessThanOrEqual(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('bounds directory entry inspection so junk entries cannot bypass maxInspectedEntries', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-repo-spec-entry-bounds-'));
    try {
      const schemasDir = path.join(tempDir, 'schemas');
      await mkdir(schemasDir, { recursive: true });

      const maxInspectedEntries = 5;
      const junkCount = 40;
      const schemaCount = 10;
      for (let index = 0; index < junkCount; index += 1) {
        await writeFile(
          path.join(schemasDir, `noise-${String(index).padStart(2, '0')}.txt`),
          `irrelevant-${index}`,
          'utf8'
        );
      }
      for (let index = 0; index < schemaCount; index += 1) {
        await writeFile(
          path.join(schemasDir, `extra-${String(index).padStart(2, '0')}.schema.json`),
          JSON.stringify({
            $id: `https://example.test/extra-${index}`,
            type: 'object',
            properties: { id: { type: 'string' } }
          }),
          'utf8'
        );
      }

      const inventory = await inventoryRepoSpecs(tempDir, {
        maxInspectedEntries,
        maxFiles: 200,
        maxDepth: 6,
        maxFileBytes: 10_000,
        maxCumulativeBytes: 100_000
      });

      expect(inventory.errors.some((error) => error.code === 'bounds-exceeded')).toBe(true);
      expect(inventory.errors.some((error) => /maxInspectedEntries=/i.test(error.message))).toBe(true);

      const schemasCandidates = inventory.candidates.filter((candidate) => candidate.path.startsWith('schemas/'));
      expect(schemasCandidates.map((candidate) => candidate.path)).toEqual(
        [...schemasCandidates.map((candidate) => candidate.path)].sort((a, b) => a.localeCompare(b))
      );
      // Only in-bound walk discoveries may be accepted; junk entries count toward the cap.
      expect(schemasCandidates.length).toBeLessThanOrEqual(maxInspectedEntries);
      expect(schemasCandidates.length).toBeLessThan(schemaCount);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves findExistingRepoSpecTyped compatibility over the inventory top candidate', async () => {
    await withFixtureCopy('json-schema', async (repoRoot) => {
      const typed = await findExistingRepoSpecTyped(repoRoot);
      const pathOnly = await findExistingRepoSpec(repoRoot);
      expect(typed?.type).toBe('json-schema');
      expect(typed?.format).toBe('json-schema');
      expect(typed?.path).toBe('order.schema.json');
      expect(pathOnly).toBe('order.schema.json');
      expect(typed?.serviceRoot).toBe('.');
      expect(typed?.artifactClass).toBe('authored');
    });
  });
});

describe('graphql-compose helpers', () => {
  it('computes monorepo service roots', () => {
    expect(serviceRootFor('packages/orders/openapi.yaml')).toBe('packages/orders');
    expect(serviceRootFor('services/billing/schema.graphql')).toBe('services/billing');
    expect(serviceRootFor('graphql/schema.graphql')).toBe('.');
  });

  it('concatenates grouped GraphQL files in lexical order', () => {
    const groups = groupGraphqlByServiceRoot([
      { path: 'graphql/types.graphql', content: 'type Order { id: ID! }' },
      { path: 'graphql/schema.graphql', content: 'type Query { order: Order }' }
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.memberPaths).toEqual(['graphql/schema.graphql', 'graphql/types.graphql']);
    expect(groups[0]?.content.indexOf('type Query')).toBeLessThan(groups[0]?.content.indexOf('type Order') ?? Number.POSITIVE_INFINITY);
  });
});

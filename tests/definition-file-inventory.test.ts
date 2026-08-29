import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { toDotenv } from '../src/cli.js';
import { actionContract, contractOutputNames } from '../src/contracts.js';
import { DEFAULT_REMOTE_FETCH_POLICY } from '../src/lib/fetch/remote-fetch-policy.js';
import {
  buildDefinitionFileInventory,
  resolveRepoDefinitionClosure,
  serializeDefinitionFileInventory,
  sha256Utf8,
  stageDefinitionExportTree
} from '../src/lib/spec/definition-file-inventory.js';
import { buildExecutionOutputs, runResolution, type ResolvedInputs } from '../src/runtime.js';
import type { AwsGatewayClient } from '../src/lib/aws/client.js';
import { inventoryRepoSpecs } from '../src/lib/repo/specs.js';

const FIXTURES = path.join(__dirname, 'fixtures', 'repo-spec-inventory');

async function withFixtureCopy<T>(fixture: string, fn: (repoRoot: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-def-inv-'));
  try {
    await cp(path.join(FIXTURES, fixture), tempDir, { recursive: true });
    return await fn(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function createAwsClientStub(): AwsGatewayClient {
  return {
    getCallerIdentity: vi.fn().mockResolvedValue({ account: '123456789012', arn: 'arn:aws:iam::123456789012:root', userId: 'AIDA' }),
    listRestApis: vi.fn().mockResolvedValue([]),
    listHttpApis: vi.fn().mockResolvedValue([]),
    getRestApi: vi.fn(),
    getHttpApi: vi.fn(),
    getRestStages: vi.fn().mockResolvedValue([]),
    getHttpStages: vi.fn().mockResolvedValue([]),
    exportRestApi: vi.fn(),
    exportHttpApi: vi.fn(),
    getDomainNames: vi.fn().mockResolvedValue([]),
    getApiMappings: vi.fn().mockResolvedValue([])
  } as unknown as AwsGatewayClient;
}

function createCoreStub() {
  return {
    group: async <T>(_name: string, fn: () => Promise<T>) => fn(),
    info: vi.fn(),
    warning: vi.fn()
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
    dryRun: false,
    preflightChecks: false,
    preflightPermissionProbe: false,
    requestTimeoutMs: 30000,
    maxAttempts: 3,
    includeV2: true,
    remoteFetchPolicy: DEFAULT_REMOTE_FETCH_POLICY,
    ...overrides
  };
}

describe('definition-file-inventory schema', () => {
  it('excludes non-definition sidecars from inventory serialization', () => {
    const root = 'discovered-specs/orders/service.proto';
    const dep = 'discovered-specs/orders/types.proto';
    const inventory = buildDefinitionFileInventory({
      root,
      format: 'protobuf',
      completeness: 'full',
      files: [
        { path: root, role: 'root', content: 'syntax = "proto3";\n' },
        { path: dep, role: 'dependency', content: 'syntax = "proto3";\n' }
      ]
    });
    const serialized = serializeDefinitionFileInventory(inventory);
    expect(serialized).toContain('"schemaVersion":1');
    expect(serialized).toContain('"completeness":"full"');
    expect(serialized).not.toContain('sns-resolution-metadata');
    expect(serialized).not.toContain('openapi.derived');
    expect(serialized).not.toContain('webhook.openapi');
    const parsed = JSON.parse(serialized) as { files: Array<{ path: string; role: string; bytes: number; sha256: string }> };
    expect(parsed.files.map((file) => file.path)).toEqual([root, dep].sort((a, b) => a.localeCompare(b)));
    expect(parsed.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256) && file.bytes > 0)).toBe(true);
    expect(parsed.files.find((file) => file.path === root)?.sha256).toBe(sha256Utf8('syntax = "proto3";\n'));
  });

  it('keeps inventory empty for single-file and non-full sets', () => {
    const single = buildDefinitionFileInventory({
      root: 'service.wsdl',
      format: 'wsdl',
      completeness: 'full',
      files: [{ path: 'service.wsdl', role: 'root', content: '<definitions/>' }]
    });
    expect(serializeDefinitionFileInventory(single)).toBe('');
    expect(
      serializeDefinitionFileInventory(
        buildDefinitionFileInventory({
          root: 'a.proto',
          format: 'protobuf',
          completeness: 'partial',
          files: [
            { path: 'a.proto', role: 'root', content: 'a' },
            { path: 'b.proto', role: 'dependency', content: 'b' }
          ]
        })
      )
    ).toBe('');
  });
});

describe('repo definition closure', () => {
  it('exports a complete sibling-import proto set and preserves exact bytes', async () => {
    await withFixtureCopy('protobuf-multi', async (repoRoot) => {
      const rootContent = await readFile(path.join(repoRoot, 'service.proto'), 'utf8');
      const typesContent = await readFile(path.join(repoRoot, 'types.proto'), 'utf8');
      const closure = await resolveRepoDefinitionClosure({
        repoRoot,
        rootRelativePath: 'service.proto',
        rootContent,
        format: 'protobuf'
      });
      expect(closure.status).toBe('multi');
      if (closure.status !== 'multi') return;
      expect(closure.members).toHaveLength(2);
      expect(closure.members.find((member) => member.role === 'root')?.content).toBe(rootContent);
      expect(closure.members.find((member) => member.relativeToBundleBase === 'types.proto')?.content).toBe(typesContent);
    });
  });

  it('exports a complete WSDL/XSD set when companions are on disk', async () => {
    await withFixtureCopy('wsdl-multi', async (repoRoot) => {
      const rootContent = await readFile(path.join(repoRoot, 'service.wsdl'), 'utf8');
      const closure = await resolveRepoDefinitionClosure({
        repoRoot,
        rootRelativePath: 'service.wsdl',
        rootContent,
        format: 'wsdl'
      });
      expect(closure.status).toBe('multi');
      if (closure.status !== 'multi') return;
      expect(closure.members.map((member) => member.relativeToBundleBase).sort()).toEqual(['service.wsdl', 'types.xsd']);
    });
  });

  it('keeps missing WSDL imports partial without inventing bytes', async () => {
    await withFixtureCopy('wsdl-partial', async (repoRoot) => {
      const rootContent = await readFile(path.join(repoRoot, 'service.wsdl'), 'utf8');
      const closure = await resolveRepoDefinitionClosure({
        repoRoot,
        rootRelativePath: 'service.wsdl',
        rootContent,
        format: 'wsdl'
      });
      expect(closure.status).toBe('partial');
      if (closure.status !== 'partial') return;
      expect(closure.missingRefs).toContain('missing-types.xsd');
    });
  });

  it('rejects an escaping dependency symlink and keeps the closure partial without inventing members', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pm-def-symlink-escape-'));
    try {
      const repoRoot = path.join(sandbox, 'repo');
      const outside = path.join(sandbox, 'outside');
      await mkdir(repoRoot, { recursive: true });
      await mkdir(outside, { recursive: true });
      const secretBytes = 'syntax = "proto3";\n// outside secret\n';
      await writeFile(path.join(outside, 'secret.proto'), secretBytes, 'utf8');
      const rootContent = 'syntax = "proto3";\nimport "types.proto";\nservice Orders {}\n';
      await writeFile(path.join(repoRoot, 'service.proto'), rootContent, 'utf8');
      // In-root dependency path that lexically stays under repoRoot but points outside.
      await symlink(path.join(outside, 'secret.proto'), path.join(repoRoot, 'types.proto'));

      const closure = await resolveRepoDefinitionClosure({
        repoRoot,
        rootRelativePath: 'service.proto',
        rootContent,
        format: 'protobuf'
      });
      expect(closure.status).toBe('partial');
      if (closure.status !== 'partial') return;
      expect(closure.missingRefs).toContain('types.proto');
      expect(closure.rootContent).toBe(rootContent);
      expect(JSON.stringify(closure)).not.toContain(secretBytes);
      expect(JSON.stringify(closure)).not.toContain('outside secret');
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('rejects an in-root dependency symlink so it never becomes an inventoried member', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pm-def-symlink-inroot-'));
    try {
      const repoRoot = path.join(sandbox, 'repo');
      await mkdir(repoRoot, { recursive: true });
      const realDep = 'syntax = "proto3";\nmessage Order {}\n';
      await writeFile(path.join(repoRoot, 'real-types.proto'), realDep, 'utf8');
      const rootContent = 'syntax = "proto3";\nimport "types.proto";\nservice Orders {}\n';
      await writeFile(path.join(repoRoot, 'service.proto'), rootContent, 'utf8');
      await symlink(path.join(repoRoot, 'real-types.proto'), path.join(repoRoot, 'types.proto'));

      const closure = await resolveRepoDefinitionClosure({
        repoRoot,
        rootRelativePath: 'service.proto',
        rootContent,
        format: 'protobuf'
      });
      expect(closure.status).toBe('partial');
      if (closure.status !== 'partial') return;
      expect(closure.missingRefs).toContain('types.proto');
      expect(closure.rootContent).toBe(rootContent);
      // Symlink target bytes must not be inventoried as an authoritative member.
      expect(JSON.stringify(closure)).not.toContain('message Order');
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('rejects an in-root parent-directory symlink on a dependency path without materializing target bytes', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pm-def-symlink-parent-dep-'));
    try {
      const repoRoot = path.join(sandbox, 'repo');
      await mkdir(path.join(repoRoot, 'real-deps'), { recursive: true });
      const realDep = 'syntax = "proto3";\nmessage OrderViaParentLink {}\n';
      await writeFile(path.join(repoRoot, 'real-deps', 'types.proto'), realDep, 'utf8');
      await symlink(path.join(repoRoot, 'real-deps'), path.join(repoRoot, 'deps'));
      const rootContent = 'syntax = "proto3";\nimport "deps/types.proto";\nservice Orders {}\n';
      await writeFile(path.join(repoRoot, 'service.proto'), rootContent, 'utf8');

      const closure = await resolveRepoDefinitionClosure({
        repoRoot,
        rootRelativePath: 'service.proto',
        rootContent,
        format: 'protobuf'
      });
      expect(closure.status).toBe('partial');
      if (closure.status !== 'partial') return;
      expect(closure.missingRefs).toContain('deps/types.proto');
      expect(closure.rootContent).toBe(rootContent);
      expect(JSON.stringify(closure)).not.toContain('OrderViaParentLink');
      expect(JSON.stringify(closure)).not.toContain(realDep);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('resolves regular nested dependency directories without symlink components', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pm-def-nested-ok-'));
    try {
      const repoRoot = path.join(sandbox, 'repo');
      await mkdir(path.join(repoRoot, 'deps'), { recursive: true });
      const realDep = 'syntax = "proto3";\nmessage OrderNested {}\n';
      await writeFile(path.join(repoRoot, 'deps', 'types.proto'), realDep, 'utf8');
      const rootContent = 'syntax = "proto3";\nimport "deps/types.proto";\nservice Orders {}\n';
      await writeFile(path.join(repoRoot, 'service.proto'), rootContent, 'utf8');

      const closure = await resolveRepoDefinitionClosure({
        repoRoot,
        rootRelativePath: 'service.proto',
        rootContent,
        format: 'protobuf'
      });
      expect(closure.status).toBe('multi');
      if (closure.status !== 'multi') return;
      expect(closure.members.map((member) => member.relativeToBundleBase).sort()).toEqual([
        'deps/types.proto',
        'service.proto'
      ]);
      expect(closure.members.find((member) => member.role === 'dependency')?.content).toBe(realDep);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('resolves a wide one-hop closure with >20 siblings without false depth failure', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pm-def-wide-shallow-'));
    try {
      const repoRoot = path.join(sandbox, 'repo');
      await mkdir(repoRoot, { recursive: true });
      const siblingCount = 21;
      const siblingNames = Array.from({ length: siblingCount }, (_, index) => `sib${index + 1}.proto`);
      const imports = siblingNames.map((name) => `import "${name}";`).join('\n');
      const rootContent = `syntax = "proto3";\n${imports}\nservice Orders {}\n`;
      await writeFile(path.join(repoRoot, 'service.proto'), rootContent, 'utf8');
      for (const name of siblingNames) {
        await writeFile(path.join(repoRoot, name), `syntax = "proto3";\n// ${name}\n`, 'utf8');
      }

      const closure = await resolveRepoDefinitionClosure({
        repoRoot,
        rootRelativePath: 'service.proto',
        rootContent,
        format: 'protobuf'
      });
      expect(closure.status).toBe('multi');
      if (closure.status !== 'multi') return;
      expect(closure.completeness).toBe('full');
      expect(closure.members).toHaveLength(1 + siblingCount);
      expect(1 + siblingCount).toBeLessThanOrEqual(101);
      expect(closure.evidence.join(' ')).not.toMatch(/depth/i);
      expect(closure.members.map((member) => member.relativeToBundleBase).sort()).toEqual(
        ['service.proto', ...siblingNames].sort((left, right) => left.localeCompare(right))
      );

      const inventory = buildDefinitionFileInventory({
        root: 'service.proto',
        format: 'protobuf',
        completeness: 'full',
        files: closure.members.map((member) => ({
          path: member.relativeToBundleBase,
          role: member.role,
          content: member.content
        }))
      });
      expect(inventory.completeness).toBe('full');
      expect(inventory.files).toHaveLength(1 + siblingCount);
      expect(serializeDefinitionFileInventory(inventory)).toContain('"completeness":"full"');
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('keeps a true depth-21 import chain partial with ref-depth evidence', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pm-def-depth-chain-'));
    try {
      const repoRoot = path.join(sandbox, 'repo');
      await mkdir(repoRoot, { recursive: true });
      // Root (depth 0) -> d1 -> d2 -> ... -> d21 (graph depth 21 exceeds MAX_DEFINITION_DEPTH=20).
      const chainLength = 21;
      const rootContent = 'syntax = "proto3";\nimport "d1.proto";\nservice Orders {}\n';
      await writeFile(path.join(repoRoot, 'service.proto'), rootContent, 'utf8');
      for (let depth = 1; depth <= chainLength; depth += 1) {
        const name = `d${depth}.proto`;
        const next = depth < chainLength ? `import "d${depth + 1}.proto";\n` : '';
        await writeFile(path.join(repoRoot, name), `syntax = "proto3";\n${next}// depth ${depth}\n`, 'utf8');
      }

      const closure = await resolveRepoDefinitionClosure({
        repoRoot,
        rootRelativePath: 'service.proto',
        rootContent,
        format: 'protobuf'
      });
      expect(closure.status).toBe('partial');
      if (closure.status !== 'partial') return;
      expect(closure.missingRefs).toContain('<ref-depth-exceeded>');
      expect(closure.evidence.some((entry) => /depth 20/i.test(entry))).toBe(true);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

describe('staging and GC', () => {
  it('rejects a symlinked output directory before staging any files', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pm-stage-symlink-'));
    try {
      const repoRoot = path.join(sandbox, 'repo');
      const outside = path.join(sandbox, 'outside');
      await mkdir(repoRoot, { recursive: true });
      await mkdir(outside, { recursive: true });
      await symlink(outside, path.join(repoRoot, 'discovered-specs'));
      const write = vi.fn(async (absolutePath: string, content: string) => {
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, content, 'utf8');
      });

      await expect(
        stageDefinitionExportTree({
          repoRoot,
          serviceDirRelative: 'discovered-specs/orders',
          members: [
            {
              path: 'discovered-specs/orders/service.proto',
              role: 'root',
              content: 'syntax = "proto3";\n'
            },
            {
              path: 'discovered-specs/orders/types.proto',
              role: 'dependency',
              content: 'syntax = "proto3";\n'
            }
          ],
          writeFile: write
        })
      ).rejects.toThrow(/must not traverse symbolic links/);
      expect(write).not.toHaveBeenCalled();
      await expect(readFile(path.join(outside, 'orders', 'service.proto'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('staging failure preserves prior tree', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-stage-fail-'));
    try {
      const serviceDir = 'discovered-specs/orders';
      const absoluteService = path.join(tempDir, serviceDir);
      await mkdir(absoluteService, { recursive: true });
      const priorRoot = 'prior-root-bytes';
      const priorSidecar = '{"keep":true}';
      await writeFile(path.join(absoluteService, 'service.proto'), priorRoot, 'utf8');
      await writeFile(path.join(absoluteService, 'openapi.derived.json'), priorSidecar, 'utf8');

      let writes = 0;
      await expect(
        stageDefinitionExportTree({
          repoRoot: tempDir,
          serviceDirRelative: serviceDir,
          members: [
            { path: `${serviceDir}/service.proto`, role: 'root', content: 'syntax = "proto3"; // root\n' },
            { path: `${serviceDir}/types.proto`, role: 'dependency', content: 'syntax = "proto3"; // types\n' },
            { path: `${serviceDir}/extra.proto`, role: 'dependency', content: 'syntax = "proto3"; // extra\n' }
          ],
          writeFile: async (absolutePath, content) => {
            writes += 1;
            if (writes === 2) {
              throw new Error('injected staging failure on member 2 of 3');
            }
            await mkdir(path.dirname(absolutePath), { recursive: true });
            await writeFile(absolutePath, content, 'utf8');
          }
        })
      ).rejects.toThrow(/injected staging failure/);

      expect(await readFile(path.join(absoluteService, 'service.proto'), 'utf8')).toBe(priorRoot);
      expect(await readFile(path.join(absoluteService, 'openapi.derived.json'), 'utf8')).toBe(priorSidecar);
      await expect(readFile(path.join(absoluteService, 'types.proto'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('removes stale owned definition members while preserving non-definition sidecars', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-stage-gc-'));
    try {
      const serviceDir = 'discovered-specs/orders';
      const absoluteService = path.join(tempDir, serviceDir);
      await mkdir(absoluteService, { recursive: true });
      await writeFile(path.join(absoluteService, 'service.proto'), 'old-root', 'utf8');
      await writeFile(path.join(absoluteService, 'stale.proto'), 'stale-member', 'utf8');
      await writeFile(path.join(absoluteService, 'sns-resolution-metadata.json'), '{"origin":"sns"}', 'utf8');

      await stageDefinitionExportTree({
        repoRoot: tempDir,
        serviceDirRelative: serviceDir,
        members: [
          { path: `${serviceDir}/service.proto`, role: 'root', content: 'syntax = "proto3";\nservice Orders {}\n' },
          { path: `${serviceDir}/types.proto`, role: 'dependency', content: 'syntax = "proto3";\nmessage Order {}\n' }
        ],
        sidecars: [{ filename: 'openapi.derived.json', content: '{"openapi":"3.0.3"}\n' }]
      });

      expect(await readFile(path.join(absoluteService, 'service.proto'), 'utf8')).toContain('service Orders');
      expect(await readFile(path.join(absoluteService, 'types.proto'), 'utf8')).toContain('message Order');
      expect(await readFile(path.join(absoluteService, 'sns-resolution-metadata.json'), 'utf8')).toBe('{"origin":"sns"}');
      expect(await readFile(path.join(absoluteService, 'openapi.derived.json'), 'utf8')).toContain('openapi');
      await expect(readFile(path.join(absoluteService, 'stale.proto'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('output/CLI parity for spec-files-json', () => {
  it('does not materialize a repo aggregate through a symlinked output directory', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pm-native-output-symlink-'));
    try {
      const repoRoot = path.join(sandbox, 'repo');
      const outside = path.join(sandbox, 'outside');
      await cp(path.join(FIXTURES, 'smithy', 'sources'), repoRoot, { recursive: true });
      await mkdir(outside, { recursive: true });
      await symlink(outside, path.join(repoRoot, 'discovered-specs'));
      const writeSpecFile = vi.fn(async (outputPath: string, content: string) => {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, content, 'utf8');
      });

      const result = await runResolution(
        baseInputs(repoRoot),
        createAwsClientStub(),
        createCoreStub(),
        writeSpecFile
      );

      expect(result.status).toBe('unresolved');
      expect(writeSpecFile).not.toHaveBeenCalled();
      await expect(readFile(path.join(outside, 'orders', 'model.smithy'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('inserts spec-files-json immediately after spec-path in the action contract', () => {
    const names = contractOutputNames;
    const specPathIndex = names.indexOf('spec-path');
    expect(specPathIndex).toBeGreaterThanOrEqual(0);
    expect(names[specPathIndex + 1]).toBe('spec-files-json');
    expect(actionContract.outputs['spec-files-json']?.description).toMatch(/schemaVersion 1/);
  });

  it('emits POSTMAN_AWS_SPEC_FILES_JSON beside POSTMAN_AWS_SPEC_PATH', () => {
    const inventory = serializeDefinitionFileInventory(
      buildDefinitionFileInventory({
        root: 'discovered-specs/orders/service.proto',
        format: 'protobuf',
        completeness: 'full',
        files: [
          { path: 'discovered-specs/orders/service.proto', role: 'root', content: 'root' },
          { path: 'discovered-specs/orders/types.proto', role: 'dependency', content: 'dep' }
        ]
      })
    );
    const dotenv = toDotenv({
      'resolution-json': '{}',
      'resolution-status': 'resolved',
      'source-type': 'repo-spec',
      'mapping-confidence': '100',
      'spec-path': 'discovered-specs/orders/service.proto',
      'spec-files-json': inventory,
      'gateway-id': '',
      'service-name': 'orders'
    });
    const pathLine = dotenv.split('\n').findIndex((line) => line.startsWith('POSTMAN_AWS_SPEC_PATH='));
    const filesLine = dotenv.split('\n').findIndex((line) => line.startsWith('POSTMAN_AWS_SPEC_FILES_JSON='));
    expect(pathLine).toBeGreaterThanOrEqual(0);
    expect(filesLine).toBe(pathLine + 1);
    expect(dotenv).toContain(`POSTMAN_AWS_SPEC_FILES_JSON=${JSON.stringify(inventory)}`);
  });

  it('keeps discover-many and unresolved top-level inventory blank', () => {
    const many = buildExecutionOutputs({
      mode: 'discover-many',
      discovered: [
        {
          serviceName: 'orders',
          specPath: 'discovered-specs/orders/service.proto',
          gatewayId: 'x',
          gatewayType: 'REST',
          stage: ''
        }
      ],
      exportSummary: { attempted: 1, exported: 1, failed: 0, skipped: 0 }
    });
    expect(many['spec-files-json']).toBe('');
    expect(many['spec-path']).toBe('');

    const unresolved = buildExecutionOutputs({
      mode: 'resolve-one',
      discovered: [],
      resolution: {
        status: 'unresolved',
        sourceType: 'manual-review',
        serviceName: 'orders',
        confidence: 0,
        specPath: 'should-blank',
        specFilesJson: '{"schemaVersion":1}',
        evidence: ['incomplete']
      }
    });
    expect(unresolved['spec-path']).toBe('');
    expect(unresolved['spec-files-json']).toBe('');
  });
});

describe('resolve-one multi-file definition inventory', () => {
  it('resolves complete WSDL/protobuf sets with inventory and no byte mutation', async () => {
    await withFixtureCopy('protobuf-multi', async (repoRoot) => {
      const rootSource = await readFile(path.join(repoRoot, 'service.proto'), 'utf8');
      const typesSource = await readFile(path.join(repoRoot, 'types.proto'), 'utf8');
      // Companion .proto files are also inventory candidates; pin the root explicitly.
      const result = await runResolution(
        baseInputs(repoRoot, { specPath: 'service.proto' }),
        createAwsClientStub(),
        createCoreStub(),
        async (outputPath, content) => {
          await mkdir(path.dirname(outputPath), { recursive: true });
          await writeFile(outputPath, content, 'utf8');
        }
      );
      expect(result.status).toBe('resolved');
      expect(result.specFormat).toBe('protobuf');
      expect((result.specPath ?? '').replace(/\\/g, '/')).toBe('discovered-specs/orders/service.proto');
      expect(result.specFilesJson).toBeTruthy();
      const inventory = JSON.parse(result.specFilesJson ?? '{}') as {
        root: string;
        files: Array<{ path: string; role: string; bytes: number; sha256: string }>;
      };
      expect(inventory.root).toBe(result.specPath);
      expect(inventory.files).toHaveLength(2);
      const writtenRoot = await readFile(path.join(repoRoot, 'discovered-specs/orders/service.proto'), 'utf8');
      const writtenTypes = await readFile(path.join(repoRoot, 'discovered-specs/orders/types.proto'), 'utf8');
      expect(writtenRoot).toBe(rootSource);
      expect(writtenTypes).toBe(typesSource);
      for (const file of inventory.files) {
        const absolute = path.join(repoRoot, file.path);
        const bytes = await readFile(absolute);
        expect(file.bytes).toBe(bytes.byteLength);
        expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      }
      const outputs = buildExecutionOutputs({ mode: 'resolve-one', discovered: [], resolution: result });
      expect(outputs['spec-files-json']).toBe(result.specFilesJson);
    });

    await withFixtureCopy('wsdl-multi', async (repoRoot) => {
      const result = await runResolution(
        baseInputs(repoRoot),
        createAwsClientStub(),
        createCoreStub(),
        async (outputPath, content) => {
          await mkdir(path.dirname(outputPath), { recursive: true });
          await writeFile(outputPath, content, 'utf8');
        }
      );
      expect(result.status).toBe('resolved');
      expect(result.specFormat).toBe('wsdl');
      expect((result.specPath ?? '').replace(/\\/g, '/')).toBe('discovered-specs/orders/service.wsdl');
      expect(result.specFilesJson).toBeTruthy();
      const inventory = JSON.parse(result.specFilesJson ?? '{}') as { files: Array<{ path: string }> };
      expect(inventory.files.map((file) => file.path).sort()).toEqual([
        'discovered-specs/orders/service.wsdl',
        'discovered-specs/orders/types.xsd'
      ]);
    });
  });

  it('returns unresolved blank outputs for incomplete WSDL closures', async () => {
    await withFixtureCopy('wsdl-partial', async (repoRoot) => {
      const result = await runResolution(
        baseInputs(repoRoot),
        createAwsClientStub(),
        createCoreStub(),
        vi.fn().mockResolvedValue(undefined)
      );
      expect(result.status).toBe('unresolved');
      expect(result.sourceType).toBe('manual-review');
      expect(result.definitionCompleteness).toBe('partial');
      expect(result.specPath).toBe('');
      expect(result.specFilesJson).toBe('');
      const outputs = buildExecutionOutputs({ mode: 'resolve-one', discovered: [], resolution: result });
      expect(outputs['spec-path']).toBe('');
      expect(outputs['spec-files-json']).toBe('');
      expect(JSON.parse(outputs['resolution-json'] ?? '{}')).toMatchObject({ completeness: 'partial' });
    });
  });

  it('does not replace a prior export when a dependency is an escaping symlink', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pm-def-symlink-prior-'));
    try {
      const repoRoot = path.join(sandbox, 'repo');
      const outside = path.join(sandbox, 'outside');
      await mkdir(repoRoot, { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(path.join(outside, 'secret.proto'), 'syntax = "proto3";\n// leaked\n', 'utf8');
      await writeFile(
        path.join(repoRoot, 'service.proto'),
        'syntax = "proto3";\nimport "types.proto";\nservice Orders {}\n',
        'utf8'
      );
      await symlink(path.join(outside, 'secret.proto'), path.join(repoRoot, 'types.proto'));

      const serviceDir = path.join(repoRoot, 'discovered-specs', 'orders');
      await mkdir(serviceDir, { recursive: true });
      const priorRoot = 'syntax = "proto3";\n// prior authoritative root\n';
      const priorDep = 'syntax = "proto3";\n// prior authoritative dep\n';
      const priorSidecar = '{"keep":"prior-sidecar"}';
      await writeFile(path.join(serviceDir, 'service.proto'), priorRoot, 'utf8');
      await writeFile(path.join(serviceDir, 'types.proto'), priorDep, 'utf8');
      await writeFile(path.join(serviceDir, 'openapi.derived.json'), priorSidecar, 'utf8');

      const writeSpecFile = vi.fn(async (outputPath: string, content: string) => {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, content, 'utf8');
      });
      const result = await runResolution(
        baseInputs(repoRoot, { specPath: 'service.proto' }),
        createAwsClientStub(),
        createCoreStub(),
        writeSpecFile
      );

      expect(result.status).toBe('unresolved');
      expect(result.definitionCompleteness).toBe('partial');
      expect(result.specPath).toBe('');
      expect(result.specFilesJson).toBe('');
      expect(writeSpecFile).not.toHaveBeenCalled();
      expect(await readFile(path.join(serviceDir, 'service.proto'), 'utf8')).toBe(priorRoot);
      expect(await readFile(path.join(serviceDir, 'types.proto'), 'utf8')).toBe(priorDep);
      expect(await readFile(path.join(serviceDir, 'openapi.derived.json'), 'utf8')).toBe(priorSidecar);
      expect(priorDep).not.toContain('leaked');
      expect(await readFile(path.join(serviceDir, 'types.proto'), 'utf8')).not.toContain('leaked');
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('rejects an in-root symlink repo-spec root without replacing a prior export', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pm-def-symlink-root-inroot-'));
    try {
      const repoRoot = path.join(sandbox, 'repo');
      await mkdir(repoRoot, { recursive: true });
      const targetBytes =
        'syntax = "proto3";\nimport "types.proto";\nservice Orders {}\n// in-root symlink target\n';
      const depBytes = 'syntax = "proto3";\nmessage Order {}\n';
      await writeFile(path.join(repoRoot, 'real-service.proto'), targetBytes, 'utf8');
      await writeFile(path.join(repoRoot, 'types.proto'), depBytes, 'utf8');
      await symlink(path.join(repoRoot, 'real-service.proto'), path.join(repoRoot, 'service.proto'));

      const serviceDir = path.join(repoRoot, 'discovered-specs', 'orders');
      await mkdir(serviceDir, { recursive: true });
      const priorRoot = 'syntax = "proto3";\n// prior authoritative root\n';
      const priorDep = 'syntax = "proto3";\n// prior authoritative dep\n';
      const priorSidecar = '{"keep":"prior-sidecar"}';
      await writeFile(path.join(serviceDir, 'service.proto'), priorRoot, 'utf8');
      await writeFile(path.join(serviceDir, 'types.proto'), priorDep, 'utf8');
      await writeFile(path.join(serviceDir, 'openapi.derived.json'), priorSidecar, 'utf8');

      const writeSpecFile = vi.fn(async (outputPath: string, content: string) => {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, content, 'utf8');
      });
      const result = await runResolution(
        baseInputs(repoRoot, { specPath: 'service.proto' }),
        createAwsClientStub(),
        createCoreStub(),
        writeSpecFile
      );

      expect(result.status).toBe('unresolved');
      expect(result.sourceType).toBe('manual-review');
      expect(result.specPath).toBe('');
      expect(result.specFilesJson).toBe('');
      expect(writeSpecFile).not.toHaveBeenCalled();
      expect(await readFile(path.join(serviceDir, 'service.proto'), 'utf8')).toBe(priorRoot);
      expect(await readFile(path.join(serviceDir, 'types.proto'), 'utf8')).toBe(priorDep);
      expect(await readFile(path.join(serviceDir, 'openapi.derived.json'), 'utf8')).toBe(priorSidecar);
      expect(await readFile(path.join(serviceDir, 'service.proto'), 'utf8')).not.toContain('in-root symlink target');
      expect(JSON.stringify(result)).not.toContain('in-root symlink target');
      const outputs = buildExecutionOutputs({ mode: 'resolve-one', discovered: [], resolution: result });
      expect(outputs['spec-path']).toBe('');
      expect(outputs['spec-files-json']).toBe('');
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('rejects an in-root parent-directory symlink repo-spec root without replacing a prior export', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pm-def-symlink-root-parent-'));
    try {
      const repoRoot = path.join(sandbox, 'repo');
      await mkdir(path.join(repoRoot, 'real-specs'), { recursive: true });
      const targetBytes =
        'syntax = "proto3";\nimport "types.proto";\nservice Orders {}\n// parent-dir symlink target\n';
      const depBytes = 'syntax = "proto3";\nmessage Order {}\n';
      await writeFile(path.join(repoRoot, 'real-specs', 'service.proto'), targetBytes, 'utf8');
      await writeFile(path.join(repoRoot, 'real-specs', 'types.proto'), depBytes, 'utf8');
      await symlink(path.join(repoRoot, 'real-specs'), path.join(repoRoot, 'specs'));

      const serviceDir = path.join(repoRoot, 'discovered-specs', 'orders');
      await mkdir(serviceDir, { recursive: true });
      const priorRoot = 'syntax = "proto3";\n// prior authoritative root\n';
      const priorDep = 'syntax = "proto3";\n// prior authoritative dep\n';
      const priorSidecar = '{"keep":"prior-sidecar"}';
      await writeFile(path.join(serviceDir, 'service.proto'), priorRoot, 'utf8');
      await writeFile(path.join(serviceDir, 'types.proto'), priorDep, 'utf8');
      await writeFile(path.join(serviceDir, 'openapi.derived.json'), priorSidecar, 'utf8');

      const writeSpecFile = vi.fn(async (outputPath: string, content: string) => {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, content, 'utf8');
      });
      const result = await runResolution(
        baseInputs(repoRoot, { specPath: 'specs/service.proto' }),
        createAwsClientStub(),
        createCoreStub(),
        writeSpecFile
      );

      expect(result.status).toBe('unresolved');
      expect(result.sourceType).toBe('manual-review');
      expect(result.definitionCompleteness).toBe('partial');
      expect(result.specPath).toBe('');
      expect(result.specFilesJson).toBe('');
      expect(writeSpecFile).not.toHaveBeenCalled();
      expect(await readFile(path.join(serviceDir, 'service.proto'), 'utf8')).toBe(priorRoot);
      expect(await readFile(path.join(serviceDir, 'types.proto'), 'utf8')).toBe(priorDep);
      expect(await readFile(path.join(serviceDir, 'openapi.derived.json'), 'utf8')).toBe(priorSidecar);
      expect(await readFile(path.join(serviceDir, 'service.proto'), 'utf8')).not.toContain(
        'parent-dir symlink target'
      );
      expect(JSON.stringify(result)).not.toContain('parent-dir symlink target');
      const outputs = buildExecutionOutputs({ mode: 'resolve-one', discovered: [], resolution: result });
      expect(outputs['spec-path']).toBe('');
      expect(outputs['spec-files-json']).toBe('');
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('rejects an outside-target symlink repo-spec root without replacing a prior export', async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pm-def-symlink-root-outside-'));
    try {
      const repoRoot = path.join(sandbox, 'repo');
      const outside = path.join(sandbox, 'outside');
      await mkdir(repoRoot, { recursive: true });
      await mkdir(outside, { recursive: true });
      const outsideBytes =
        'syntax = "proto3";\nimport "types.proto";\nservice Orders {}\n// outside symlink target\n';
      await writeFile(path.join(outside, 'secret-service.proto'), outsideBytes, 'utf8');
      await writeFile(path.join(outside, 'types.proto'), 'syntax = "proto3";\nmessage Order {}\n', 'utf8');
      await symlink(path.join(outside, 'secret-service.proto'), path.join(repoRoot, 'service.proto'));

      const serviceDir = path.join(repoRoot, 'discovered-specs', 'orders');
      await mkdir(serviceDir, { recursive: true });
      const priorRoot = 'syntax = "proto3";\n// prior authoritative root\n';
      const priorDep = 'syntax = "proto3";\n// prior authoritative dep\n';
      const priorSidecar = '{"keep":"prior-sidecar"}';
      await writeFile(path.join(serviceDir, 'service.proto'), priorRoot, 'utf8');
      await writeFile(path.join(serviceDir, 'types.proto'), priorDep, 'utf8');
      await writeFile(path.join(serviceDir, 'openapi.derived.json'), priorSidecar, 'utf8');

      const writeSpecFile = vi.fn(async (outputPath: string, content: string) => {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, content, 'utf8');
      });

      // Outside-target roots fail during explicit path resolution (safe failure) or
      // resolve to blank unresolved outputs; either way prior export must stay intact.
      let unresolved: Awaited<ReturnType<typeof runResolution>> | undefined;
      try {
        unresolved = await runResolution(
          baseInputs(repoRoot, { specPath: 'service.proto' }),
          createAwsClientStub(),
          createCoreStub(),
          writeSpecFile
        );
      } catch (error) {
        expect(String(error)).toMatch(/symbolic link|must stay within|repo-root|spec-path/i);
      }

      if (unresolved) {
        expect(unresolved.status).toBe('unresolved');
        expect(unresolved.sourceType).toBe('manual-review');
        expect(unresolved.specPath).toBe('');
        expect(unresolved.specFilesJson).toBe('');
        const outputs = buildExecutionOutputs({ mode: 'resolve-one', discovered: [], resolution: unresolved });
        expect(outputs['spec-path']).toBe('');
        expect(outputs['spec-files-json']).toBe('');
        expect(JSON.stringify(unresolved)).not.toContain('outside symlink target');
      }

      expect(writeSpecFile).not.toHaveBeenCalled();
      expect(await readFile(path.join(serviceDir, 'service.proto'), 'utf8')).toBe(priorRoot);
      expect(await readFile(path.join(serviceDir, 'types.proto'), 'utf8')).toBe(priorDep);
      expect(await readFile(path.join(serviceDir, 'openapi.derived.json'), 'utf8')).toBe(priorSidecar);
      expect(await readFile(path.join(serviceDir, 'service.proto'), 'utf8')).not.toContain('outside symlink target');
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('keeps GraphQL and Smithy composition snapshots unchanged with empty inventory', async () => {
    await withFixtureCopy('smithy/sources', async (repoRoot) => {
      const writeSpecFile = vi.fn(async (outputPath: string, content: string) => {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, content, 'utf8');
      });
      const inventory = await inventoryRepoSpecs(repoRoot);
      const smithy = inventory.candidates.find((candidate) => candidate.format === 'smithy');
      expect(smithy?.content).toBeTruthy();
      const result = await runResolution(baseInputs(repoRoot), createAwsClientStub(), createCoreStub(), writeSpecFile);
      expect(result.status).toBe('resolved');
      expect(result.specFormat).toBe('smithy');
      expect(result.specPath).toBe('discovered-specs/orders/model.smithy');
      expect(result.specFilesJson ?? '').toBe('');
      const nativeWrite = writeSpecFile.mock.calls.find((call) =>
        String(call[0]).replace(/\\/g, '/').endsWith('discovered-specs/orders/model.smithy')
      );
      expect(nativeWrite?.[1]).toBe(smithy?.content);
      const outputs = buildExecutionOutputs({ mode: 'resolve-one', discovered: [], resolution: result });
      expect(outputs['spec-files-json']).toBe('');
    });

    await withFixtureCopy('graphql-multi', async (repoRoot) => {
      const writeSpecFile = vi.fn(async (outputPath: string, content: string) => {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, content, 'utf8');
      });
      const inventory = await inventoryRepoSpecs(repoRoot);
      const graphql = inventory.candidates.find((candidate) => candidate.format === 'graphql-sdl');
      expect(graphql?.content).toBeTruthy();
      const result = await runResolution(baseInputs(repoRoot), createAwsClientStub(), createCoreStub(), writeSpecFile);
      expect(result.status).toBe('resolved');
      expect(result.specFormat).toBe('graphql-sdl');
      expect(result.specPath).toBe('discovered-specs/orders/schema.graphql');
      expect(result.specFilesJson ?? '').toBe('');
      const nativeWrite = writeSpecFile.mock.calls.find((call) =>
        String(call[0]).replace(/\\/g, '/').endsWith('discovered-specs/orders/schema.graphql')
      );
      expect(nativeWrite?.[1]).toBe(graphql?.content);
      expect(nativeWrite?.[1]).toContain('type Query');
      expect(nativeWrite?.[1]).toContain('type Order');
    });
  });

  it('keeps single-file WSDL resolved with empty inventory', async () => {
    await withFixtureCopy('wsdl', async (repoRoot) => {
      const result = await runResolution(
        baseInputs(repoRoot),
        createAwsClientStub(),
        createCoreStub(),
        vi.fn().mockResolvedValue(undefined)
      );
      expect(result.status).toBe('resolved');
      expect(result.specPath).toBe('service.wsdl');
      expect(result.specFilesJson ?? '').toBe('');
    });
  });
});

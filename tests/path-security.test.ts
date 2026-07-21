import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createIacReadBudget, readIacFile } from '../src/lib/iac/read.js';
import type { IacResolutionError } from '../src/lib/iac/types.js';
import { SnsProvider } from '../src/lib/providers/sns.js';
import type { SpecCandidate } from '../src/lib/providers/types.js';
import type { SnsSpecClient } from '../src/lib/aws/sns-client.js';
import { collectRepoSignals } from '../src/lib/repo/signals.js';
import { inventoryRepoSpecs } from '../src/lib/repo/specs.js';
import {
  assertNoSymlinkComponentsWithinRoot,
  createLocalReferenceTraversalState,
  resolveLocalReadWithinRoot,
  resolvePathWithinRoot,
  withLocalReferenceDepth
} from '../src/lib/utils/resolve-path-within-root.js';

const sandboxes: string[] = [];

async function makeSandbox(prefix: string): Promise<{ root: string; outside: string; sandbox: string }> {
  const sandbox = await mkdtemp(path.join(tmpdir(), prefix));
  sandboxes.push(sandbox);
  const root = path.join(sandbox, 'repo');
  const outside = path.join(sandbox, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  return { root, outside, sandbox };
}

afterEach(async () => {
  while (sandboxes.length > 0) {
    const dir = sandboxes.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('resolvePathWithinRoot (lexical)', () => {
  it('rejects parent traversal and absolute escapes', () => {
    const root = '/tmp/repo-root';
    expect(() => resolvePathWithinRoot(root, '../escape', 'path')).toThrow(/must stay within/);
    expect(() => resolvePathWithinRoot(root, '/etc/passwd', 'path')).toThrow(/must stay within/);
  });

  it('allows in-root relative paths', () => {
    const root = '/tmp/repo-root';
    expect(resolvePathWithinRoot(root, 'specs/openapi.yaml', 'path')).toBe(
      path.resolve(root, 'specs/openapi.yaml')
    );
  });
});

describe('resolveLocalReadWithinRoot (canonical)', () => {
  it('allows a regular in-root file', async () => {
    const { root } = await makeSandbox('path-sec-ok-');
    await mkdir(path.join(root, 'specs'), { recursive: true });
    await writeFile(path.join(root, 'specs', 'openapi.yaml'), 'openapi: 3.0.3\n', 'utf8');

    const resolved = await resolveLocalReadWithinRoot(root, 'specs/openapi.yaml', {
      fieldName: 'spec-path',
      countAsReference: false
    });
    expect(resolved.relativePath).toBe(path.join('specs', 'openapi.yaml'));
    expect(resolved.canonicalPath).toBe(await realpath(path.join(root, 'specs', 'openapi.yaml')));
  });

  it('rejects parent traversal before any read', async () => {
    const { root } = await makeSandbox('path-sec-trav-');
    await writeFile(path.join(root, 'ok.yaml'), 'x', 'utf8');
    await expect(
      resolveLocalReadWithinRoot(root, '../outside/secret.yaml', { fieldName: 'spec-path' })
    ).rejects.toThrow(/must stay within/);
  });

  it('allows an in-root symlink and rejects an escaping symlink', async () => {
    const { root, outside } = await makeSandbox('path-sec-sym-');
    await writeFile(path.join(root, 'real.yaml'), 'in-root', 'utf8');
    await writeFile(path.join(outside, 'secret.yaml'), 'secret', 'utf8');
    await symlink(path.join(root, 'real.yaml'), path.join(root, 'in-root-link.yaml'));
    await symlink(path.join(outside, 'secret.yaml'), path.join(root, 'escape-link.yaml'));

    const ok = await resolveLocalReadWithinRoot(root, 'in-root-link.yaml', {
      fieldName: 'spec-path',
      countAsReference: false
    });
    expect(ok.canonicalPath.endsWith('real.yaml')).toBe(true);

    await expect(
      resolveLocalReadWithinRoot(root, 'escape-link.yaml', { fieldName: 'spec-path' })
    ).rejects.toThrow(/escaping symbolic links/);
  });

  it('default follow-in-root allows an in-root parent-directory symlink; strict mode rejects any component', async () => {
    const { root } = await makeSandbox('path-sec-parent-sym-');
    await mkdir(path.join(root, 'real-dir'), { recursive: true });
    await writeFile(path.join(root, 'real-dir', 'openapi.yaml'), 'openapi: 3.0.3\n', 'utf8');
    await symlink(path.join(root, 'real-dir'), path.join(root, 'linked-dir'));

    const followed = await resolveLocalReadWithinRoot(root, 'linked-dir/openapi.yaml', {
      fieldName: 'spec-path',
      countAsReference: false
    });
    expect(followed.canonicalPath).toBe(await realpath(path.join(root, 'real-dir', 'openapi.yaml')));

    await expect(
      resolveLocalReadWithinRoot(root, 'linked-dir/openapi.yaml', {
        fieldName: 'spec-path',
        countAsReference: false,
        rejectSymlinkComponents: true
      })
    ).rejects.toThrow(/must not traverse symbolic links/);

    await expect(
      assertNoSymlinkComponentsWithinRoot(root, 'linked-dir/openapi.yaml', 'spec-path')
    ).rejects.toThrow(/must not traverse symbolic links/);

    const nestedOk = await resolveLocalReadWithinRoot(root, 'real-dir/openapi.yaml', {
      fieldName: 'spec-path',
      countAsReference: false,
      rejectSymlinkComponents: true
    });
    expect(nestedOk.relativePath).toBe(path.join('real-dir', 'openapi.yaml'));
  });

  it('rejects a dangling symlink', async () => {
    const { root } = await makeSandbox('path-sec-dang-');
    await symlink(path.join(root, 'missing.yaml'), path.join(root, 'dangling.yaml'));
    await expect(
      resolveLocalReadWithinRoot(root, 'dangling.yaml', { fieldName: 'spec-path' })
    ).rejects.toThrow(/dangling link/);
  });

  it('rejects a symlink loop', async () => {
    const { root } = await makeSandbox('path-sec-loop-');
    const a = path.join(root, 'a.yaml');
    const b = path.join(root, 'b.yaml');
    await symlink(b, a);
    await symlink(a, b);
    await expect(resolveLocalReadWithinRoot(root, 'a.yaml', { fieldName: 'spec-path' })).rejects.toThrow(
      /symbolic link loop/
    );
  });

  it('rejects directory targets and missing files', async () => {
    const { root } = await makeSandbox('path-sec-dir-');
    await mkdir(path.join(root, 'subdir'));
    await expect(
      resolveLocalReadWithinRoot(root, 'subdir', { fieldName: 'spec-path', countAsReference: false })
    ).rejects.toThrow(/regular file/);
    await expect(
      resolveLocalReadWithinRoot(root, 'nope.yaml', { fieldName: 'spec-path', countAsReference: false })
    ).rejects.toThrow(/does not exist|dangling/);
  });

  it('enforces reference cycles and bounds via traversal metadata', async () => {
    const { root } = await makeSandbox('path-sec-bounds-');
    await writeFile(path.join(root, 'a.yaml'), 'a', 'utf8');
    await writeFile(path.join(root, 'b.yaml'), 'b', 'utf8');
    const traversal = createLocalReferenceTraversalState();

    await resolveLocalReadWithinRoot(root, 'a.yaml', {
      fieldName: 'ref',
      traversal,
      limits: { maxRefs: 2, maxDepth: 1, maxTotalBytes: 100, maxBytesPerFile: 50 }
    });
    await resolveLocalReadWithinRoot(root, 'b.yaml', {
      fieldName: 'ref',
      traversal,
      limits: { maxRefs: 2, maxDepth: 1, maxTotalBytes: 100, maxBytesPerFile: 50 }
    });
    await expect(
      resolveLocalReadWithinRoot(root, 'a.yaml', {
        fieldName: 'ref',
        traversal,
        limits: { maxRefs: 10, maxDepth: 1, maxTotalBytes: 100, maxBytesPerFile: 50 }
      })
    ).rejects.toThrow(/cycle/);

    const depthTraversal = createLocalReferenceTraversalState();
    await expect(
      withLocalReferenceDepth(depthTraversal, async () =>
        withLocalReferenceDepth(depthTraversal, async () =>
          resolveLocalReadWithinRoot(root, 'a.yaml', {
            fieldName: 'ref',
            traversal: depthTraversal,
            limits: { maxDepth: 1, maxRefs: 10, maxTotalBytes: 1000, maxBytesPerFile: 100 },
            countAsReference: false
          })
        )
      )
    ).rejects.toThrow(/depth exceeded/);
  });

  it('rejects cumulative byte overruns across references', async () => {
    const { root } = await makeSandbox('path-sec-bytes-');
    await writeFile(path.join(root, 'big.yaml'), 'x'.repeat(40), 'utf8');
    await writeFile(path.join(root, 'small.yaml'), 'y'.repeat(40), 'utf8');
    const traversal = createLocalReferenceTraversalState();
    await resolveLocalReadWithinRoot(root, 'big.yaml', {
      fieldName: 'ref',
      traversal,
      limits: { maxTotalBytes: 50, maxBytesPerFile: 100, maxRefs: 10, maxDepth: 5 }
    });
    await expect(
      resolveLocalReadWithinRoot(root, 'small.yaml', {
        fieldName: 'ref',
        traversal,
        limits: { maxTotalBytes: 50, maxBytesPerFile: 100, maxRefs: 10, maxDepth: 5 }
      })
    ).rejects.toThrow(/cumulative bytes/);
  });

  it('resolves relative refs from an in-root basePath', async () => {
    const { root } = await makeSandbox('path-sec-base-');
    await mkdir(path.join(root, 'specs', 'components'), { recursive: true });
    await writeFile(path.join(root, 'specs', 'components', 'schemas.yaml'), 'type: object\n', 'utf8');
    const resolved = await resolveLocalReadWithinRoot(root, './schemas.yaml', {
      fieldName: 'ref',
      basePath: path.join(root, 'specs', 'components'),
      countAsReference: false
    });
    expect(resolved.relativePath).toBe(path.join('specs', 'components', 'schemas.yaml'));
  });
});

describe('readIacFile canonical open (Q2/C4)', () => {
  it('reads the canonical symlink target and preserves lexical relative evidence; replacement escape fails closed', async () => {
    const { root, outside } = await makeSandbox('iac-canon-read-');
    await writeFile(path.join(root, 'canonical.yaml'), 'from-canonical-target', 'utf8');
    await symlink(path.join(root, 'canonical.yaml'), path.join(root, 'alias.yaml'));

    const budget = createIacReadBudget();
    const errors: IacResolutionError[] = [];
    const loaded = await readIacFile(root, 'alias.yaml', budget, errors, { countAsReference: false });

    expect(loaded).toEqual({
      content: 'from-canonical-target',
      relativePath: 'alias.yaml'
    });
    expect(errors).toEqual([]);
    expect(budget.files).toBe(1);

    // Replacement: swap the lexical alias to an escaping symlink. Resolve must
    // reject; content must never come from outside the root.
    await writeFile(path.join(outside, 'secret.yaml'), 'leaked-outside', 'utf8');
    await rm(path.join(root, 'alias.yaml'));
    await symlink(path.join(outside, 'secret.yaml'), path.join(root, 'alias.yaml'));

    const escapeErrors: IacResolutionError[] = [];
    const escaped = await readIacFile(root, 'alias.yaml', createIacReadBudget(), escapeErrors, {
      countAsReference: false
    });
    expect(escaped).toBeUndefined();
    expect(escapeErrors.some((entry) => entry.code === 'path-escape')).toBe(true);
    expect(escapeErrors.some((entry) => entry.message.includes('leaked-outside'))).toBe(false);
  });
});

describe('repository scan caller containment', () => {
  it('does not follow a symlinked common scan directory outside repo-root', async () => {
    const { root, outside } = await makeSandbox('repo-scan-root-sym-');
    await writeFile(path.join(outside, 'openapi.yaml'), 'openapi: 3.0.3\ninfo:\n  title: escaped\n', 'utf8');
    await symlink(outside, path.join(root, 'specs'));

    const inventory = await inventoryRepoSpecs(root);

    expect(inventory.candidates).toEqual([]);
    expect(inventory.errors.some((error) => error.code === 'path-escape' && error.path === 'specs')).toBe(true);
  });

  it('does not read an escaping fixed repo-signal symlink', async () => {
    const { root, outside } = await makeSandbox('repo-signal-sym-');
    await writeFile(
      path.join(outside, 'template.yaml'),
      'Type: AWS::ApiGateway::RestApi\nApiId: abcdef1234\n',
      'utf8'
    );
    await symlink(path.join(outside, 'template.yaml'), path.join(root, 'template.yaml'));

    const signals = await collectRepoSignals(root);

    expect(signals.inferredGatewayIdHints).not.toContain('abcdef1234');
    expect(signals.providerHints).not.toContain('api-gateway');
  });
});

function createSnsClientStub(): SnsSpecClient {
  return {
    probe: vi.fn().mockResolvedValue(true),
    listTopics: vi.fn().mockResolvedValue([]),
    getTopicAttributes: vi.fn().mockResolvedValue({}),
    listTagsForResource: vi.fn().mockResolvedValue({}),
    listSubscriptionsByTopic: vi.fn().mockResolvedValue([]),
    getSubscriptionAttributes: vi.fn().mockResolvedValue({})
  };
}

function createSnsCandidate(): SpecCandidate {
  return {
    id: 'arn:aws:sns:us-east-1:123456789012:orders-topic',
    name: 'orders-topic',
    providerType: 'sns',
    tags: {},
    evidence: [],
    meta: {
      topicArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic'
    }
  };
}

describe('SNS generated-artifact bounded traversal (Q3/C4)', () => {
  it('terminates on deep framework trees and fails closed without selecting a partial contract', async () => {
    const { root } = await makeSandbox('sns-gen-deep-');
    // Shallow candidate would be visible in a partial walk; deep nest exceeds maxDepth=8.
    await mkdir(path.join(root, 'build'), { recursive: true });
    await writeFile(
      path.join(root, 'build', 'asyncapi.yaml'),
      'asyncapi: 2.6.0\ninfo:\n  title: Shallow Partial\nchannels: {}\n',
      'utf8'
    );

    let deepDir = path.join(root, 'build');
    for (let level = 1; level <= 9; level += 1) {
      deepDir = path.join(deepDir, `d${level}`);
    }
    await mkdir(deepDir, { recursive: true });
    await writeFile(
      path.join(deepDir, 'orders-topic.asyncapi.yaml'),
      'asyncapi: 2.6.0\ninfo:\n  title: Deep Beyond Bound\nchannels: {}\n',
      'utf8'
    );

    const provider = new SnsProvider(createSnsClientStub(), root, undefined, {
      gitIgnoreChecker: () => false
    });
    const result = await provider.resolveContract(createSnsCandidate());

    expect(result.resolved).toBe(false);
    expect(result.evidence.some((line) => /generated-artifact search truncated at maxDepth=8/.test(line))).toBe(
      true
    );
    expect(result.evidence.some((line) => /Shallow Partial|Deep Beyond Bound|Resolved SNS contract from generated/.test(line))).toBe(
      false
    );
  });

  it('terminates on wide framework trees and fails closed without selecting a partial contract', async () => {
    const { root } = await makeSandbox('sns-gen-wide-');
    await mkdir(path.join(root, 'build', 'wide'), { recursive: true });

    // Sorted names: filler_000.json … then z-orders.asyncapi.yaml last.
    // maxVisited=200 guarantees truncation before the late contract is reliably selected.
    for (let index = 0; index < 220; index += 1) {
      const name = `filler_${String(index).padStart(3, '0')}.json`;
      await writeFile(path.join(root, 'build', 'wide', name), '{"type":"object"}', 'utf8');
    }
    await writeFile(
      path.join(root, 'build', 'wide', 'z-orders.asyncapi.yaml'),
      'asyncapi: 2.6.0\ninfo:\n  title: Late Partial\nchannels: {}\n',
      'utf8'
    );

    const provider = new SnsProvider(createSnsClientStub(), root, undefined, {
      gitIgnoreChecker: () => false
    });
    const result = await provider.resolveContract(createSnsCandidate());

    expect(result.resolved).toBe(false);
    expect(result.evidence.some((line) => /generated-artifact search truncated at maxVisited=200/.test(line))).toBe(
      true
    );
    expect(result.evidence.some((line) => /Late Partial|Resolved SNS contract from generated/.test(line))).toBe(
      false
    );
  });
});

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
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

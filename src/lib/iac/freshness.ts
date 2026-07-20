import { lstat, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { IacArtifactClass } from './types.js';
import { toPosix } from './read.js';

const GENERATED_PATH_RE = /(^|\/)(cdk\.out|\.aws-sam|\.serverless|dist|build|generated|out|target)(\/|$)/i;

const SOURCE_BASENAMES = new Set([
  'template.yaml',
  'template.yml',
  'template.json',
  'cdk.json',
  'serverless.yml',
  'serverless.yaml',
  'serverless.json',
  'samconfig.toml'
]);

/**
 * Classify a relative artifact path as authored vs generated, then refine
 * generated freshness by comparing mtimes against nearby source files.
 */
export async function classifyIacArtifact(
  repoRoot: string,
  relativePath: string,
  sourceHints: string[] = []
): Promise<IacArtifactClass> {
  const posix = toPosix(relativePath);
  if (!GENERATED_PATH_RE.test(posix)) {
    return 'authored';
  }

  const absolute = path.resolve(repoRoot, posix);
  let artifactMtime: number;
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      return 'freshness-unknown';
    }
    artifactMtime = info.mtimeMs;
  } catch {
    return 'freshness-unknown';
  }

  const candidates = await collectSourceCandidates(repoRoot, posix, sourceHints);
  if (candidates.length === 0) {
    return 'freshness-unknown';
  }

  let newestSource = 0;
  let sawSource = false;
  for (const candidate of candidates) {
    try {
      const info = await stat(path.resolve(repoRoot, candidate));
      if (info.isFile()) {
        sawSource = true;
        newestSource = Math.max(newestSource, info.mtimeMs);
      }
    } catch {
      // optional source
    }
  }

  if (!sawSource) {
    return 'freshness-unknown';
  }
  return artifactMtime >= newestSource ? 'generated-fresh' : 'generated-stale';
}

async function collectSourceCandidates(
  repoRoot: string,
  artifactRelative: string,
  sourceHints: string[]
): Promise<string[]> {
  const results = new Set<string>(sourceHints.map(toPosix));
  const root = path.resolve(repoRoot);

  // Walk up from the artifact directory looking for conventional source files.
  let current = path.dirname(path.resolve(root, artifactRelative));
  for (let depth = 0; depth < 6; depth += 1) {
    if (!current.startsWith(root)) break;
    const relativeDir = toPosix(path.relative(root, current)) || '.';
    try {
      const entries = await readdir(current);
      for (const entry of entries) {
        const lower = entry.toLowerCase();
        if (
          SOURCE_BASENAMES.has(lower)
          || lower.endsWith('.tf')
          || lower.endsWith('.tf.json')
          || lower === 'cdk.json'
        ) {
          results.add(relativeDir === '.' ? entry : `${relativeDir}/${entry}`);
        }
      }
    } catch {
      // ignore
    }
    if (current === root) break;
    current = path.dirname(current);
  }

  return [...results].sort((a, b) => a.localeCompare(b));
}

/** Map IaC artifact class onto the coarser repo inventory authored/generated axis. */
export function toRepoArtifactClass(artifactClass: IacArtifactClass): 'authored' | 'generated' {
  return artifactClass === 'authored' ? 'authored' : 'generated';
}

/** Ranking: authored > generated-fresh > freshness-unknown > generated-stale. */
export function artifactClassRank(artifactClass: IacArtifactClass): number {
  switch (artifactClass) {
    case 'authored':
      return 4;
    case 'generated-fresh':
      return 3;
    case 'freshness-unknown':
      return 2;
    case 'generated-stale':
      return 1;
  }
}

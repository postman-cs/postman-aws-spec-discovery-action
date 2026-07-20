import { lstat, opendir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { IacArtifactClass } from './types.js';
import { toPosix } from './read.js';

const GENERATED_PATH_RE = /(^|\/)(cdk\.out|\.aws-sam|\.serverless|dist|build|generated|out|target)(\/|$)/i;

/** Finite per-directory entry scan when probing for nearby `.tf` / `.tf.json` sources. */
const MAX_SOURCE_DIR_ENTRIES = 64;

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
  const artifactPosix = toPosix(artifactRelative);
  const results = new Set<string>(sourceHints.map(toPosix).filter((hint) => hint !== artifactPosix));
  const root = path.resolve(repoRoot);

  // Walk up from the artifact directory looking for conventional source files.
  let current = path.dirname(path.resolve(root, artifactRelative));
  for (let depth = 0; depth < 6; depth += 1) {
    if (!current.startsWith(root)) break;
    const relativeDir = toPosix(path.relative(root, current)) || '.';
    const joinRelative = (entry: string): string => (relativeDir === '.' ? entry : `${relativeDir}/${entry}`);

    // Probe the finite conventional basename set directly so large directories cannot
    // hide known sources behind an entry-scan bound.
    for (const basename of [...SOURCE_BASENAMES].sort((a, b) => a.localeCompare(b))) {
      const relative = joinRelative(basename);
      if (relative === artifactPosix) {
        continue;
      }
      try {
        const info = await stat(path.join(current, basename));
        if (info.isFile()) {
          results.add(relative);
        }
      } catch {
        // optional
      }
    }

    // Bounded streaming directory iteration for Terraform sources only (no full readdir).
    try {
      let inspected = 0;
      const directory = await opendir(current);
      for await (const dirent of directory) {
        if (inspected >= MAX_SOURCE_DIR_ENTRIES) {
          break;
        }
        inspected += 1;
        const lower = dirent.name.toLowerCase();
        if (lower.endsWith('.tf') || lower.endsWith('.tf.json')) {
          const relative = joinRelative(dirent.name);
          if (relative !== artifactPosix) {
            results.add(relative);
          }
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

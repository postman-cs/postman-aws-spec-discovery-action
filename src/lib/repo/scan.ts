import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.terraform',
  'dist',
  'build',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.pulumi',
]);

const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_DEPTH = 4;
/** Finite wall-clock bound shared across the whole recursive walk. */
const DEFAULT_MAX_ELAPSED_MS = 5_000;
/** Finite directory-entry inspection bound shared across the whole recursive walk. */
const DEFAULT_MAX_INSPECTED_ENTRIES = 5_000;

export interface FindIaCScanLimits {
  maxDepth?: number;
  maxFiles?: number;
  maxElapsedMs?: number;
  maxInspectedEntries?: number;
}

export interface FindIaCScanState {
  files: { value: number };
  inspectedEntries: number;
  deadlineAt: number;
  stopped: boolean;
}

function resolvedLimits(limits: FindIaCScanLimits = {}): Required<FindIaCScanLimits> {
  return {
    maxDepth: limits.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxFiles: limits.maxFiles ?? DEFAULT_MAX_FILES,
    maxElapsedMs: limits.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS,
    maxInspectedEntries: limits.maxInspectedEntries ?? DEFAULT_MAX_INSPECTED_ENTRIES,
  };
}

function shouldStop(state: FindIaCScanState, limits: Required<FindIaCScanLimits>, depth: number): boolean {
  if (state.stopped) return true;
  if (depth > limits.maxDepth) {
    state.stopped = true;
    return true;
  }
  if (state.files.value >= limits.maxFiles) {
    state.stopped = true;
    return true;
  }
  if (state.inspectedEntries >= limits.maxInspectedEntries) {
    state.stopped = true;
    return true;
  }
  if (Date.now() >= state.deadlineAt) {
    state.stopped = true;
    return true;
  }
  return false;
}

export async function findIaCFiles(
  root: string,
  extensions: string[],
  depth = 0,
  globalCount = { value: 0 },
  limits: FindIaCScanLimits = {},
  state?: FindIaCScanState,
): Promise<string[]> {
  const resolved = resolvedLimits(limits);
  const scanState: FindIaCScanState = state ?? {
    files: globalCount,
    inspectedEntries: 0,
    deadlineAt: Date.now() + Math.max(0, resolved.maxElapsedMs),
    stopped: false,
  };

  if (shouldStop(scanState, resolved, depth)) return [];

  const results: string[] = [];
  let directory;
  try {
    directory = await opendir(root);
  } catch {
    return depth === 0 ? [] : results;
  }

  for await (const dirent of directory) {
    if (shouldStop(scanState, resolved, depth)) break;

    scanState.inspectedEntries += 1;
    const entry = dirent.name;
    if (SKIP_DIRS.has(entry)) continue;

    const fullPath = path.join(root, entry);
    const info = await stat(fullPath).catch(() => null);
    if (!info) continue;

    if (info.isDirectory()) {
      const sub = await findIaCFiles(fullPath, extensions, depth + 1, scanState.files, limits, scanState);
      results.push(...sub);
    } else if (extensions.some((ext) => entry.endsWith(ext))) {
      if (scanState.files.value >= resolved.maxFiles) {
        scanState.stopped = true;
        break;
      }
      results.push(fullPath);
      scanState.files.value += 1;
    }
  }

  if (depth === 0) {
    results.sort((a, b) => a.localeCompare(b));
  }
  return results;
}

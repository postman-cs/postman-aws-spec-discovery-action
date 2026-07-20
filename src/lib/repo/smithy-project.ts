import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type SmithyProjectErrorCode =
  | 'malformed-config'
  | 'missing-import'
  | 'cycle'
  | 'path-escape'
  | 'bounds-exceeded'
  | 'unreadable';

export interface SmithyProjectError {
  code: SmithyProjectErrorCode;
  path: string;
  message: string;
}

export interface SmithyProjectClosure {
  buildPath: string;
  memberPaths: string[];
  content: string;
  projections: string[];
  evidence: string[];
  errors: SmithyProjectError[];
}

export interface ResolveSmithyProjectOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxCumulativeBytes?: number;
  maxDepth?: number;
}

const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_FILE_BYTES = 1_048_576;
const DEFAULT_MAX_CUMULATIVE_BYTES = 8_388_608;
const DEFAULT_MAX_DEPTH = 8;

interface ClosureState {
  repoRoot: string;
  buildDir: string;
  buildRelative: string;
  maxFiles: number;
  maxFileBytes: number;
  maxCumulativeBytes: number;
  maxDepth: number;
  memberPaths: string[];
  contents: Map<string, string>;
  projections: string[];
  errors: SmithyProjectError[];
  visiting: Set<string>;
  visitedDirs: Set<string>;
  cumulativeBytes: number;
}

/**
 * Resolve a bounded Smithy model closure from smithy-build.json.
 * Aggregates deterministic .smithy model content from local sources/imports/projections.
 * Never treats the JSON config itself as model source. Does not execute Smithy/Gradle/Maven.
 */
export async function resolveSmithyProject(
  repoRoot: string,
  buildRelativePath: string,
  options: ResolveSmithyProjectOptions = {}
): Promise<SmithyProjectClosure> {
  const resolvedRoot = path.resolve(repoRoot);
  const buildRelative = toPosix(buildRelativePath);
  const buildAbsolute = path.resolve(resolvedRoot, buildRelative);
  const empty: SmithyProjectClosure = {
    buildPath: buildRelative,
    memberPaths: [],
    content: '',
    projections: [],
    evidence: [],
    errors: []
  };

  if (!isPathInsideRoot(resolvedRoot, buildAbsolute)) {
    return {
      ...empty,
      errors: [{
        code: 'path-escape',
        path: buildRelative,
        message: `smithy-build.json path escapes repository root: ${buildRelative}`
      }]
    };
  }

  let raw: string;
  try {
    if (!(await isRegularNonSymlinkFile(buildAbsolute))) {
      return {
        ...empty,
        errors: [{
          code: 'unreadable',
          path: buildRelative,
          message: `smithy-build.json is not a regular file: ${buildRelative}`
        }]
      };
    }
    raw = await readFile(buildAbsolute, 'utf8');
  } catch (error) {
    return {
      ...empty,
      errors: [{
        code: 'unreadable',
        path: buildRelative,
        message: `Failed to read smithy-build.json: ${error instanceof Error ? error.message : String(error)}`
      }]
    };
  }

  let config: Record<string, unknown>;
  try {
    config = parseSmithyBuildJson(raw);
  } catch (error) {
    return {
      ...empty,
      errors: [{
        code: 'malformed-config',
        path: buildRelative,
        message: `Malformed smithy-build.json: ${error instanceof Error ? error.message : String(error)}`
      }]
    };
  }

  if (typeof config.version !== 'string' || !config.version.trim()) {
    return {
      ...empty,
      errors: [{
        code: 'malformed-config',
        path: buildRelative,
        message: 'smithy-build.json requires a non-empty string "version"'
      }]
    };
  }

  const state: ClosureState = {
    repoRoot: resolvedRoot,
    buildDir: path.dirname(buildAbsolute),
    buildRelative,
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxCumulativeBytes: options.maxCumulativeBytes ?? DEFAULT_MAX_CUMULATIVE_BYTES,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    memberPaths: [],
    contents: new Map(),
    projections: [],
    errors: [],
    visiting: new Set([path.resolve(buildAbsolute)]),
    visitedDirs: new Set(),
    cumulativeBytes: 0
  };

  const sources = asStringArray(config.sources);
  const imports = asStringArray(config.imports);
  const projections = config.projections && typeof config.projections === 'object' && !Array.isArray(config.projections)
    ? config.projections as Record<string, unknown>
    : {};

  state.projections = Object.keys(projections).sort((a, b) => a.localeCompare(b));

  if (sources.length === 0 && imports.length === 0 && state.projections.length === 0) {
    state.errors.push({
      code: 'malformed-config',
      path: buildRelative,
      message: 'smithy-build.json must declare sources, imports, or projections'
    });
  }

  for (const entry of sources) {
    await collectPathEntry(state, entry, 'source');
  }
  for (const entry of imports) {
    await collectPathEntry(state, entry, 'import');
  }

  for (const projectionName of state.projections) {
    const projection = projections[projectionName];
    if (!projection || typeof projection !== 'object' || Array.isArray(projection)) {
      state.errors.push({
        code: 'malformed-config',
        path: buildRelative,
        message: `Projection "${projectionName}" must be an object`
      });
      continue;
    }
    const projectionImports = asStringArray((projection as Record<string, unknown>).imports);
    for (const entry of projectionImports) {
      await collectPathEntry(state, entry, 'projection-import');
    }
  }

  state.visiting.delete(path.resolve(buildAbsolute));

  const memberPaths = [...state.contents.keys()].sort((a, b) => a.localeCompare(b));
  const content = memberPaths.map((member) => state.contents.get(member) ?? '').join('\n');
  const evidence = [
    `Resolved Smithy project closure from ${buildRelative}`,
    ...memberPaths.map((member) => `Included Smithy model ${member}`),
    ...(state.projections.length > 0
      ? [`Recorded projections: ${state.projections.join(', ')}`]
      : [])
  ];

  return {
    buildPath: buildRelative,
    memberPaths,
    content,
    projections: state.projections,
    evidence,
    errors: state.errors
  };
}

async function collectPathEntry(state: ClosureState, entry: string, kind: string): Promise<void> {
  if (state.errors.some((error) => error.code === 'bounds-exceeded' || error.code === 'cycle' || error.code === 'path-escape')) {
    return;
  }
  if (typeof entry !== 'string' || !entry.trim()) {
    state.errors.push({
      code: 'malformed-config',
      path: state.buildRelative,
      message: `Invalid ${kind} entry in smithy-build.json`
    });
    return;
  }

  const absolute = path.resolve(state.buildDir, entry);
  if (!isPathInsideRoot(state.repoRoot, absolute)) {
    state.errors.push({
      code: 'path-escape',
      path: toPosix(path.relative(state.repoRoot, absolute)),
      message: `Smithy ${kind} escapes repository root: ${entry}`
    });
    return;
  }

  const relative = toPosix(path.relative(state.repoRoot, absolute));
  const canonicalKey = path.resolve(absolute);

  if (state.visiting.has(canonicalKey)) {
    state.errors.push({
      code: 'cycle',
      path: relative,
      message: `Cycle detected while resolving Smithy ${kind}: ${entry}`
    });
    return;
  }

  let info;
  try {
    info = await lstat(absolute);
  } catch {
    state.errors.push({
      code: 'missing-import',
      path: relative,
      message: `Missing Smithy ${kind}: ${entry}`
    });
    return;
  }

  if (info.isSymbolicLink()) {
    state.errors.push({
      code: 'path-escape',
      path: relative,
      message: `Refusing to follow symlink Smithy ${kind}: ${entry}`
    });
    return;
  }

  if (info.isFile()) {
    if (path.basename(absolute).toLowerCase() === 'smithy-build.json') {
      await collectNestedSmithyBuild(state, absolute, relative);
      return;
    }
    await readSmithyModelFile(state, absolute, relative);
    return;
  }

  if (info.isDirectory()) {
    await walkSmithyDirectory(state, absolute, 0);
    return;
  }

  state.errors.push({
    code: 'unreadable',
    path: relative,
    message: `Smithy ${kind} is neither a file nor directory: ${entry}`
  });
}

async function walkSmithyDirectory(state: ClosureState, directory: string, depth: number): Promise<void> {
  if (state.errors.some((error) => error.code === 'bounds-exceeded' || error.code === 'cycle' || error.code === 'path-escape')) {
    return;
  }
  if (depth > state.maxDepth) {
    state.errors.push({
      code: 'bounds-exceeded',
      path: toPosix(path.relative(state.repoRoot, directory)),
      message: `Smithy directory depth exceeded maxDepth=${state.maxDepth}`
    });
    return;
  }

  const canonicalDir = path.resolve(directory);
  if (state.visitedDirs.has(canonicalDir)) {
    return;
  }
  if (state.visiting.has(canonicalDir)) {
    state.errors.push({
      code: 'cycle',
      path: toPosix(path.relative(state.repoRoot, directory)),
      message: `Cycle detected while walking Smithy directory: ${toPosix(path.relative(state.repoRoot, directory))}`
    });
    return;
  }

  state.visitedDirs.add(canonicalDir);
  state.visiting.add(canonicalDir);
  try {
    const entries = (await readdir(directory).catch(() => [] as string[])).sort((a, b) => a.localeCompare(b));
    for (const entry of entries) {
      if (state.contents.size >= state.maxFiles) {
        state.errors.push({
          code: 'bounds-exceeded',
          path: toPosix(path.relative(state.repoRoot, directory)),
          message: `Smithy model file count exceeded maxFiles=${state.maxFiles}`
        });
        return;
      }
      const fullPath = path.join(directory, entry);
      const info = await lstat(fullPath).catch(() => undefined);
      if (!info || info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await walkSmithyDirectory(state, fullPath, depth + 1);
        continue;
      }
      if (info.isFile() && entry.toLowerCase().endsWith('.smithy')) {
        const relative = toPosix(path.relative(state.repoRoot, fullPath));
        await readSmithyModelFile(state, fullPath, relative);
      }
    }
  } finally {
    state.visiting.delete(canonicalDir);
  }
}

async function collectNestedSmithyBuild(state: ClosureState, absolute: string, relative: string): Promise<void> {
  const canonical = path.resolve(absolute);
  if (state.visiting.has(canonical)) {
    state.errors.push({
      code: 'cycle',
      path: relative,
      message: `Cycle detected while resolving nested smithy-build.json: ${relative}`
    });
    return;
  }

  state.visiting.add(canonical);
  try {
    let raw: string;
    try {
      raw = await readFile(absolute, 'utf8');
    } catch (error) {
      state.errors.push({
        code: 'unreadable',
        path: relative,
        message: `Failed to read nested smithy-build.json: ${error instanceof Error ? error.message : String(error)}`
      });
      return;
    }

    let config: Record<string, unknown>;
    try {
      config = parseSmithyBuildJson(raw);
    } catch (error) {
      state.errors.push({
        code: 'malformed-config',
        path: relative,
        message: `Malformed nested smithy-build.json: ${error instanceof Error ? error.message : String(error)}`
      });
      return;
    }

    const nestedBuildDir = path.dirname(absolute);
    const previousBuildDir = state.buildDir;
    const previousBuildRelative = state.buildRelative;
    state.buildDir = nestedBuildDir;
    state.buildRelative = relative;
    try {
      for (const entry of asStringArray(config.sources)) {
        await collectPathEntry(state, entry, 'source');
      }
      for (const entry of asStringArray(config.imports)) {
        await collectPathEntry(state, entry, 'import');
      }
      const projections = config.projections && typeof config.projections === 'object' && !Array.isArray(config.projections)
        ? config.projections as Record<string, unknown>
        : {};
      for (const projectionName of Object.keys(projections).sort((a, b) => a.localeCompare(b))) {
        const projection = projections[projectionName];
        if (!projection || typeof projection !== 'object' || Array.isArray(projection)) continue;
        for (const entry of asStringArray((projection as Record<string, unknown>).imports)) {
          await collectPathEntry(state, entry, 'projection-import');
        }
      }
    } finally {
      state.buildDir = previousBuildDir;
      state.buildRelative = previousBuildRelative;
    }
  } finally {
    state.visiting.delete(canonical);
  }
}

async function readSmithyModelFile(state: ClosureState, absolute: string, relative: string): Promise<void> {
  if (state.contents.has(relative)) {
    return;
  }
  if (!relative.toLowerCase().endsWith('.smithy')) {
    // Non-.smithy files referenced directly are ignored for model aggregation
    // (JSON AST / maven artifacts are out of scope; never use smithy-build.json as model).
    return;
  }
  if (state.contents.size >= state.maxFiles) {
    state.errors.push({
      code: 'bounds-exceeded',
      path: relative,
      message: `Smithy model file count exceeded maxFiles=${state.maxFiles}`
    });
    return;
  }

  let content: string;
  try {
    content = await readFile(absolute, 'utf8');
  } catch (error) {
    state.errors.push({
      code: 'unreadable',
      path: relative,
      message: `Failed to read Smithy model: ${error instanceof Error ? error.message : String(error)}`
    });
    return;
  }

  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > state.maxFileBytes) {
    state.errors.push({
      code: 'bounds-exceeded',
      path: relative,
      message: `Smithy model exceeds maxFileBytes=${state.maxFileBytes}`
    });
    return;
  }
  if (state.cumulativeBytes + bytes > state.maxCumulativeBytes) {
    state.errors.push({
      code: 'bounds-exceeded',
      path: relative,
      message: `Smithy closure exceeds maxCumulativeBytes=${state.maxCumulativeBytes}`
    });
    return;
  }

  state.cumulativeBytes += bytes;
  state.contents.set(relative, content);
  state.memberPaths.push(relative);
}

function parseSmithyBuildJson(raw: string): Record<string, unknown> {
  const withoutComments = raw.replace(/^\s*\/\/.*$/gm, '');
  const parsed = JSON.parse(withoutComments) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('root value must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function isPathInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function isRegularNonSymlinkFile(absolutePath: string): Promise<boolean> {
  try {
    const info = await lstat(absolutePath);
    return !info.isSymbolicLink() && info.isFile();
  } catch {
    return false;
  }
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

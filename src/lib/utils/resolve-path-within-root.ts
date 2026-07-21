import { realpath, lstat, readlink, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Lexical path confinement (no I/O). Rejects `..` / absolute escape relative to root.
 * Use {@link resolveLocalReadWithinRoot} before reading untrusted local paths.
 */
export function resolvePathWithinRoot(rootPath: string, targetPath: string, fieldName: string): string {
  const base = path.resolve(rootPath);
  const resolved = path.resolve(base, targetPath);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${fieldName} must stay within repo-root/workspace; received ${targetPath}`);
  }
  return resolved;
}

export const DEFAULT_LOCAL_REFERENCE_LIMITS = {
  maxDepth: 20,
  maxRefs: 100,
  maxBytesPerFile: 10 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024
} as const;

export type LocalReferenceLimits = {
  maxDepth: number;
  maxRefs: number;
  maxBytesPerFile: number;
  maxTotalBytes: number;
};

/**
 * Mutable traversal budget for callers walking local `$ref` / import graphs.
 * Pass the same instance across nested resolves so depth/ref/byte/cycle bounds apply.
 */
export interface LocalReferenceTraversalState {
  depth: number;
  refs: number;
  totalBytes: number;
  visitedCanonicalPaths: Set<string>;
}

export function createLocalReferenceTraversalState(): LocalReferenceTraversalState {
  return {
    depth: 0,
    refs: 0,
    totalBytes: 0,
    visitedCanonicalPaths: new Set()
  };
}

export interface LocalReadResolution {
  /** Absolute path suitable for open/read (lexically under root). */
  absolutePath: string;
  /** Path relative to the allowed root using platform separators. */
  relativePath: string;
  /** Canonical realpath of the target file (after symlink resolution). */
  canonicalPath: string;
  /** Canonical realpath of the allowed root. */
  canonicalRoot: string;
}

export interface ResolveLocalReadOptions {
  /** Field name used in error messages. */
  fieldName?: string;
  /**
   * Optional base directory for relative targets (e.g. parent document directory).
   * Relative values are resolved from the allowed root; absolute values must stay inside it.
   */
  basePath?: string;
  /** Shared traversal state for reference-graph bounds. */
  traversal?: LocalReferenceTraversalState;
  /** Override default local reference limits. */
  limits?: Partial<LocalReferenceLimits>;
  /**
   * When true (default), increments traversal.refs and rejects revisiting the same
   * canonical path (cycle). Set false for one-off containment checks.
   */
  countAsReference?: boolean;
  /**
   * Optional known file size to charge against cumulative bytes without reading.
   * When omitted, size is taken from stat of the resolved file.
   */
  fileByteLength?: number;
  /**
   * When true, reject any symbolic link among lexical path components
   * (reject-not-follow). Default false preserves in-root symlink following for
   * non-authoritative local reads. Authoritative definition root/dependency
   * reads must set this (or call {@link assertNoSymlinkComponentsWithinRoot}).
   */
  rejectSymlinkComponents?: boolean;
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveBaseWithinRoot(lexicalRoot: string, basePath: string | undefined): string {
  if (!basePath) return lexicalRoot;
  const resolvedBase = path.isAbsolute(basePath)
    ? path.resolve(basePath)
    : path.resolve(lexicalRoot, basePath);
  if (!isPathInsideRoot(lexicalRoot, resolvedBase)) {
    throw new Error(`basePath must stay within repo-root/workspace; received ${basePath}`);
  }
  return resolvedBase;
}

async function resolveCanonicalRoot(rootPath: string): Promise<string> {
  const resolvedRoot = path.resolve(rootPath);
  try {
    return await realpath(resolvedRoot);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`Allowed root does not exist: ${resolvedRoot}`, { cause: error });
    }
    throw error;
  }
}

type SymlinkComponentMode = 'follow-in-root' | 'reject-any';

/**
 * Walk each path component with lstat.
 * - `follow-in-root`: resolve in-root symlinks; reject escapes, dangling links, loops.
 * - `reject-any`: refuse every symbolic link component (reject-not-follow).
 * When `allowMissing` is true, stop at the first missing component after verifying
 * the existing prefix has no symlinks (write destinations that do not exist yet).
 */
async function walkPathComponentsWithinRoot(
  lexicalRoot: string,
  absoluteLexical: string,
  fieldName: string,
  originalTarget: string,
  mode: SymlinkComponentMode = 'follow-in-root',
  allowMissing = false
): Promise<void> {
  const relativeTarget = path.relative(lexicalRoot, absoluteLexical);
  if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
    throw new Error(`${fieldName} must stay within repo-root/workspace; received ${originalTarget}`);
  }

  let current = lexicalRoot;
  const seenLinkTargets = new Set<string>();
  const components = relativeTarget.split(path.sep).filter(Boolean);

  for (const component of components) {
    current = path.join(current, component);
    let linkStat;
    try {
      linkStat = await lstat(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        if (allowMissing) {
          break;
        }
        throw new Error(
          `${fieldName} path does not exist or is a dangling link; received ${originalTarget}`,
          { cause: error }
        );
      }
      throw error;
    }

    if (!linkStat.isSymbolicLink()) {
      continue;
    }

    if (mode === 'reject-any') {
      throw new Error(
        `${fieldName} must stay within repo-root/workspace and must not traverse symbolic links; received ${originalTarget}`
      );
    }

    let linkTarget: string;
    try {
      linkTarget = await readlink(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new Error(
          `${fieldName} path does not exist or is a dangling link; received ${originalTarget}`,
          { cause: error }
        );
      }
      throw error;
    }

    const resolvedLink = path.resolve(path.dirname(current), linkTarget);
    if (seenLinkTargets.has(resolvedLink)) {
      throw new Error(`${fieldName} contains a symbolic link loop; received ${originalTarget}`);
    }
    seenLinkTargets.add(resolvedLink);

    if (!isPathInsideRoot(lexicalRoot, resolvedLink)) {
      throw new Error(
        `${fieldName} must stay within repo-root/workspace and must not follow escaping symbolic links; received ${originalTarget}`
      );
    }

    // Continue walking from the symlink destination for remaining components.
    current = resolvedLink;
  }
}

/**
 * Lexical containment + lstat-walk that rejects any symbolic link component
 * (reject-not-follow). Missing trailing components are allowed so writeNative
 * destinations that do not exist yet can still refuse symlink prefixes.
 * Unrelated callers should keep {@link resolveLocalReadWithinRoot} default
 * follow-in-root behavior.
 */
export async function assertNoSymlinkComponentsWithinRoot(
  rootPath: string,
  targetPath: string,
  fieldName = 'path'
): Promise<string> {
  const lexicalRoot = path.resolve(rootPath);
  const absoluteLexical = resolvePathWithinRoot(lexicalRoot, targetPath, fieldName);
  await walkPathComponentsWithinRoot(
    lexicalRoot,
    absoluteLexical,
    fieldName,
    targetPath,
    'reject-any',
    true
  );
  return absoluteLexical;
}

/**
 * Canonical local-read resolver: lexical containment + symlink-safe realpath check.
 * Rejects parent traversal, escaping symlinks, dangling links, symlink loops, and
 * targets outside the allowed root. Optionally updates bounded reference-traversal metadata.
 */
export async function resolveLocalReadWithinRoot(
  rootPath: string,
  targetPath: string,
  options: ResolveLocalReadOptions = {}
): Promise<LocalReadResolution> {
  const fieldName = options.fieldName ?? 'path';
  const limits: LocalReferenceLimits = {
    ...DEFAULT_LOCAL_REFERENCE_LIMITS,
    ...options.limits
  };
  const countAsReference = options.countAsReference !== false;
  const traversal = options.traversal;

  if (traversal) {
    if (traversal.depth > limits.maxDepth) {
      throw new Error(
        `${fieldName} local reference depth exceeded ${limits.maxDepth}; received ${targetPath}`
      );
    }
    if (countAsReference && traversal.refs >= limits.maxRefs) {
      throw new Error(
        `${fieldName} local reference count exceeded ${limits.maxRefs}; received ${targetPath}`
      );
    }
  }

  const lexicalRoot = path.resolve(rootPath);
  const canonicalRoot = await resolveCanonicalRoot(lexicalRoot);
  const lexicalBase = resolveBaseWithinRoot(lexicalRoot, options.basePath);
  const absoluteLexical = resolvePathWithinRoot(lexicalBase, targetPath, fieldName);

  if (!isPathInsideRoot(lexicalRoot, absoluteLexical)) {
    throw new Error(`${fieldName} must stay within repo-root/workspace; received ${targetPath}`);
  }

  const symlinkMode: SymlinkComponentMode = options.rejectSymlinkComponents
    ? 'reject-any'
    : 'follow-in-root';
  await walkPathComponentsWithinRoot(
    lexicalRoot,
    absoluteLexical,
    fieldName,
    targetPath,
    symlinkMode
  );

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(absoluteLexical);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `${fieldName} path does not exist or is a dangling link; received ${targetPath}`,
        { cause: error }
      );
    }
    if (code === 'ELOOP') {
      throw new Error(`${fieldName} contains a symbolic link loop; received ${targetPath}`, {
        cause: error
      });
    }
    throw error;
  }

  if (!isPathInsideRoot(canonicalRoot, canonicalPath)) {
    throw new Error(
      `${fieldName} must stay within repo-root/workspace and must not follow escaping symbolic links; received ${targetPath}`
    );
  }

  let fileStat;
  try {
    fileStat = await stat(canonicalPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `${fieldName} path does not exist or is a dangling link; received ${targetPath}`,
        { cause: error }
      );
    }
    throw error;
  }

  if (!fileStat.isFile()) {
    throw new Error(`${fieldName} must resolve to a regular file; received ${targetPath}`);
  }

  const byteLength = options.fileByteLength ?? fileStat.size;
  if (byteLength > limits.maxBytesPerFile) {
    throw new Error(
      `${fieldName} exceeds per-file byte limit (${byteLength} > ${limits.maxBytesPerFile}); received ${targetPath}`
    );
  }

  if (traversal) {
    if (countAsReference) {
      traversal.refs += 1;
    }
    if (traversal.visitedCanonicalPaths.has(canonicalPath)) {
      throw new Error(
        `${fieldName} local reference cycle detected at ${path.relative(canonicalRoot, canonicalPath)}`
      );
    }
    traversal.visitedCanonicalPaths.add(canonicalPath);
    traversal.totalBytes += byteLength;
    if (traversal.totalBytes > limits.maxTotalBytes) {
      throw new Error(
        `${fieldName} local reference cumulative bytes exceeded ${limits.maxTotalBytes}`
      );
    }
  }

  return {
    absolutePath: absoluteLexical,
    relativePath: path.relative(lexicalRoot, absoluteLexical),
    canonicalPath,
    canonicalRoot
  };
}

/**
 * Advance traversal depth for a nested local-reference hop. Callers should
 * increment before resolving a child ref and decrement in a finally block, or
 * use {@link withLocalReferenceDepth}.
 */
export function enterLocalReferenceDepth(traversal: LocalReferenceTraversalState): void {
  traversal.depth += 1;
}

export function leaveLocalReferenceDepth(traversal: LocalReferenceTraversalState): void {
  traversal.depth = Math.max(0, traversal.depth - 1);
}

export async function withLocalReferenceDepth<T>(
  traversal: LocalReferenceTraversalState,
  fn: () => Promise<T>
): Promise<T> {
  enterLocalReferenceDepth(traversal);
  try {
    return await fn();
  } finally {
    leaveLocalReferenceDepth(traversal);
  }
}

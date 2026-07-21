import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { SpecFormat } from '../../contracts.js';
import { resolveLocalReadWithinRoot, resolvePathWithinRoot } from '../utils/resolve-path-within-root.js';

export type DefinitionFileRole = 'root' | 'dependency';
export type DefinitionCompleteness = 'full' | 'partial';

export interface DefinitionInventoryFile {
  path: string;
  role: DefinitionFileRole;
  bytes: number;
  sha256: string;
}

export interface DefinitionFileInventory {
  schemaVersion: 1;
  root: string;
  format: SpecFormat;
  completeness: DefinitionCompleteness;
  provenance: { kind: 'provider'; provider: 'aws' };
  files: DefinitionInventoryFile[];
}

export interface DefinitionMemberInput {
  /** Workspace-relative POSIX path that will appear in inventory / spec-path. */
  path: string;
  role: DefinitionFileRole;
  content: string;
}

export interface StagedDefinitionWriteInput {
  repoRoot: string;
  /** Canonical service directory relative to repoRoot (e.g. discovered-specs/orders). */
  serviceDirRelative: string;
  members: DefinitionMemberInput[];
  /** Non-definition sidecars written in the same staged transaction (filename under service dir). */
  sidecars?: Array<{ filename: string; content: string }>;
  /** When provided, used instead of default fs writes (tests). */
  writeFile?: (absolutePath: string, content: string) => Promise<void>;
  runId?: string;
}

const WELL_KNOWN_PROTO_PREFIXES = [
  'google/protobuf/',
  'google/api/',
  'google/rpc/',
  'google/type/',
  'google/longrunning/'
] as const;

const MAX_DEFINITION_FILES = 101;
const MAX_DEFINITION_DEPTH = 20;
const MAX_BYTES_PER_FILE = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export function sha256Utf8(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function isWellKnownProtobufImport(value: string): boolean {
  return WELL_KNOWN_PROTO_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function extractProtobufImports(content: string): string[] {
  const withoutComments = content.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  const refs: string[] = [];
  const pattern = /^\s*import\s+(?:public\s+|weak\s+)?"([^"]+)"\s*;/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutComments)) !== null) {
    const value = match[1]?.trim();
    if (value) refs.push(value);
  }
  return [...new Set(refs)];
}

export function extractXmlSchemaDependencyRefs(content: string): string[] {
  const refs: string[] = [];
  const patterns = [
    /\b(?:schemaLocation|itemSchemaLocation)\s*=\s*["']([^"']+)["']/gi,
    /<(?:[\w.-]+:)?import\b[^>]*\blocation\s*=\s*["']([^"']+)["']/gi,
    /<(?:[\w.-]+:)?include\b[^>]*\bschemaLocation\s*=\s*["']([^"']+)["']/gi,
    /<(?:[\w.-]+:)?redefine\b[^>]*\bschemaLocation\s*=\s*["']([^"']+)["']/gi
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const value = match[1]?.trim();
      if (value) refs.push(value);
    }
  }
  return [...new Set(refs)];
}

export function listDefinitionDependencyRefs(content: string, format: SpecFormat): string[] {
  if (format === 'protobuf') return extractProtobufImports(content);
  if (format === 'wsdl') return extractXmlSchemaDependencyRefs(content);
  return [];
}

function isAbsoluteOrRemoteRef(ref: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//');
}

export function normalizeRelativeDependencyRef(ref: string): string | undefined {
  if (!ref || isAbsoluteOrRemoteRef(ref)) return undefined;
  const normalized = ref.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.includes('\0') || normalized.split('/').includes('..')) {
    return undefined;
  }
  if (normalized.split('/').some((part) => part === '' || part === '.')) {
    return undefined;
  }
  return normalized;
}

export function assertSafeBundleRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').normalize('NFC');
  if (!normalized || normalized.includes('\0') || path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Unsafe definition path: ${relativePath}`);
  }
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`Unsafe definition path: ${relativePath}`);
  }
  return normalized;
}

export function buildDefinitionFileInventory(input: {
  root: string;
  format: SpecFormat;
  completeness: DefinitionCompleteness;
  files: DefinitionMemberInput[];
}): DefinitionFileInventory {
  const root = assertSafeBundleRelativePath(input.root);
  const roots = input.files.filter((file) => file.role === 'root');
  if (roots.length !== 1) {
    throw new Error(`Definition inventory requires exactly one root; received ${roots.length}`);
  }
  if (assertSafeBundleRelativePath(roots[0]!.path) !== root) {
    throw new Error('Definition inventory root path mismatch');
  }

  const seen = new Set<string>();
  const files: DefinitionInventoryFile[] = input.files
    .map((file) => {
      const pathKey = assertSafeBundleRelativePath(file.path);
      if (seen.has(pathKey) || seen.has(pathKey.toLowerCase())) {
        throw new Error(`Duplicate definition inventory path: ${pathKey}`);
      }
      seen.add(pathKey);
      seen.add(pathKey.toLowerCase());
      const bytes = Buffer.byteLength(file.content, 'utf8');
      return {
        path: pathKey,
        role: file.role,
        bytes,
        sha256: sha256Utf8(file.content)
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    schemaVersion: 1,
    root,
    format: input.format,
    completeness: input.completeness,
    provenance: { kind: 'provider', provider: 'aws' },
    files
  };
}

/** Single-line JSON inventory output (no embedded content). Empty string when not authoritative multi-file. */
export function serializeDefinitionFileInventory(inventory: DefinitionFileInventory | undefined): string {
  if (!inventory || inventory.completeness !== 'full' || inventory.files.length < 2) {
    return '';
  }
  return JSON.stringify(inventory);
}

export type RepoDefinitionClosure =
  | {
      status: 'single';
      completeness: 'full';
      rootContent: string;
      evidence: string[];
    }
  | {
      status: 'multi';
      completeness: 'full';
      rootContent: string;
      members: Array<{ relativeToBundleBase: string; role: DefinitionFileRole; content: string; sourcePath: string }>;
      evidence: string[];
    }
  | {
      status: 'partial';
      completeness: 'partial';
      rootContent: string;
      missingRefs: string[];
      evidence: string[];
    };

/**
 * Resolve a repo-local WSDL/protobuf closure under dirname(root).
 * Well-known protobuf imports are ignored. Remote/absolute/missing refs stay partial.
 * Does not invent cloud dependencies and never concatenates member bytes.
 */
export async function resolveRepoDefinitionClosure(options: {
  repoRoot: string;
  rootRelativePath: string;
  rootContent: string;
  format: SpecFormat;
}): Promise<RepoDefinitionClosure> {
  if (options.format !== 'protobuf' && options.format !== 'wsdl') {
    return {
      status: 'single',
      completeness: 'full',
      rootContent: options.rootContent,
      evidence: [`Format ${options.format} is not a multi-file definition closure source`]
    };
  }

  const rootRelative = assertSafeBundleRelativePath(options.rootRelativePath.replace(/\\/g, '/'));
  const bundleBase = path.posix.dirname(rootRelative);
  const rootBaseName = path.posix.basename(rootRelative);
  const queue: Array<{ relativeToBundleBase: string; content: string; role: DefinitionFileRole; depth: number }> = [
    { relativeToBundleBase: rootBaseName, content: options.rootContent, role: 'root', depth: 0 }
  ];
  const members = new Map<string, { relativeToBundleBase: string; content: string; role: DefinitionFileRole; sourcePath: string }>();
  members.set(rootBaseName, {
    relativeToBundleBase: rootBaseName,
    content: options.rootContent,
    role: 'root',
    sourcePath: rootRelative
  });

  const missingRefs: string[] = [];
  let totalBytes = Buffer.byteLength(options.rootContent, 'utf8');

  while (queue.length > 0) {
    if (members.size > MAX_DEFINITION_FILES) {
      return {
        status: 'partial',
        completeness: 'partial',
        rootContent: options.rootContent,
        missingRefs: ['<ref-count-exceeded>'],
        evidence: [`Definition closure exceeded ${MAX_DEFINITION_FILES} files`]
      };
    }

    const current = queue.shift()!;
    if (current.depth > MAX_DEFINITION_DEPTH) {
      return {
        status: 'partial',
        completeness: 'partial',
        rootContent: options.rootContent,
        missingRefs: ['<ref-depth-exceeded>'],
        evidence: [`Definition closure exceeded depth ${MAX_DEFINITION_DEPTH}`]
      };
    }

    const refs = listDefinitionDependencyRefs(current.content, options.format);
    for (const ref of refs) {
      if (options.format === 'protobuf' && isWellKnownProtobufImport(ref)) {
        continue;
      }
      const key = normalizeRelativeDependencyRef(ref);
      if (!key) {
        missingRefs.push(ref);
        continue;
      }
      const candidateRelative =
        current.relativeToBundleBase.includes('/')
          ? path.posix.normalize(path.posix.join(path.posix.dirname(current.relativeToBundleBase), key))
          : path.posix.normalize(key);
      if (candidateRelative.split('/').includes('..')) {
        missingRefs.push(ref);
        continue;
      }
      if (members.has(candidateRelative)) continue;

      const childDepth = current.depth + 1;
      if (childDepth > MAX_DEFINITION_DEPTH) {
        return {
          status: 'partial',
          completeness: 'partial',
          rootContent: options.rootContent,
          missingRefs: ['<ref-depth-exceeded>'],
          evidence: [`Definition closure exceeded depth ${MAX_DEFINITION_DEPTH}`]
        };
      }

      const sourcePath =
        bundleBase === '.' ? candidateRelative : path.posix.join(bundleBase, candidateRelative);
      try {
        // Authoritative dependency members: reject-not-follow for every lexical
        // path component (including in-root parent directory symlinks), then
        // consume only regular-file bytes under repo/bundle base.
        const resolved = await resolveLocalReadWithinRoot(options.repoRoot, sourcePath, {
          fieldName: 'definition-dependency',
          countAsReference: false,
          rejectSymlinkComponents: true,
          limits: {
            maxDepth: MAX_DEFINITION_DEPTH,
            maxRefs: MAX_DEFINITION_FILES,
            maxBytesPerFile: MAX_BYTES_PER_FILE,
            maxTotalBytes: MAX_TOTAL_BYTES
          }
        });
        const content = await readFile(resolved.canonicalPath, 'utf8');
        const byteLength = Buffer.byteLength(content, 'utf8');
        if (byteLength > MAX_BYTES_PER_FILE || totalBytes + byteLength > MAX_TOTAL_BYTES) {
          missingRefs.push(ref);
          continue;
        }
        totalBytes += byteLength;
        members.set(candidateRelative, {
          relativeToBundleBase: candidateRelative,
          content,
          role: 'dependency',
          sourcePath
        });
        queue.push({
          relativeToBundleBase: candidateRelative,
          content,
          role: 'dependency',
          depth: childDepth
        });
      } catch {
        missingRefs.push(ref);
      }
    }
  }

  if (missingRefs.length > 0) {
    return {
      status: 'partial',
      completeness: 'partial',
      rootContent: options.rootContent,
      missingRefs: [...new Set(missingRefs)],
      evidence: [
        `${options.format} definition closure is incomplete; missing or remote dependency reference(s): ${[...new Set(missingRefs)].join(', ')}`
      ]
    };
  }

  if (members.size === 1) {
    return {
      status: 'single',
      completeness: 'full',
      rootContent: options.rootContent,
      evidence: [`No external ${options.format} dependency references; primary document is dependency-closed`]
    };
  }

  return {
    status: 'multi',
    completeness: 'full',
    rootContent: options.rootContent,
    members: [...members.values()].sort((left, right) =>
      left.relativeToBundleBase.localeCompare(right.relativeToBundleBase)
    ),
    evidence: [
      `Resolved complete ${options.format} definition closure with ${members.size} file(s) under ${bundleBase === '.' ? '.' : bundleBase}`
    ]
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        out.push(absolute);
      }
    }
  }
  await walk(rootDir);
  return out;
}

async function fsyncFile(absolutePath: string): Promise<void> {
  const handle = await open(absolutePath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Non-definition sidecars that may be preserved across staged definition replacements. */
function isPreservedNonDefinitionSidecar(relativeInsideServiceDir: string): boolean {
  const normalized = relativeInsideServiceDir.replace(/\\/g, '/');
  if (normalized.includes('/')) {
    // Nested prior files are treated as stale definition members unless explicitly staged.
    return false;
  }
  return (
    normalized === 'sns-resolution-metadata.json'
    || normalized === 'webhook.openapi.json'
    || normalized === 'openapi.derived.json'
    || /^openapi\.derived-\d+\.json$/.test(normalized)
  );
}

/**
 * Stage a complete multi-file definition export atomically.
 * Preserves non-definition sidecars already present in the canonical service directory.
 * On staging failure, restores any prior tree and never leaves a mixed canonical directory.
 */
export async function stageDefinitionExportTree(input: StagedDefinitionWriteInput): Promise<{
  ownedRelativePaths: string[];
}> {
  const serviceDirRelative = assertSafeBundleRelativePath(input.serviceDirRelative.replace(/\\/g, '/'));
  const canonicalAbsolute = resolvePathWithinRoot(input.repoRoot, serviceDirRelative, 'output-dir');
  const runId = input.runId ?? randomBytes(8).toString('hex');
  const parentDir = path.dirname(canonicalAbsolute);
  const baseName = path.basename(canonicalAbsolute);
  const stageAbsolute = path.join(parentDir, `${baseName}.stage-${runId}`);
  const backupAbsolute = path.join(parentDir, `${baseName}.backup-${runId}`);
  const write = input.writeFile ?? (async (absolutePath: string, content: string) => {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  });

  const ownedRelativePaths = input.members.map((member) => assertSafeBundleRelativePath(member.path.replace(/\\/g, '/')));
  const ownedBasenames = new Set(
    ownedRelativePaths.map((memberPath) => {
      const prefix = `${serviceDirRelative}/`;
      if (!memberPath.startsWith(prefix)) {
        throw new Error(`Definition member ${memberPath} is outside service directory ${serviceDirRelative}`);
      }
      return memberPath.slice(prefix.length);
    })
  );

  await rm(stageAbsolute, { recursive: true, force: true });
  await mkdir(stageAbsolute, { recursive: true });

  try {
    for (const member of input.members) {
      const memberPath = assertSafeBundleRelativePath(member.path.replace(/\\/g, '/'));
      const prefix = `${serviceDirRelative}/`;
      if (!memberPath.startsWith(prefix)) {
        throw new Error(`Definition member ${memberPath} is outside service directory ${serviceDirRelative}`);
      }
      const relativeInside = memberPath.slice(prefix.length);
      const absolute = path.join(stageAbsolute, relativeInside);
      await write(absolute, member.content);
      await fsyncFile(absolute);
      const written = await readFile(absolute);
      const expectedSha = sha256Utf8(member.content);
      const actualSha = createHash('sha256').update(written).digest('hex');
      if (actualSha !== expectedSha || written.byteLength !== Buffer.byteLength(member.content, 'utf8')) {
        throw new Error(`Staged definition member hash mismatch for ${memberPath}`);
      }
    }

    for (const sidecar of input.sidecars ?? []) {
      const filename = assertSafeBundleRelativePath(sidecar.filename.replace(/\\/g, '/'));
      if (ownedBasenames.has(filename)) {
        throw new Error(`Sidecar ${filename} collides with a definition member`);
      }
      const absolute = path.join(stageAbsolute, filename);
      await write(absolute, sidecar.content);
      await fsyncFile(absolute);
    }

    // Preserve only known non-definition sidecars from the prior canonical tree.
    // Stale definition members absent from the new inventory are dropped.
    if (await pathExists(canonicalAbsolute)) {
      const priorFiles = await listFilesRecursive(canonicalAbsolute);
      for (const priorAbsolute of priorFiles) {
        const relativeInside = path.relative(canonicalAbsolute, priorAbsolute).split(path.sep).join('/');
        if (!relativeInside || relativeInside.split('/').includes('..')) continue;
        if (ownedBasenames.has(relativeInside)) continue;
        if ((input.sidecars ?? []).some((sidecar) => sidecar.filename.replace(/\\/g, '/') === relativeInside)) {
          continue;
        }
        if (!isPreservedNonDefinitionSidecar(relativeInside)) continue;
        const destination = path.join(stageAbsolute, relativeInside);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(priorAbsolute, destination);
        await fsyncFile(destination);
      }
    }

    const hadCanonical = await pathExists(canonicalAbsolute);
    if (hadCanonical) {
      await rename(canonicalAbsolute, backupAbsolute);
    }
    try {
      await rename(stageAbsolute, canonicalAbsolute);
    } catch (error) {
      if (hadCanonical && (await pathExists(backupAbsolute))) {
        await rm(canonicalAbsolute, { recursive: true, force: true });
        await rename(backupAbsolute, canonicalAbsolute);
      }
      throw error;
    }

    // Verify owned members in the canonical tree, then drop backup.
    for (const member of input.members) {
      const memberPath = assertSafeBundleRelativePath(member.path.replace(/\\/g, '/'));
      const absolute = resolvePathWithinRoot(input.repoRoot, memberPath, 'output-dir');
      const written = await readFile(absolute);
      const expectedSha = sha256Utf8(member.content);
      const actualSha = createHash('sha256').update(written).digest('hex');
      if (actualSha !== expectedSha) {
        if (await pathExists(backupAbsolute)) {
          await rm(canonicalAbsolute, { recursive: true, force: true });
          await rename(backupAbsolute, canonicalAbsolute);
        }
        throw new Error(`Canonical definition member hash mismatch for ${memberPath}`);
      }
    }

    await rm(backupAbsolute, { recursive: true, force: true });
    await rm(stageAbsolute, { recursive: true, force: true });
    return { ownedRelativePaths };
  } catch (error) {
    await rm(stageAbsolute, { recursive: true, force: true });
    if (await pathExists(backupAbsolute) && !(await pathExists(canonicalAbsolute))) {
      await rename(backupAbsolute, canonicalAbsolute);
    } else {
      await rm(backupAbsolute, { recursive: true, force: true });
    }
    throw error;
  }
}

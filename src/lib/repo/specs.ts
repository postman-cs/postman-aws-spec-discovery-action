import { lstat, opendir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

import type { GatewayType, SpecFormat } from '../../contracts.js';
import {
  artifactClassRank,
  classifyIacArtifact,
  contentBearingIacCandidates,
  resolveStaticIacCandidates,
  toRepoArtifactClass,
  type IacArtifactClass,
  type ResolveStaticIacOptions,
  type StaticIacResolution
} from '../iac/index.js';
import {
  extractInlineEmbeddedSpec,
  parseCfnTemplateBody,
  type ParsedTemplate,
  type TemplateResource
} from '../providers/cloudformation.js';
import { looksLikeIntrospection, looksLikeWsdl } from '../spec/classify-format.js';
import { resolveLocalReadWithinRoot } from '../utils/resolve-path-within-root.js';
import { groupGraphqlByServiceRoot, serviceRootFor } from './graphql-compose.js';
import { resolveSmithyProject } from './smithy-project.js';

const DIRECT_SPEC_CANDIDATES = [
  'openapi.yaml',
  'openapi.yml',
  'openapi.json',
  'api.yaml',
  'api.yml',
  'api.json',
  'oas.yaml',
  'oas.yml',
  'oas.json',
  'swagger.yaml',
  'swagger.yml',
  'swagger.json',
  'spec/openapi.yaml',
  'spec/openapi.yml',
  'spec/openapi.json',
  'api/openapi.yaml',
  'api/openapi.yml',
  'api/openapi.json',
  'docs/openapi.yaml',
  'docs/openapi.yml',
  'docs/openapi.json',
  'schema.graphql',
  'schema.gql',
  'graphql/schema.graphql',
  'graphql/schema.gql',
  'api/schema.graphql',
  'src/schema.graphql',
  'asyncapi.yaml',
  'asyncapi.yml',
  'asyncapi.json',
  'spec/asyncapi.yaml',
  'spec/asyncapi.yml',
  'spec/asyncapi.json',
  'api/asyncapi.yaml',
  'api/asyncapi.yml',
  'api/asyncapi.json',
  'proto/service.proto',
  'schema.proto',
  'smithy-build.json',
  'schema.json',
  'order.schema.json',
  'schema.avsc',
  'order.avsc',
  'service.wsdl',
  'api.wsdl',
  'mcp.json',
  'server.json',
  'introspection.json'
];

const COMMON_SCAN_DIRS = [
  '.',
  'api',
  'apis',
  'api-docs',
  'docs',
  'reference',
  'public',
  'spec',
  'specs',
  'contracts',
  'events',
  'graphql',
  'proto',
  'protobuf',
  'smithy',
  'model',
  'models',
  'schemas',
  'schema',
  'services',
  'packages',
  'apps',
  'dist',
  'build',
  'generated',
  'cdk.out',
  '.aws-sam'
];

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.terraform',
  'discovered-specs',
  'vendor',
  'test',
  'tests',
  '__pycache__',
  '.venv',
  'venv',
  '.pulumi'
]);

const GENERATED_PATH_RE = /(^|\/)(dist|build|cdk\.out|\.aws-sam|generated|out|target)(\/|$)/i;

export const DEFAULT_INVENTORY_BOUNDS = {
  maxDepth: 6,
  maxFiles: 200,
  maxFileBytes: 1_048_576,
  maxCumulativeBytes: 8_388_608,
  maxScanMs: 5_000,
  /** Finite directory-entry inspection bound for streaming walks. */
  maxInspectedEntries: 5_000
} as const;

export type RepoSpecKind =
  | 'openapi'
  | 'graphql'
  | 'graphql-introspection'
  | 'asyncapi'
  | 'postman-collection'
  | 'protobuf'
  | 'smithy'
  | 'json-schema'
  | 'avro'
  | 'wsdl'
  | 'mcp';

export type RepoSpecArtifactClass = 'authored' | 'generated';

export type RepoSpecInventoryErrorCode =
  | 'malformed-config'
  | 'missing-import'
  | 'cycle'
  | 'path-escape'
  | 'bounds-exceeded'
  | 'unreadable';

export interface RepoSpecInventoryError {
  code: RepoSpecInventoryErrorCode;
  path: string;
  message: string;
}

export interface RepoSpecCandidate {
  path: string;
  type: RepoSpecKind;
  format?: SpecFormat;
  serviceRoot: string;
  artifactClass: RepoSpecArtifactClass;
  evidence: string[];
  /** Ambiguity-relevant rank (1 = highest). */
  rank: number;
  /** Internal ranking score (higher is better). */
  score: number;
  /** Aggregated model content for multi-file Smithy/GraphQL candidates. */
  content?: string;
  memberPaths?: string[];
  projections?: string[];
}

export interface RepoSpecInventory {
  candidates: RepoSpecCandidate[];
  errors: RepoSpecInventoryError[];
}

/**
 * Narrow static-IaC options threaded from runtime (no hidden globals / cross-run cache).
 * `resolveStaticIac` is a run-scoped lazy memoized resolver shared by inventory + signals.
 */
export type InventoryStaticIacOptions = Pick<ResolveStaticIacOptions, 's3Client' | 'terraformStatePaths'> & {
  /** Creates at most one Promise on first call; subsequent callers await the same result. */
  resolveStaticIac?: () => Promise<StaticIacResolution>;
};

export interface InventoryRepoSpecsOptions {
  maxDepth?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxCumulativeBytes?: number;
  maxScanMs?: number;
  /** Finite directory-entry inspection bound for streaming walks. */
  maxInspectedEntries?: number;
  /** Optional monorepo/service scope (relative posix path). */
  serviceRoot?: string;
  /** Optional exact S3 client + explicit Terraform state paths for static IaC merge. */
  staticIac?: InventoryStaticIacOptions;
}

/** Resolve static IaC via lazy shared resolver when present; otherwise compute with caller options. */
async function resolveInventoryStaticIac(
  repoRoot: string,
  budget: ScanBudget,
  staticIac?: InventoryStaticIacOptions
): Promise<StaticIacResolution> {
  if (staticIac?.resolveStaticIac) {
    return staticIac.resolveStaticIac();
  }
  return resolveStaticIacCandidates(repoRoot, {
    maxDepth: budget.maxDepth,
    maxFiles: Math.max(0, budget.maxFiles - budget.files),
    maxFileBytes: budget.maxFileBytes,
    maxCumulativeBytes: Math.max(0, budget.maxCumulativeBytes - budget.cumulativeBytes),
    ...(staticIac?.s3Client ? { s3Client: staticIac.s3Client } : {}),
    ...(staticIac?.terraformStatePaths ? { terraformStatePaths: staticIac.terraformStatePaths } : {})
  });
}

export interface RepoSpecMatch {
  path: string;
  type: RepoSpecKind;
  format?: SpecFormat;
  evidence?: string[];
  content?: string;
  serviceRoot?: string;
  artifactClass?: RepoSpecArtifactClass;
  memberPaths?: string[];
}

interface ScanBudget {
  files: number;
  cumulativeBytes: number;
  inspectedEntries: number;
  maxFiles: number;
  maxFileBytes: number;
  maxCumulativeBytes: number;
  maxDepth: number;
  maxInspectedEntries: number;
  deadlineAt: number;
  truncated: boolean;
}

function scanTimedOut(budget: ScanBudget): boolean {
  if (Date.now() <= budget.deadlineAt) return false;
  budget.truncated = true;
  return true;
}

interface RawCandidate {
  path: string;
  type: RepoSpecKind;
  format?: SpecFormat;
  serviceRoot: string;
  artifactClass: RepoSpecArtifactClass;
  evidence: string[];
  score: number;
  content?: string;
  memberPaths?: string[];
  projections?: string[];
}

function isLikelyOpenApiDocument(content: string): boolean {
  try {
    const parsed = content.trim().startsWith('{') ? JSON.parse(content) : parse(content);
    if (!parsed || typeof parsed !== 'object') {
      return false;
    }
    return Boolean((parsed as Record<string, unknown>).openapi || (parsed as Record<string, unknown>).swagger);
  } catch {
    return false;
  }
}

function isLikelyGraphqlSchema(content: string): boolean {
  const trimmed = content.trim();
  return /\btype\s+Query\b/.test(trimmed)
    || /\btype\s+Mutation\b/.test(trimmed)
    || /\btype\s+Subscription\b/.test(trimmed)
    || /\bschema\s*\{/.test(trimmed)
    // Type-only/partial SDL files are valid members of a multi-file service group.
    || /\b(type|input|interface|enum|union|scalar)\s+[A-Za-z_]/.test(trimmed);
}

function isLikelyAsyncApiDocument(content: string): boolean {
  try {
    const parsed = content.trim().startsWith('{') ? JSON.parse(content) : parse(content);
    if (!parsed || typeof parsed !== 'object') {
      return false;
    }
    return Boolean((parsed as Record<string, unknown>).asyncapi);
  } catch {
    return false;
  }
}

function isLikelyPostmanCollection(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { info?: { schema?: string; name?: string } };
    return Boolean(parsed.info?.schema?.includes('schema.getpostman.com/json/collection') || parsed.info?.name);
  } catch {
    return false;
  }
}

function isLikelyProtobuf(content: string): boolean {
  return /^\s*syntax\s*=\s*["']proto[23]["']\s*;/m.test(content) || /\b(service|message)\s+\w+\s*\{/.test(content);
}

function isLikelySmithyModel(content: string): boolean {
  return /^\s*\$version:\s*["']2(?:\.\d+)?["']/m.test(content) || /\b(namespace|service|structure)\s+[\w#.]+/.test(content);
}

function isLikelyJsonSchema(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    if (parsed.openapi || parsed.swagger || parsed.asyncapi) return false;
    // Introspection / MCP are distinct families; never classify as JSON Schema.
    if (looksLikeIntrospection(parsed) || isLikelyMcpDocument(parsed)) return false;
    if (typeof parsed.$schema === 'string' && /json-schema/i.test(parsed.$schema)) return true;
    if (typeof parsed.$id === 'string' && (parsed.type || parsed.properties || parsed.$defs || parsed.definitions)) return true;
    if (parsed.type === 'object' && (parsed.properties || parsed.required || parsed.$defs || parsed.definitions)) return true;
    if (parsed.$defs || parsed.definitions) return true;
    return false;
  } catch {
    return false;
  }
}

function isLikelyGraphqlIntrospection(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return looksLikeIntrospection(parsed as Record<string, unknown>);
  } catch {
    return false;
  }
}

/**
 * Conservative WSDL 1.1 / 2.0 detection (bootstrap-aligned):
 * root element definitions|description plus a WSDL namespace or wsdl token.
 * Arbitrary XML without WSDL markers is rejected.
 */
/**
 * Conservative MCP detection matching bootstrap:
 * mcpServers object, modelcontextprotocol $schema, or registry name + remotes/packages.
 */
function isLikelyMcpDocument(parsed: Record<string, unknown>): boolean {
  if (parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)) {
    return true;
  }
  if (typeof parsed.$schema === 'string' && /modelcontextprotocol/i.test(parsed.$schema)) {
    return true;
  }
  return typeof parsed.name === 'string'
    && (Array.isArray(parsed.remotes) || Array.isArray(parsed.packages));
}

function isLikelyMcpContent(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return isLikelyMcpDocument(parsed as Record<string, unknown>);
  } catch {
    return false;
  }
}

function isMcpConfigBasename(basename: string): boolean {
  return basename === 'mcp.json' || basename === 'server.json';
}

function isLikelyAvro(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    if (parsed.type === 'record' && Array.isArray(parsed.fields) && typeof parsed.name === 'string') return true;
    if (parsed.type === 'enum' && Array.isArray(parsed.symbols) && typeof parsed.name === 'string') return true;
    if (parsed.type === 'fixed' && typeof parsed.size === 'number' && typeof parsed.name === 'string') return true;
    return false;
  } catch {
    return false;
  }
}

function formatFor(type: RepoSpecKind, candidate: string): SpecFormat | undefined {
  switch (type) {
    case 'openapi':
      return candidate.endsWith('.json') ? 'openapi-json' : 'openapi-yaml';
    case 'graphql':
      return 'graphql-sdl';
    case 'graphql-introspection':
      return 'graphql-introspection-json';
    case 'asyncapi':
      return candidate.endsWith('.json') ? 'asyncapi-json' : 'asyncapi-yaml';
    case 'postman-collection':
      return 'postman-collection';
    case 'protobuf':
      return 'protobuf';
    case 'smithy':
      return 'smithy';
    case 'json-schema':
      return 'json-schema';
    case 'avro':
      return 'avro';
    case 'wsdl':
      return 'wsdl';
    case 'mcp':
      return 'mcp-json';
  }
}

function artifactClassFor(relativePath: string): RepoSpecArtifactClass {
  return GENERATED_PATH_RE.test(toPosix(relativePath)) ? 'generated' : 'authored';
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function isPathInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function isRegularNonSymlinkFile(absolutePath: string): Promise<boolean> {
  try {
    const link = await lstat(absolutePath);
    if (link.isSymbolicLink()) {
      return false;
    }
    return link.isFile();
  } catch {
    return false;
  }
}

function detectRepoSpec(candidate: string, content: string): Omit<RepoSpecMatch, 'path' | 'evidence'> | undefined {
  const normalized = toPosix(candidate).toLowerCase();
  const basename = path.posix.basename(normalized);
  let type: RepoSpecKind | undefined;

  if ((basename.endsWith('.graphql') || basename.endsWith('.gql')) && isLikelyGraphqlSchema(content)) {
    type = 'graphql';
  } else if (basename === 'asyncapi.yaml' || basename === 'asyncapi.yml' || basename === 'asyncapi.json') {
    if (isLikelyAsyncApiDocument(content)) type = 'asyncapi';
  } else if (basename.endsWith('.postman_collection.json')) {
    if (isLikelyPostmanCollection(content)) type = 'postman-collection';
  } else if (basename.endsWith('.proto')) {
    if (isLikelyProtobuf(content)) type = 'protobuf';
  } else if (basename.endsWith('.smithy')) {
    if (isLikelySmithyModel(content)) type = 'smithy';
  } else if (basename === 'smithy-build.json') {
    // Inventory resolves project closure separately; never treat JSON config as model.
    return undefined;
  } else if (basename.endsWith('.wsdl')) {
    if (looksLikeWsdl(content)) type = 'wsdl';
  } else if (isMcpConfigBasename(basename)) {
    // mcp.json / server.json only when content validates as MCP (no name-only acceptance).
    if (isLikelyMcpContent(content)) type = 'mcp';
  } else if (basename.endsWith('.avsc') || basename.endsWith('.avro')) {
    if (isLikelyAvro(content)) type = 'avro';
  } else if (
    basename === 'introspection.json'
    || (basename.endsWith('.json')
      && !basename.endsWith('.postman_collection.json')
      && !isMcpConfigBasename(basename)
      && isLikelyGraphqlIntrospection(content))
  ) {
    // GraphQL introspection must win over generic JSON Schema / OpenAPI JSON.
    if (isLikelyGraphqlIntrospection(content)) type = 'graphql-introspection';
  } else if (
    basename === 'schema.json'
    || basename.endsWith('.schema.json')
    || (basename.endsWith('.json') && !basename.endsWith('.postman_collection.json') && isLikelyJsonSchema(content))
  ) {
    if (isLikelyJsonSchema(content)) type = 'json-schema';
  } else if (isLikelyOpenApiDocument(content)) {
    type = 'openapi';
  } else if (isLikelyAsyncApiDocument(content)) {
    type = 'asyncapi';
  } else if (isLikelyAvro(content)) {
    type = 'avro';
  } else if (isLikelyJsonSchema(content)) {
    type = 'json-schema';
  }

  return type ? { type, format: formatFor(type, normalized) } : undefined;
}

function isSpecLikeFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  return (
    /^(openapi|swagger|api|oas)(?:[.-]v?\d+(?:\.\d+)*)?\.(?:ya?ml|json)$/.test(lower)
    || lower === 'asyncapi.yaml'
    || lower === 'asyncapi.yml'
    || lower === 'asyncapi.json'
    || lower.endsWith('.graphql')
    || lower.endsWith('.gql')
    || lower.endsWith('.postman_collection.json')
    || lower.endsWith('.proto')
    || lower.endsWith('.smithy')
    || lower === 'smithy-build.json'
    || lower === 'schema.json'
    || lower.endsWith('.schema.json')
    || lower.endsWith('.avsc')
    || lower.endsWith('.avro')
    || lower.endsWith('.wsdl')
    || lower === 'mcp.json'
    || lower === 'server.json'
    || lower === 'introspection.json'
  );
}

function specCandidateScore(candidate: string, type: RepoSpecKind, artifactClass: RepoSpecArtifactClass): number {
  const normalized = toPosix(candidate).toLowerCase();
  const basename = path.posix.basename(normalized);
  let score = 0;
  if (artifactClass === 'authored') score += 500;
  if (DIRECT_SPEC_CANDIDATES.includes(normalized) && basename !== 'smithy-build.json') score += 200;
  if (type === 'openapi' || /^(openapi|swagger)(?:[.-]v?\d+(?:\.\d+)*)?\.(?:ya?ml|json)$/.test(basename)) score += 90;
  if (/^(api|oas)(?:[.-]v?\d+(?:\.\d+)*)?\.(?:ya?ml|json)$/.test(basename)) score += 85;
  if (type === 'asyncapi' || basename.startsWith('asyncapi')) score += 80;
  if (type === 'graphql' || basename === 'schema.graphql' || basename === 'schema.gql') score += 75;
  if (type === 'smithy' && basename === 'smithy-build.json') score += 95;
  if (type === 'smithy' && basename.endsWith('.smithy')) score += 70;
  if (type === 'wsdl' || basename.endsWith('.wsdl')) score += 70;
  if (type === 'graphql-introspection' || basename === 'introspection.json') score += 68;
  if (type === 'json-schema' || basename === 'schema.json' || basename.endsWith('.schema.json')) score += 65;
  if (type === 'mcp' || basename === 'mcp.json' || basename === 'server.json') score += 62;
  if (type === 'avro' || basename.endsWith('.avsc') || basename.endsWith('.avro')) score += 60;
  if (type === 'postman-collection' || basename.endsWith('.postman_collection.json')) score += 55;
  if (type === 'protobuf' || basename.endsWith('.proto')) score += 50;
  if (/^(api|apis|spec|specs|contracts|events|graphql|proto|smithy|model|models|schemas|schema|reference|public)\//.test(normalized)) score += 20;
  if (/^(services|packages|apps)\/[^/]+\//.test(normalized)) score += 15;
  if (artifactClass === 'generated') score -= 400;
  return score;
}

/**
 * Bounded deterministic repository contract inventory.
 * Returns ranked candidates with service-root / artifact-class metadata and a clean error contract.
 */
export async function inventoryRepoSpecs(
  repoRoot: string,
  options: InventoryRepoSpecsOptions = {}
): Promise<RepoSpecInventory> {
  const resolvedRoot = path.resolve(repoRoot);
  const budget: ScanBudget = {
    files: 0,
    cumulativeBytes: 0,
    inspectedEntries: 0,
    maxFiles: options.maxFiles ?? DEFAULT_INVENTORY_BOUNDS.maxFiles,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_INVENTORY_BOUNDS.maxFileBytes,
    maxCumulativeBytes: options.maxCumulativeBytes ?? DEFAULT_INVENTORY_BOUNDS.maxCumulativeBytes,
    maxDepth: options.maxDepth ?? DEFAULT_INVENTORY_BOUNDS.maxDepth,
    maxInspectedEntries: options.maxInspectedEntries ?? DEFAULT_INVENTORY_BOUNDS.maxInspectedEntries,
    deadlineAt: Date.now() + (options.maxScanMs ?? DEFAULT_INVENTORY_BOUNDS.maxScanMs),
    truncated: false
  };
  const errors: RepoSpecInventoryError[] = [];
  const scopeRoot = options.serviceRoot ? toPosix(options.serviceRoot) : undefined;

  const pathCandidates = await collectSpecCandidatePaths(resolvedRoot, budget, errors);
  const scopedPaths = scopeRoot
    ? pathCandidates.filter((candidate) => {
      const posix = toPosix(candidate);
      return posix === scopeRoot
        || posix.startsWith(`${scopeRoot}/`)
        || serviceRootFor(posix) === scopeRoot;
    })
    : pathCandidates;

  const smithyBuildPaths = scopedPaths.filter((candidate) => path.posix.basename(toPosix(candidate)).toLowerCase() === 'smithy-build.json');
  const smithyMemberPaths = new Set<string>();
  const raw: RawCandidate[] = [];

  for (const buildPath of smithyBuildPaths.sort((a, b) => a.localeCompare(b))) {
    const closure = await resolveSmithyProject(resolvedRoot, buildPath, {
      maxFiles: budget.maxFiles,
      maxFileBytes: budget.maxFileBytes,
      maxCumulativeBytes: budget.maxCumulativeBytes,
      maxDepth: budget.maxDepth
    });
    for (const error of closure.errors) {
      errors.push(error);
    }
    for (const member of closure.memberPaths) {
      smithyMemberPaths.add(member);
    }
    if (closure.errors.length > 0 || closure.memberPaths.length === 0 || !closure.content.trim()) {
      continue;
    }
    const artifactClass = artifactClassFor(buildPath);
    raw.push({
      path: toPosix(buildPath),
      type: 'smithy',
      format: 'smithy',
      serviceRoot: serviceRootFor(buildPath),
      artifactClass,
      evidence: closure.evidence,
      score: specCandidateScore(buildPath, 'smithy', artifactClass),
      content: closure.content,
      memberPaths: closure.memberPaths,
      projections: closure.projections
    });
  }

  const graphqlFiles: { path: string; content: string }[] = [];
  const singleFileCandidates: RawCandidate[] = [];

  for (const candidate of scopedPaths.sort((a, b) => a.localeCompare(b))) {
    const relative = toPosix(candidate);
    const basename = path.posix.basename(relative).toLowerCase();
    if (basename === 'smithy-build.json') continue;
    if (relative.endsWith('.smithy') && smithyMemberPaths.has(relative)) continue;

    const absolute = path.resolve(resolvedRoot, relative);
    if (!isPathInsideRoot(resolvedRoot, absolute)) {
      errors.push({
        code: 'path-escape',
        path: relative,
        message: `Candidate path escapes repository root: ${relative}`
      });
      continue;
    }
    if (!(await isRegularNonSymlinkFile(absolute))) {
      continue;
    }

    const content = await readBoundedFile(resolvedRoot, relative, budget, errors);
    if (content === undefined) continue;

    const detected = detectRepoSpec(relative, content);
    if (!detected) continue;

    if (detected.type === 'graphql') {
      graphqlFiles.push({ path: relative, content });
      continue;
    }

    const artifactClass = artifactClassFor(relative);
    singleFileCandidates.push({
      path: relative,
      type: detected.type,
      format: detected.format,
      serviceRoot: serviceRootFor(relative),
      artifactClass,
      evidence: [`Resolved from repository specification ${relative}`],
      score: specCandidateScore(relative, detected.type, artifactClass),
      content
    });
  }

  for (const group of groupGraphqlByServiceRoot(graphqlFiles)) {
    if (scopeRoot && group.serviceRoot !== scopeRoot && group.serviceRoot !== '.') {
      // Still include groups whose files matched scoped filter above.
    }
    const artifactClass = group.memberPaths.every((member) => artifactClassFor(member) === 'generated')
      ? 'generated'
      : 'authored';
    raw.push({
      path: group.path,
      type: 'graphql',
      format: 'graphql-sdl',
      serviceRoot: group.serviceRoot,
      artifactClass,
      evidence: group.evidence,
      score: specCandidateScore(group.path, 'graphql', artifactClass) + (group.memberPaths.length > 1 ? 10 : 0),
      content: group.content,
      memberPaths: group.memberPaths
    });
  }

  raw.push(...singleFileCandidates);

  // Integrate static IaC OpenAPI candidates (generated/local) without changing public inventory shape.
  // Generated classes stay below authored via scoring; content is never invented from route hints.
  try {
    const iacResolution = await resolveInventoryStaticIac(resolvedRoot, budget, options.staticIac);
    for (const error of iacResolution.errors) {
      if (error.code === 'path-escape' || error.code === 'bounds-exceeded') {
        errors.push({
          code: error.code === 'path-escape' ? 'path-escape' : 'bounds-exceeded',
          path: error.path,
          message: error.message
        });
      }
    }
    const existingPaths = new Set(raw.map((candidate) => candidate.path));
    for (const iac of contentBearingIacCandidates(iacResolution)) {
      if (!iac.content || !iac.sourcePath) continue;
      // Generated build artifacts (cdk.out / .aws-sam / .serverless) stay out of
      // repo-spec inventory so runtime continues to use findLocalCfnArtifactSpecs
      // (cfn-embedded / manual-review). Only authored static IaC merges here.
      if (iac.artifactClass !== 'authored') continue;
      if (scopeRoot) {
        const posix = toPosix(iac.sourcePath);
        if (
          posix !== scopeRoot
          && !posix.startsWith(`${scopeRoot}/`)
          && serviceRootFor(posix) !== scopeRoot
        ) {
          continue;
        }
      }
      const inventoryPath = toPosix(iac.sourcePath);
      if (existingPaths.has(inventoryPath)) continue;
      const artifactClass = toRepoArtifactClass(iac.artifactClass);
      raw.push({
        path: inventoryPath,
        type: 'openapi',
        format: iac.format ?? 'openapi-json',
        serviceRoot: serviceRootFor(inventoryPath),
        artifactClass,
        evidence: [
          ...iac.evidence,
          `Static IaC ${iac.source}/${iac.kind} (${iac.artifactClass})`
        ],
        score: specCandidateScore(inventoryPath, 'openapi', artifactClass),
        content: iac.content
      });
      existingPaths.add(inventoryPath);
    }
  } catch {
    // Static IaC integration must not break authored inventory.
  }

  const sorted = raw.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.artifactClass !== right.artifactClass) {
      return left.artifactClass === 'authored' ? -1 : 1;
    }
    return left.path.localeCompare(right.path);
  });

  const candidates: RepoSpecCandidate[] = sorted.map((candidate, index) => ({
    ...candidate,
    rank: index + 1
  }));

  if (budget.truncated) {
    errors.push({
      code: 'bounds-exceeded',
      path: scopeRoot ?? '.',
      message: `Repository spec scan truncated at maxFiles=${budget.maxFiles}, maxDepth=${budget.maxDepth}, maxInspectedEntries=${budget.maxInspectedEntries}, maxCumulativeBytes=${budget.maxCumulativeBytes}`
    });
  }

  return { candidates, errors };
}

async function readBoundedFile(
  repoRoot: string,
  relative: string,
  budget: ScanBudget,
  errors: RepoSpecInventoryError[]
): Promise<string | undefined> {
  if (scanTimedOut(budget)) return undefined;
  let content: string;
  try {
    const resolved = await resolveLocalReadWithinRoot(repoRoot, relative, {
      fieldName: 'repo-spec-candidate',
      limits: { maxBytesPerFile: budget.maxFileBytes }
    });
    content = await readFile(resolved.canonicalPath, 'utf8');
  } catch (error) {
    errors.push({
      code: 'unreadable',
      path: relative,
      message: `Failed to read candidate: ${error instanceof Error ? error.message : String(error)}`
    });
    return undefined;
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > budget.maxFileBytes) {
    errors.push({
      code: 'bounds-exceeded',
      path: relative,
      message: `Candidate exceeds maxFileBytes=${budget.maxFileBytes}`
    });
    return undefined;
  }
  if (budget.cumulativeBytes + bytes > budget.maxCumulativeBytes) {
    budget.truncated = true;
    errors.push({
      code: 'bounds-exceeded',
      path: relative,
      message: `Scan exceeds maxCumulativeBytes=${budget.maxCumulativeBytes}`
    });
    return undefined;
  }
  budget.cumulativeBytes += bytes;
  return content;
}

async function collectSpecCandidatePaths(
  repoRoot: string,
  budget: ScanBudget,
  errors: RepoSpecInventoryError[]
): Promise<string[]> {
  const candidates = new Set<string>();
  for (const candidate of DIRECT_SPEC_CANDIDATES) {
    candidates.add(candidate);
  }

  for (const dir of COMMON_SCAN_DIRS) {
    if (scanTimedOut(budget)) break;
    if (budget.files >= budget.maxFiles || budget.inspectedEntries >= budget.maxInspectedEntries) {
      budget.truncated = true;
      break;
    }
    const root = path.resolve(repoRoot, dir);
    if (!isPathInsideRoot(repoRoot, root)) {
      errors.push({
        code: 'path-escape',
        path: dir,
        message: `Scan directory escapes repository root: ${dir}`
      });
      continue;
    }
    const fileStat = await lstat(root).catch(() => undefined);
    if (!fileStat) continue;
    if (fileStat.isSymbolicLink()) {
      errors.push({
        code: 'path-escape',
        path: dir,
        message: `Scan directory must not be a symbolic link: ${dir}`
      });
      continue;
    }
    if (fileStat.isFile()) {
      const relative = toPosix(path.relative(repoRoot, root));
      if (isSpecLikeFilename(path.basename(relative))) {
        candidates.add(relative);
      }
      continue;
    }
    if (!fileStat.isDirectory()) continue;
    for (const file of await walkSpecCandidates(repoRoot, root, budget, 0)) {
      candidates.add(file);
    }
  }

  return [...candidates].map(toPosix).sort((a, b) => a.localeCompare(b));
}

async function walkSpecCandidates(
  repoRoot: string,
  current: string,
  budget: ScanBudget,
  depth: number
): Promise<string[]> {
  if (
    scanTimedOut(budget)
    || depth > budget.maxDepth
    || budget.files >= budget.maxFiles
    || budget.inspectedEntries >= budget.maxInspectedEntries
  ) {
    if (
      budget.files >= budget.maxFiles
      || depth > budget.maxDepth
      || budget.inspectedEntries >= budget.maxInspectedEntries
    ) {
      budget.truncated = true;
    }
    return [];
  }
  const results: string[] = [];
  let directory;
  try {
    directory = await opendir(current);
  } catch {
    return [];
  }
  // Stream entries; do not materialize/sort the full directory listing.
  // Final candidates remain sorted at collectSpecCandidatePaths return time.
  for await (const dirent of directory) {
    if (scanTimedOut(budget)) break;
    if (budget.files >= budget.maxFiles || budget.inspectedEntries >= budget.maxInspectedEntries) {
      budget.truncated = true;
      break;
    }
    // Count every directory entry, including irrelevant files and skipped dirs.
    budget.inspectedEntries += 1;
    const entry = dirent.name;
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = path.join(current, entry);
    if (!isPathInsideRoot(repoRoot, fullPath)) {
      continue;
    }
    const info = await lstat(fullPath).catch(() => undefined);
    if (!info || info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      results.push(...await walkSpecCandidates(repoRoot, fullPath, budget, depth + 1));
      continue;
    }
    if (info.isFile() && isSpecLikeFilename(entry)) {
      budget.files += 1;
      results.push(toPosix(path.relative(repoRoot, fullPath)));
    }
  }
  return results;
}

export async function findExistingRepoSpec(repoRoot: string): Promise<string | undefined> {
  const match = await findExistingRepoSpecTyped(repoRoot);
  return match?.path;
}

/**
 * Compatibility wrapper over {@link inventoryRepoSpecs}: returns the top-ranked candidate.
 * Prefer inventoryRepoSpecs for ambiguity-safe selection.
 */
export async function findExistingRepoSpecTyped(repoRoot: string): Promise<RepoSpecMatch | undefined> {
  const inventory = await inventoryRepoSpecs(repoRoot);
  const top = inventory.candidates[0];
  if (!top) return undefined;
  return {
    path: top.path,
    type: top.type,
    format: top.format,
    evidence: top.evidence,
    content: top.content,
    serviceRoot: top.serviceRoot,
    artifactClass: top.artifactClass,
    memberPaths: top.memberPaths
  };
}

const CFN_ARTIFACT_API_TYPES: Record<string, GatewayType> = {
  'AWS::ApiGateway::RestApi': 'REST',
  'AWS::Serverless::Api': 'REST',
  'AWS::ApiGatewayV2::Api': 'HTTP',
  'AWS::Serverless::HttpApi': 'HTTP'
};

/** Finite CDK assembly template enumeration for local build-artifact fallback. */
const MAX_LOCAL_CDK_OUT_TEMPLATES = 40;
/** Cap how many cdk.out directory entries are inspected via streaming opendir. */
const MAX_LOCAL_CDK_OUT_ENTRIES = 256;

export interface LocalCfnArtifactSpec {
  /** Relative artifact path plus `#` plus logical ID. */
  artifactRef: string;
  /** Relative template path under repoRoot (posix separators). */
  artifactPath: string;
  logicalId: string;
  gatewayType: GatewayType;
  content: string;
  format: SpecFormat;
  filename: string;
  /** Freshness / authorship class from {@link classifyIacArtifact}. */
  artifactClass: IacArtifactClass;
}

/**
 * Inspect only synthesized CDK templates (`cdk.out/*.template.json`) and the SAM build
 * template (`.aws-sam/build/template.yaml`) for inline OpenAPI documents embedded in API
 * resources. Local-only: no AWS calls, no S3/HTTP fetches, no recursive scanning.
 * Results are ranked by artifactClassRank (fresh before unknown/stale) then lexical path/id.
 */
export async function findLocalCfnArtifactSpecs(repoRoot: string): Promise<LocalCfnArtifactSpec[]> {
  const resolvedRoot = path.resolve(repoRoot);
  const artifactPaths: string[] = [];

  const cdkOutDir = path.join(resolvedRoot, 'cdk.out');
  try {
    const cdkLink = await lstat(cdkOutDir);
    if (!cdkLink.isSymbolicLink() && cdkLink.isDirectory()) {
      const templateNames: string[] = [];
      let inspected = 0;
      const directory = await opendir(cdkOutDir);
      for await (const dirent of directory) {
        if (inspected >= MAX_LOCAL_CDK_OUT_ENTRIES) {
          break;
        }
        inspected += 1;
        if (!dirent.name.endsWith('.template.json')) {
          continue;
        }
        templateNames.push(dirent.name);
      }
      for (const entry of templateNames.sort((a, b) => a.localeCompare(b)).slice(0, MAX_LOCAL_CDK_OUT_TEMPLATES)) {
        artifactPaths.push(path.posix.join('cdk.out', entry));
      }
    }
  } catch {
    // cdk.out absent -- silent
  }

  const samTemplate = path.posix.join('.aws-sam', 'build', 'template.yaml');
  if (await isRegularNonSymlinkFile(path.join(resolvedRoot, samTemplate))) {
    artifactPaths.push(samTemplate);
  }

  const specs: LocalCfnArtifactSpec[] = [];
  for (const artifactPath of artifactPaths.sort((a, b) => a.localeCompare(b))) {
    const absolutePath = path.join(resolvedRoot, artifactPath);
    if (!absolutePath.startsWith(resolvedRoot + path.sep)) {
      continue;
    }
    if (!(await isRegularNonSymlinkFile(absolutePath))) {
      continue;
    }
    let template: ParsedTemplate;
    try {
      template = parseCfnTemplateBody(await readFile(absolutePath, 'utf8'));
    } catch {
      continue;
    }
    const resources = template?.Resources;
    if (!resources || typeof resources !== 'object') {
      continue;
    }
    const artifactClass = await classifyIacArtifact(resolvedRoot, artifactPath);
    for (const logicalId of Object.keys(resources).sort((a, b) => a.localeCompare(b))) {
      const resource = resources[logicalId] as TemplateResource | undefined;
      const gatewayType = resource?.Type ? CFN_ARTIFACT_API_TYPES[resource.Type] : undefined;
      if (!resource || !gatewayType) {
        continue;
      }
      const extracted = extractInlineEmbeddedSpec(resource);
      if (!extracted) {
        continue;
      }
      specs.push({
        artifactRef: `${artifactPath}#${logicalId}`,
        artifactPath,
        logicalId,
        gatewayType,
        content: extracted.content,
        format: extracted.format,
        filename: extracted.filename,
        artifactClass
      });
    }
  }

  return specs.sort((left, right) => {
    const classDelta = artifactClassRank(right.artifactClass) - artifactClassRank(left.artifactClass);
    if (classDelta !== 0) return classDelta;
    const pathDelta = left.artifactPath.localeCompare(right.artifactPath);
    if (pathDelta !== 0) return pathDelta;
    return left.logicalId.localeCompare(right.logicalId);
  });
}

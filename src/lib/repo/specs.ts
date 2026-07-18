import { readdir, readFile, lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

import type { GatewayType, SpecFormat } from '../../contracts.js';
import {
  extractInlineEmbeddedSpec,
  parseCfnTemplateBody,
  type ParsedTemplate,
  type TemplateResource
} from '../providers/cloudformation.js';

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
  'smithy-build.json'
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
  'services',
  'packages',
  'apps'
];

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.terraform',
  'dist',
  'build',
  'discovered-specs',
  'vendor',
  'test',
  'tests',
  '__pycache__',
  '.venv',
  'venv',
  '.pulumi'
]);

const MAX_SPEC_SCAN_FILES = 200;
const MAX_SPEC_SCAN_DEPTH = 6;

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
  return /\btype\s+Query\b/.test(trimmed) || /\bschema\s*\{/.test(trimmed);
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

function isLikelySmithy(content: string, filename: string): boolean {
  if (filename.endsWith('smithy-build.json')) {
    try {
      const parsed = JSON.parse(content);
      return Boolean(parsed && typeof parsed === 'object');
    } catch {
      return false;
    }
  }
  return /^\s*\$version:\s*["']2(?:\.\d+)?["']/m.test(content) || /\b(namespace|service|structure)\s+[\w#.]+/.test(content);
}

function formatFor(type: RepoSpecMatch['type'], candidate: string): SpecFormat | undefined {
  switch (type) {
    case 'openapi':
      return candidate.endsWith('.json') ? 'openapi-json' : 'openapi-yaml';
    case 'graphql':
      return 'graphql-sdl';
    case 'asyncapi':
      return candidate.endsWith('.json') ? 'asyncapi-json' : 'asyncapi-yaml';
    case 'postman-collection':
      return 'postman-collection';
    case 'protobuf':
      return 'protobuf';
    case 'smithy':
      return 'smithy';
  }
}

export interface RepoSpecMatch {
  path: string;
  type: 'openapi' | 'graphql' | 'asyncapi' | 'postman-collection' | 'protobuf' | 'smithy';
  format?: SpecFormat;
  evidence?: string[];
}

export async function findExistingRepoSpec(repoRoot: string): Promise<string | undefined> {
  const match = await findExistingRepoSpecTyped(repoRoot);
  return match?.path;
}

export async function findExistingRepoSpecTyped(repoRoot: string): Promise<RepoSpecMatch | undefined> {
  const candidates = await collectSpecCandidates(repoRoot);
  for (const candidate of candidates) {
    const fullPath = path.resolve(repoRoot, candidate);
    try {
      const fileStat = await stat(fullPath);
      if (!fileStat.isFile()) {
        continue;
      }
      const content = await readFile(fullPath, 'utf8');
      const match = detectRepoSpec(candidate, content);
      if (match) {
        return {
          ...match,
          path: candidate.replace(/\\/g, '/'),
          evidence: [`Resolved from repository specification ${candidate.replace(/\\/g, '/')}`]
        };
      }
    } catch {
      // Continue search.
    }
  }

  return undefined;
}

function detectRepoSpec(candidate: string, content: string): Omit<RepoSpecMatch, 'path' | 'evidence'> | undefined {
  const normalized = candidate.replace(/\\/g, '/').toLowerCase();
  const basename = path.basename(normalized);
  let type: RepoSpecMatch['type'] | undefined;

  if ((basename.endsWith('.graphql') || basename.endsWith('.gql')) && isLikelyGraphqlSchema(content)) {
    type = 'graphql';
  } else if (basename === 'asyncapi.yaml' || basename === 'asyncapi.yml' || basename === 'asyncapi.json') {
    if (isLikelyAsyncApiDocument(content)) type = 'asyncapi';
  } else if (basename.endsWith('.postman_collection.json')) {
    if (isLikelyPostmanCollection(content)) type = 'postman-collection';
  } else if (basename.endsWith('.proto')) {
    if (isLikelyProtobuf(content)) type = 'protobuf';
  } else if (basename.endsWith('.smithy') || basename === 'smithy-build.json') {
    if (isLikelySmithy(content, basename)) type = 'smithy';
  } else if (isLikelyOpenApiDocument(content)) {
    type = 'openapi';
  } else if (isLikelyAsyncApiDocument(content)) {
    type = 'asyncapi';
  }

  return type ? { type, format: formatFor(type, normalized) } : undefined;
}

function isSpecLikeFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  return (
    /^(openapi|swagger|api|oas)(?:[.-]v?\d+(?:\.\d+)*)?\.(?:ya?ml|json)$/.test(lower) ||
    lower === 'asyncapi.yaml' ||
    lower === 'asyncapi.yml' ||
    lower === 'asyncapi.json' ||
    lower === 'schema.graphql' ||
    lower === 'schema.gql' ||
    lower.endsWith('.postman_collection.json') ||
    lower.endsWith('.proto') ||
    lower.endsWith('.smithy') ||
    lower === 'smithy-build.json'
  );
}

async function collectSpecCandidates(repoRoot: string): Promise<string[]> {
  const candidates = new Set<string>();
  for (const candidate of DIRECT_SPEC_CANDIDATES) {
    candidates.add(candidate);
  }

  const count = { value: 0 };
  for (const dir of COMMON_SCAN_DIRS) {
    const root = path.resolve(repoRoot, dir);
    const fileStat = await stat(root).catch(() => undefined);
    if (!fileStat) continue;
    if (fileStat.isFile()) {
      const relative = path.relative(repoRoot, root);
      if (isSpecLikeFilename(path.basename(relative))) {
        candidates.add(relative);
      }
      continue;
    }
    if (!fileStat.isDirectory()) continue;
    for (const file of await walkSpecCandidates(repoRoot, root, count)) {
      candidates.add(file);
    }
    if (count.value >= MAX_SPEC_SCAN_FILES) break;
  }

  return [...candidates].sort((left, right) => specCandidateScore(right) - specCandidateScore(left) || left.localeCompare(right));
}

async function walkSpecCandidates(repoRoot: string, current: string, count: { value: number }, depth = 0): Promise<string[]> {
  if (depth > MAX_SPEC_SCAN_DEPTH || count.value >= MAX_SPEC_SCAN_FILES) return [];
  const results: string[] = [];
  const entries = await readdir(current).catch(() => [] as string[]);
  for (const entry of entries) {
    if (count.value >= MAX_SPEC_SCAN_FILES) break;
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = path.join(current, entry);
    const info = await stat(fullPath).catch(() => undefined);
    if (!info) continue;
    if (info.isDirectory()) {
      results.push(...await walkSpecCandidates(repoRoot, fullPath, count, depth + 1));
      continue;
    }
    if (info.isFile() && isSpecLikeFilename(entry)) {
      count.value += 1;
      results.push(path.relative(repoRoot, fullPath));
    }
  }
  return results;
}

function specCandidateScore(candidate: string): number {
  const normalized = candidate.replace(/\\/g, '/').toLowerCase();
  const basename = path.basename(normalized);
  let score = 0;
  if (DIRECT_SPEC_CANDIDATES.includes(normalized) && basename !== 'smithy-build.json') score += 200;
  if (/^(openapi|swagger)(?:[.-]v?\d+(?:\.\d+)*)?\.(?:ya?ml|json)$/.test(basename)) score += 90;
  if (/^(api|oas)(?:[.-]v?\d+(?:\.\d+)*)?\.(?:ya?ml|json)$/.test(basename)) score += 85;
  if (basename.startsWith('asyncapi')) score += 80;
  if (basename === 'schema.graphql' || basename === 'schema.gql') score += 75;
  if (basename.endsWith('.postman_collection.json')) score += 60;
  if (basename.endsWith('.proto')) score += 50;
  if (basename.endsWith('.smithy')) score += 70;
  if (basename === 'smithy-build.json') score += 30;
  if (/^(api|apis|spec|specs|contracts|events|graphql|proto|smithy|reference|public)\//.test(normalized)) score += 20;
  if (/^(services|packages|apps)\/[^/]+\//.test(normalized)) score += 15;
  return score;
}

const CFN_ARTIFACT_API_TYPES: Record<string, GatewayType> = {
  'AWS::ApiGateway::RestApi': 'REST',
  'AWS::Serverless::Api': 'REST',
  'AWS::ApiGatewayV2::Api': 'HTTP',
  'AWS::Serverless::HttpApi': 'HTTP'
};

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

/**
 * Inspect only synthesized CDK templates (`cdk.out/*.template.json`) and the SAM build
 * template (`.aws-sam/build/template.yaml`) for inline OpenAPI documents embedded in API
 * resources. Local-only: no AWS calls, no S3/HTTP fetches, no recursive scanning. Paths
 * are sorted lexically and logical IDs are sorted lexically within each template.
 */
export async function findLocalCfnArtifactSpecs(repoRoot: string): Promise<LocalCfnArtifactSpec[]> {
  const resolvedRoot = path.resolve(repoRoot);
  const artifactPaths: string[] = [];

  const cdkOutDir = path.join(resolvedRoot, 'cdk.out');
  try {
    const cdkLink = await lstat(cdkOutDir);
    if (!cdkLink.isSymbolicLink() && cdkLink.isDirectory()) {
      const entries = await readdir(cdkOutDir);
      for (const entry of entries.filter((name) => name.endsWith('.template.json')).sort()) {
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
  for (const artifactPath of artifactPaths.sort()) {
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
    for (const logicalId of Object.keys(resources).sort()) {
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
        filename: extracted.filename
      });
    }
  }
  return specs;
}

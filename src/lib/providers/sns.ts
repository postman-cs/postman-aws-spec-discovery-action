import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

import type { SpecFormat } from '../../contracts.js';
import { fetchSpecFromUrl } from '../fetch/spec-fetcher.js';
import type { SnsSpecClient } from '../aws/sns-client.js';
import type { SsmSpecClient } from '../aws/ssm-client.js';
import { detectCatalogApis } from '../repo/catalog.js';
import { findIaCFiles } from '../repo/scan.js';
import type { ExportOptions, SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

const ASYNCAPI_FILE_NAMES = new Set(['asyncapi.yaml', 'asyncapi.yml', 'asyncapi.json']);
const GENERATED_ASYNCAPI_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);
const GENERATED_ROOT_PREFIXES = ['spec/', 'contracts/', 'events/', 'build/', '.build/', 'out/'] as const;
const DEFAULT_IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist']);
const CONTRACT_REGISTRY_FILES = [
  '.postman/contracts.yaml',
  '.postman/contracts.yml',
  '.postman/contracts.json',
  '.postman/contract-registry.yaml',
  '.postman/contract-registry.yml',
  '.postman/contract-registry.json',
  'contracts.yaml',
  'contracts.yml',
  'contracts.json',
  'contract-registry.yaml',
  'contract-registry.yml',
  'contract-registry.json'
] as const;

interface ServiceSpec {
  serviceName: string;
  url?: string;
  content?: string;
  format?: string;
}

interface RemoteUrlCandidate {
  url: string;
  source: string;
  affinity: number;
}

export type SnsContractOrigin =
  | 'repo-asyncapi'
  | 'repo-json-schema'
  | 'generated-asyncapi'
  | 'ssm-content'
  | 'ssm-url'
  | 'catalog-url'
  | 'eventbridge-derived'
  | 'code-derived'
  | 'manual-review';

export type SnsContractResult =
  | {
      resolved: true;
      origin: SnsContractOrigin;
      result: SpecExportResult;
      evidence: string[];
    }
  | {
      resolved: false;
      evidence: string[];
    };

function topicNameFromArn(topicArn: string): string {
  const index = topicArn.lastIndexOf(':');
  return index >= 0 ? topicArn.slice(index + 1) : topicArn;
}

function normalizeServiceKey(value: string): string {
  return value
    .replace(/\.fifo$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();
}

function resolvePathWithinRoot(rootPath: string, targetPath: string, fieldName: string): string {
  const base = path.resolve(rootPath);
  const resolved = path.resolve(base, targetPath);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${fieldName} must stay within repo-root/workspace; received ${targetPath}`);
  }
  return resolved;
}

function toEvidencePath(repoRoot: string, filePath: string): string {
  const relative = path.relative(repoRoot, filePath);
  return relative.startsWith('..') ? filePath : relative.replace(/\\/g, '/');
}

function groupByService(entries: { serviceName: string; key: string; value: string }[]): ServiceSpec[] {
  const grouped = new Map<string, ServiceSpec>();
  for (const entry of entries) {
    let item = grouped.get(entry.serviceName);
    if (!item) {
      item = { serviceName: entry.serviceName };
      grouped.set(entry.serviceName, item);
    }
    if (entry.key === 'content' || entry.key === 'spec-content') {
      item.content = entry.value;
    } else if (entry.key === 'url' || entry.key === 'spec-url') {
      item.url = entry.value;
    } else if (entry.key === 'format' || entry.key === 'spec-format') {
      item.format = entry.value;
    }
  }
  return [...grouped.values()];
}

function looksLikeJsonSchema(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return Boolean(
    obj.$schema ||
      obj.type ||
      obj.properties ||
      obj.items ||
      obj.required ||
      obj.definitions ||
      obj.$defs
  );
}

function parseKnownFormat(format: string | undefined): { format: SpecFormat; filename: string } | undefined {
  const normalized = (format ?? '').trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'asyncapi-yaml') return { format: 'asyncapi-yaml', filename: 'asyncapi.yaml' };
  if (normalized === 'asyncapi-json') return { format: 'asyncapi-json', filename: 'asyncapi.json' };
  if (normalized === 'json-schema') return { format: 'json-schema', filename: 'schema.json' };
  return undefined;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function bestAffinity(target: string | undefined, hints: Set<string>): number {
  if (!target) return 0;
  const normalized = normalizeServiceKey(target);
  if (!normalized) return 0;

  let score = 0;
  for (const hint of hints) {
    if (!hint) continue;
    if (normalized === hint) {
      score = Math.max(score, 100);
      continue;
    }
    if (normalized.includes(hint) || hint.includes(normalized)) {
      score = Math.max(score, 60);
      continue;
    }
    const hintTokens = new Set(hint.split('-').filter(Boolean));
    const targetTokens = normalized.split('-').filter(Boolean);
    const overlap = targetTokens.some((token) => hintTokens.has(token));
    if (overlap) {
      score = Math.max(score, 30);
    }
  }
  return score;
}

function collectHints(topicName: string, candidateName: string): Set<string> {
  const canonicalTopicName = topicName.replace(/\.fifo$/i, '');
  return new Set(
    [
      normalizeServiceKey(topicName),
      normalizeServiceKey(canonicalTopicName),
      normalizeServiceKey(candidateName),
      normalizeServiceKey(candidateName.replace(/\.fifo$/i, ''))
    ].filter((entry) => entry.length > 0)
  );
}

function extractRegistryUrls(node: unknown, keyTrail: string[] = []): Array<{ selector?: string; url: string }> {
  if (typeof node === 'string') {
    return isHttpUrl(node) ? [{ selector: keyTrail[keyTrail.length - 1], url: node.trim() }] : [];
  }

  if (!node || typeof node !== 'object') {
    return [];
  }

  if (Array.isArray(node)) {
    return node.flatMap((entry) => extractRegistryUrls(entry, keyTrail));
  }

  const record = node as Record<string, unknown>;
  const selectors = [
    record.topic,
    record.topicName,
    record['topic-name'],
    record.service,
    record.serviceName,
    record['service-name'],
    record.name,
    keyTrail[keyTrail.length - 1]
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  const urls = [record.url, record.specUrl, record['spec-url'], record.definition]
    .filter((value): value is string => typeof value === 'string' && isHttpUrl(value))
    .map((value) => value.trim());

  const results: Array<{ selector?: string; url: string }> = [];
  for (const url of urls) {
    if (selectors.length === 0) {
      results.push({ url });
      continue;
    }
    for (const selector of selectors) {
      results.push({ selector, url });
    }
  }

  for (const [key, value] of Object.entries(record)) {
    results.push(...extractRegistryUrls(value, [...keyTrail, key]));
  }

  return results;
}

async function collectCatalogUrlCandidates(repoRoot: string, hints: Set<string>): Promise<RemoteUrlCandidate[]> {
  const catalogApis = await detectCatalogApis(repoRoot);
  if (!catalogApis || catalogApis.length === 0) {
    return [];
  }

  return catalogApis
    .filter((entry): entry is { name: string; specUrl: string } => Boolean(entry.specUrl && isHttpUrl(entry.specUrl)))
    .map((entry) => ({
      url: entry.specUrl,
      source: `Backstage catalog API "${entry.name}"`,
      affinity: bestAffinity(entry.name, hints)
    }))
    .filter((entry) => entry.affinity > 0)
    .sort((left, right) => right.affinity - left.affinity || left.url.localeCompare(right.url));
}

async function collectRegistryUrlCandidates(repoRoot: string, hints: Set<string>): Promise<RemoteUrlCandidate[]> {
  const candidates: RemoteUrlCandidate[] = [];

  for (const relativePath of CONTRACT_REGISTRY_FILES) {
    const filePath = path.join(repoRoot, relativePath);
    const content = await readFile(filePath, 'utf8').catch(() => undefined);
    if (!content) continue;

    let parsed: unknown;
    try {
      parsed = relativePath.endsWith('.json') ? JSON.parse(content) : parse(content);
    } catch {
      continue;
    }
    const extracted = extractRegistryUrls(parsed);
    for (const entry of extracted) {
      const affinity = bestAffinity(entry.selector, hints);
      if (affinity > 0) {
        candidates.push({
          url: entry.url,
          source: `contract registry file ${relativePath}`,
          affinity
        });
      }
    }
  }

  const deduped = new Map<string, RemoteUrlCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.source}::${candidate.url}`;
    const existing = deduped.get(key);
    if (!existing || candidate.affinity > existing.affinity) {
      deduped.set(key, candidate);
    }
  }

  return [...deduped.values()].sort((left, right) => right.affinity - left.affinity || left.url.localeCompare(right.url));
}

function buildSsmPointerArtifact(specUrl: string, serviceName: string, fetchError: string): string {
  return JSON.stringify(
    {
      specUrl,
      serviceName,
      registeredVia: 'ssm-parameter-store',
      fetchError
    },
    null,
    2
  );
}

function detectFormat(content: string, filenameHint: string): { format: SpecFormat; filename: string } | undefined {
  const configured = parseKnownFormat(filenameHint);
  if (configured) return configured;

  const trimmed = content.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed.asyncapi) {
      return { format: 'asyncapi-json', filename: 'asyncapi.json' };
    }
    if (looksLikeJsonSchema(parsed)) {
      return { format: 'json-schema', filename: 'schema.json' };
    }
    return undefined;
  } catch {
    // Not JSON.
  }

  try {
    const parsed = parse(trimmed) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.asyncapi) {
      return { format: 'asyncapi-yaml', filename: 'asyncapi.yaml' };
    }
  } catch {
    // Not YAML.
  }

  return undefined;
}

function sortByTopicAffinity(files: string[], topicName: string): string[] {
  const loweredTopicName = topicName.toLowerCase();
  return [...files].sort((left, right) => {
    const leftMatch = left.toLowerCase().includes(loweredTopicName);
    const rightMatch = right.toLowerCase().includes(loweredTopicName);
    if (leftMatch !== rightMatch) {
      return leftMatch ? -1 : 1;
    }
    return left.localeCompare(right);
  });
}

function normalizePathForMatch(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function isGeneratedSearchRootPath(repoRoot: string, filePath: string): boolean {
  const relative = normalizePathForMatch(path.relative(repoRoot, filePath));
  return GENERATED_ROOT_PREFIXES.some((prefix) => relative.startsWith(prefix));
}

function isGeneratedAsyncApiPath(repoRoot: string, filePath: string): boolean {
  const relative = normalizePathForMatch(path.relative(repoRoot, filePath));
  const base = path.basename(relative).toLowerCase();
  const isDotAsyncApi = base.endsWith('.asyncapi.yaml') || base.endsWith('.asyncapi.yml') || base.endsWith('.asyncapi.json');
  const isNamedAsyncApi = base === 'asyncapi.yaml' || base === 'asyncapi.yml' || base === 'asyncapi.json';

  if (relative.startsWith('spec/') || relative.startsWith('contracts/')) {
    return isDotAsyncApi;
  }
  if (relative.startsWith('events/')) {
    return isNamedAsyncApi;
  }
  if (relative.startsWith('build/') || relative.startsWith('.build/') || relative.startsWith('out/')) {
    return isDotAsyncApi || isNamedAsyncApi;
  }
  return false;
}

function createGitignoreMatcher(repoRoot: string, content: string): (targetPath: string, isDirectory: boolean) => boolean {
  const rules = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const directoryOnly = line.endsWith('/');
      const pattern = normalizePathForMatch(directoryOnly ? line.slice(0, -1) : line);
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      const regexSource = escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
      return { directoryOnly, regex: new RegExp(`(^|/)${regexSource}($|/)`) };
    });

  return (targetPath: string, isDirectory: boolean): boolean => {
    const relative = normalizePathForMatch(path.relative(repoRoot, targetPath));
    return rules.some((rule) => (!rule.directoryOnly || isDirectory) && rule.regex.test(relative));
  };
}

async function collectFilesByExtension(
  currentPath: string,
  matcher: (targetPath: string, isDirectory: boolean) => boolean
): Promise<string[]> {
  const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      if (DEFAULT_IGNORED_DIRS.has(entry.name) || matcher(fullPath, true)) {
        continue;
      }
      files.push(...(await collectFilesByExtension(fullPath, matcher)));
      continue;
    }

    if (!entry.isFile() || matcher(fullPath, false)) {
      continue;
    }

    if (GENERATED_ASYNCAPI_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files;
}

async function findContractFiles(repoRoot: string, topicName: string): Promise<{ asyncapi: string[]; jsonSchema: string[] }> {
  const files = await findIaCFiles(repoRoot, ['.yaml', '.yml', '.json']);
  const asyncapi: string[] = [];
  const jsonSchema: string[] = [];

  for (const filePath of files) {
    const safePath = resolvePathWithinRoot(repoRoot, filePath, 'repo contract path');
    const baseName = path.basename(safePath).toLowerCase();
    if (isGeneratedSearchRootPath(repoRoot, safePath)) {
      if (baseName === 'schema.json' || baseName.endsWith('.schema.json')) {
        jsonSchema.push(safePath);
      }
      continue;
    }
    if (ASYNCAPI_FILE_NAMES.has(baseName)) {
      asyncapi.push(safePath);
      continue;
    }
    if (baseName === 'schema.json' || baseName.endsWith('.schema.json')) {
      jsonSchema.push(safePath);
    }
  }

  return {
    asyncapi: sortByTopicAffinity(asyncapi, topicName),
    jsonSchema: sortByTopicAffinity(jsonSchema, topicName)
  };
}

async function findGeneratedAsyncApiFiles(repoRoot: string, topicName: string): Promise<string[]> {
  const gitignorePath = path.join(repoRoot, '.gitignore');
  const gitignoreContent = await readFile(gitignorePath, 'utf8').catch(() => '');
  const matcher = createGitignoreMatcher(repoRoot, gitignoreContent);
  const scanned = await findIaCFiles(repoRoot, ['.yaml', '.yml', '.json']);
  const discovered = new Set<string>(scanned);

  for (const frameworkRoot of ['build', '.build', 'out']) {
    const rootPath = path.join(repoRoot, frameworkRoot);
    const rootStats = await stat(rootPath).catch(() => null);
    if (!rootStats || !rootStats.isDirectory() || matcher(rootPath, true)) {
      continue;
    }
    for (const filePath of await collectFilesByExtension(rootPath, matcher)) {
      discovered.add(filePath);
    }
  }

  return sortByTopicAffinity(
    [...discovered].filter((filePath) => !matcher(filePath, false) && isGeneratedAsyncApiPath(repoRoot, filePath)),
    topicName
  );
}

async function resolveAsyncApiContract(
  repoRoot: string,
  files: string[],
  sourceLabel: 'repo-local' | 'generated' = 'repo-local'
): Promise<{ match?: SpecExportResult; evidence: string[] }> {
  const evidence: string[] = [];

  for (const filePath of files) {
    const relativePath = toEvidencePath(repoRoot, filePath);
    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      evidence.push(`Skipped malformed AsyncAPI file ${relativePath} (unreadable)`);
      continue;
    }

    try {
      const parsed = filePath.toLowerCase().endsWith('.json') ? JSON.parse(content) : parse(content);
      if (!parsed || typeof parsed !== 'object' || !('asyncapi' in (parsed as Record<string, unknown>))) {
        evidence.push(`Skipped malformed AsyncAPI file ${relativePath} (missing asyncapi key)`);
        continue;
      }

      const format: SpecFormat = filePath.toLowerCase().endsWith('.json') ? 'asyncapi-json' : 'asyncapi-yaml';
      const sourceDescription = sourceLabel === 'generated' ? 'generated AsyncAPI' : 'repo-local AsyncAPI';
      return {
        match: {
          content,
          format,
          filename: path.basename(filePath),
          evidence: [...evidence, `Resolved SNS contract from ${sourceDescription} file ${relativePath}`]
        },
        evidence
      };
    } catch {
      evidence.push(`Skipped malformed AsyncAPI file ${relativePath} (failed to parse)`);
    }
  }

  return { evidence };
}

async function resolveJsonSchemaContract(
  repoRoot: string,
  files: string[],
  inheritedEvidence: string[] = []
): Promise<{ match?: SpecExportResult; evidence: string[] }> {
  const evidence: string[] = [...inheritedEvidence];

  for (const filePath of files) {
    const relativePath = toEvidencePath(repoRoot, filePath);
    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      evidence.push(`Skipped malformed JSON Schema file ${relativePath} (unreadable)`);
      continue;
    }

    try {
      const parsed = JSON.parse(content);
      if (!looksLikeJsonSchema(parsed)) {
        evidence.push(`Skipped malformed JSON Schema file ${relativePath} (missing schema markers)`);
        continue;
      }
      return {
        match: {
          content,
          format: 'json-schema',
          filename: path.basename(filePath),
          evidence: [...evidence, `Resolved SNS contract from repo-local JSON Schema file ${relativePath}`]
        },
        evidence
      };
    } catch {
      evidence.push(`Skipped malformed JSON Schema file ${relativePath} (failed to parse JSON)`);
    }
  }

  return { evidence };
}

export class SnsProvider implements SpecProvider {
  public readonly type = 'sns' as const;

  public constructor(
    private readonly client: SnsSpecClient,
    private readonly repoRoot: string = '.',
    private readonly ssmClient?: SsmSpecClient,
    private readonly fetchRemoteSpec: typeof fetchSpecFromUrl = fetchSpecFromUrl
  ) {}

  public async probe(): Promise<boolean> {
    return this.client.probe();
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const topics = await this.client.listTopics();
    if (topics.length === 0) {
      return [];
    }

    const candidates: SpecCandidate[] = [];
    for (const topic of topics) {
      const topicArn = topic.topicArn;
      const arnDerivedTopicName = topicNameFromArn(topicArn);
      const attributes: Record<string, string> = await this.client
        .getTopicAttributes(topicArn)
        .catch((): Record<string, string> => ({}));
      const tags: Record<string, string> = await this.client
        .listTagsForResource(topicArn)
        .catch((): Record<string, string> => ({}));
      const taggedServiceName = (tags['postman:project-name'] ?? '').trim();
      const candidateName = taggedServiceName || arnDerivedTopicName;

      candidates.push({
        id: topicArn,
        name: candidateName,
        providerType: 'sns',
        tags,
        evidence: [`SNS topic discovered: ${topicArn}`],
        meta: {
          topicArn,
          arnDerivedTopicName,
          ...(attributes.DisplayName ? { displayName: attributes.DisplayName } : {})
        }
      });
    }

    return candidates;
  }

  public async exportSpec(candidate: SpecCandidate, _options?: ExportOptions): Promise<SpecExportResult> {
    void _options;

    const resolvedRepoRoot = path.resolve(this.repoRoot);
    const topicArn = candidate.meta.topicArn ?? candidate.id;
    const topicName = topicNameFromArn(topicArn);
    resolvePathWithinRoot(resolvedRepoRoot, topicName, 'topic-name');

    const contract = await this.resolveContract(candidate);
    if (contract.resolved) {
      return contract.result;
    }

    const manualReview = {
      status: 'unresolved',
      sourceType: 'manual-review',
      providerType: 'sns',
      topicArn,
      topicName,
      attemptedSources: ['repo-local-asyncapi', 'repo-local-json-schema', 'generated-asyncapi', 'ssm-registry']
    };

    return {
      content: JSON.stringify(manualReview, null, 2),
      format: 'json-schema',
      filename: 'manual-review.json',
      evidence: contract.evidence
    };
  }

  public async resolveContract(candidate: SpecCandidate): Promise<SnsContractResult> {
    const resolvedRepoRoot = path.resolve(this.repoRoot);
    const topicArn = candidate.meta.topicArn ?? candidate.id;
    const topicName = topicNameFromArn(topicArn);
    const affinityHints = collectHints(topicName, candidate.name);
    resolvePathWithinRoot(resolvedRepoRoot, topicName, 'topic-name');

    const files = await findContractFiles(resolvedRepoRoot, topicName);
    const asyncApiResolution = await resolveAsyncApiContract(resolvedRepoRoot, files.asyncapi, 'repo-local');
    if (asyncApiResolution.match) {
      return {
        resolved: true,
        origin: 'repo-asyncapi',
        result: asyncApiResolution.match,
        evidence: asyncApiResolution.match.evidence
      };
    }

    const jsonSchemaResolution = await resolveJsonSchemaContract(
      resolvedRepoRoot,
      files.jsonSchema,
      asyncApiResolution.evidence
    );
    if (jsonSchemaResolution.match) {
      return {
        resolved: true,
        origin: 'repo-json-schema',
        result: jsonSchemaResolution.match,
        evidence: jsonSchemaResolution.match.evidence
      };
    }

    const generatedAsyncApiFiles = await findGeneratedAsyncApiFiles(resolvedRepoRoot, topicName);
    const generatedAsyncApiResolution = await resolveAsyncApiContract(
      resolvedRepoRoot,
      generatedAsyncApiFiles,
      'generated'
    );
    if (generatedAsyncApiResolution.match) {
      return {
        resolved: true,
        origin: 'generated-asyncapi',
        result: generatedAsyncApiResolution.match,
        evidence: generatedAsyncApiResolution.match.evidence
      };
    }

    const priorEvidence = [...jsonSchemaResolution.evidence, ...generatedAsyncApiResolution.evidence];

    if (this.ssmClient) {
      const specs = groupByService(await this.ssmClient.listSpecParameters());
      const canonicalTopicName = topicName.replace(/\.fifo$/i, '');
      const serviceKeys = new Set(
        [
          topicName,
          canonicalTopicName,
          topicName.toLowerCase(),
          canonicalTopicName.toLowerCase(),
          normalizeServiceKey(topicName),
          normalizeServiceKey(canonicalTopicName)
        ].filter((entry) => entry.length > 0)
      );
      const ssmMatch = specs.find((entry) => {
        const entryName = entry.serviceName.trim();
        if (!entryName) {
          return false;
        }
        return (
          serviceKeys.has(entryName) ||
          serviceKeys.has(entryName.toLowerCase()) ||
          serviceKeys.has(normalizeServiceKey(entryName))
        );
      });
      if (ssmMatch?.content) {
        const resolvedFormat = parseKnownFormat(ssmMatch.format) ?? detectFormat(ssmMatch.content, ssmMatch.format ?? '');
        if (resolvedFormat) {
          const evidence = [...priorEvidence, `Resolved SNS contract from SSM path /postman/specs/${ssmMatch.serviceName}/`];
          return {
            resolved: true,
            origin: 'ssm-content',
            result: {
              content: ssmMatch.content,
              format: resolvedFormat.format,
              filename: resolvedFormat.filename,
              evidence
            },
            evidence
          };
        }
      }

      const ssmUrl = ssmMatch?.url;
      if (ssmUrl) {
        try {
          const fetched = await this.fetchRemoteSpec(ssmUrl, { timeoutMs: 15000 });
          const resolvedFormat = parseKnownFormat(ssmMatch?.format) ?? detectFormat(fetched.content, ssmMatch?.format ?? '');
          if (resolvedFormat) {
            const evidence = [...priorEvidence, `Resolved SNS contract from SSM URL /postman/specs/${ssmMatch.serviceName}/`];
            return {
              resolved: true,
              origin: 'ssm-url',
              result: {
                content: fetched.content,
                format: resolvedFormat.format,
                filename: resolvedFormat.filename,
                evidence
              },
              evidence
            };
          }

          priorEvidence.push(
            `Fetched SSM URL ${ssmUrl} but unsupported format for SNS contract resolution; expected AsyncAPI or JSON Schema`
          );
        } catch (fetchError) {
          const detail = fetchError instanceof Error ? fetchError.message : String(fetchError);
          const pointerArtifact = buildSsmPointerArtifact(ssmUrl, ssmMatch.serviceName, detail);
          priorEvidence.push(
            `Failed to fetch SNS contract from SSM URL ${ssmUrl}; pointer artifact spec-pointer.json: ${pointerArtifact}`
          );
        }
      }
    }

    const remoteUrlCandidates = [
      ...(await collectCatalogUrlCandidates(resolvedRepoRoot, affinityHints)),
      ...(await collectRegistryUrlCandidates(resolvedRepoRoot, affinityHints))
    ].sort((left, right) => right.affinity - left.affinity || left.source.localeCompare(right.source));

    for (const remoteCandidate of remoteUrlCandidates) {
      try {
        const fetched = await this.fetchRemoteSpec(remoteCandidate.url, { timeoutMs: 15000 });
        const resolvedFormat = detectFormat(fetched.content, '');
        if (!resolvedFormat) {
          priorEvidence.push(
            `Fetched ${remoteCandidate.source} URL ${remoteCandidate.url} but unsupported format for SNS contract resolution; expected AsyncAPI or JSON Schema`
          );
          continue;
        }
        const evidence = [...priorEvidence, `Resolved SNS contract from ${remoteCandidate.source} URL ${remoteCandidate.url}`];
        return {
          resolved: true,
          origin: 'catalog-url',
          result: {
            content: fetched.content,
            format: resolvedFormat.format,
            filename: resolvedFormat.filename,
            evidence
          },
          evidence
        };
      } catch (fetchError) {
        const detail = fetchError instanceof Error ? fetchError.message : String(fetchError);
        priorEvidence.push(`Failed to fetch SNS contract from ${remoteCandidate.source} URL ${remoteCandidate.url}: ${detail}`);
      }
    }

    return {
      resolved: false,
      evidence: [...priorEvidence, `No SNS contract found for ${topicArn}; manual review required`]
    };
  }
}

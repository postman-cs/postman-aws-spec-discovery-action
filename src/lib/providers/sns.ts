import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

import type { SpecFormat } from '../../contracts.js';
import type { SnsSpecClient } from '../aws/sns-client.js';
import type { SsmSpecClient } from '../aws/ssm-client.js';
import { findIaCFiles } from '../repo/scan.js';
import type { ExportOptions, SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

const ASYNCAPI_FILE_NAMES = new Set(['asyncapi.yaml', 'asyncapi.yml', 'asyncapi.json']);

interface ServiceSpec {
  serviceName: string;
  url?: string;
  content?: string;
  format?: string;
}

export type SnsContractOrigin = 'repo-asyncapi' | 'repo-json-schema' | 'ssm';

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

async function findContractFiles(repoRoot: string, topicName: string): Promise<{ asyncapi: string[]; jsonSchema: string[] }> {
  const files = await findIaCFiles(repoRoot, ['.yaml', '.yml', '.json']);
  const asyncapi: string[] = [];
  const jsonSchema: string[] = [];

  for (const filePath of files) {
    const safePath = resolvePathWithinRoot(repoRoot, filePath, 'repo contract path');
    const baseName = path.basename(safePath).toLowerCase();
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

async function resolveAsyncApiContract(
  repoRoot: string,
  files: string[]
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
      return {
        match: {
          content,
          format,
          filename: path.basename(filePath),
          evidence: [...evidence, `Resolved SNS contract from repo-local AsyncAPI file ${relativePath}`]
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
    private readonly ssmClient?: SsmSpecClient
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
      attemptedSources: ['repo-local-asyncapi', 'repo-local-json-schema', 'ssm-registry']
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
    resolvePathWithinRoot(resolvedRepoRoot, topicName, 'topic-name');

    const files = await findContractFiles(resolvedRepoRoot, topicName);
    const asyncApiResolution = await resolveAsyncApiContract(resolvedRepoRoot, files.asyncapi);
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

    const priorEvidence = [...jsonSchemaResolution.evidence];

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
            origin: 'ssm',
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
    }
    return {
      resolved: false,
      evidence: [...priorEvidence, `No SNS contract found for ${topicArn}; manual review required`]
    };
  }
}

import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

import type { SpecCandidate, SpecExportResult } from './types.js';

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const JAVA_EXTENSIONS = new Set(['.java']);
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist']);

interface CodeDerivedCandidate {
  kind: 'json-schema-ref' | 'zod' | 'typebox' | 'springwolf' | 'java-annotation' | 'generated-asyncapi';
  sourcePath: string;
  displayPath: string;
  result: SpecExportResult;
}

export interface ResolveCodeDerivedContractParams {
  repoRoot: string;
  candidate: SpecCandidate;
  topicName: string;
  topicArn: string;
  serviceHints?: string[];
}

export interface ResolveCodeDerivedContractResult {
  resolved?: SpecExportResult;
  evidence: string[];
  ambiguousCandidates?: string[];
}

export type ResolveCodeDerivedContract = (
  params: ResolveCodeDerivedContractParams
) => Promise<ResolveCodeDerivedContractResult>;

function normalizeHint(value: string): string {
  return value
    .replace(/\.fifo$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();
}

function relativePath(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, filePath).replace(/\\/g, '/');
}

function hasTopicLinkage(content: string, hints: Set<string>): boolean {
  const lowered = content.toLowerCase();
  if (!/(PublishCommand|\.publish\s*\()/i.test(content)) {
    return false;
  }
  for (const hint of hints) {
    if (hint && lowered.includes(hint)) {
      return true;
    }
  }
  return false;
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

async function walkFiles(root: string): Promise<string[]> {
  const queue = [root];
  const files: string[] = [];

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          queue.push(fullPath);
        }
        continue;
      }
      if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function createSyntheticJsonSchema(
  sourcePath: string,
  kind: 'zod' | 'typebox' | 'java-annotation',
  topicName: string,
  details: Record<string, unknown> = {}
): string {
  return JSON.stringify(
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: true,
      'x-code-derived': {
        sourcePath,
        kind,
        topicName,
        ...details
      }
    },
    null,
    2
  );
}

function parseStaticJavaSnsAnnotation(content: string, topicHints: Set<string>): { topicName: string; payloadType: string } | undefined {
  const annotationPattern = /@SnsPublish\s*\(([^)]*)\)/gs;
  for (const annotationMatch of content.matchAll(annotationPattern)) {
    const args = annotationMatch[1] ?? '';
    const topicMatch = /topicName\s*=\s*"([^"]+)"/.exec(args);
    const payloadMatch = /payloadType\s*=\s*([A-Za-z0-9_$.]+)\.class/.exec(args);
    if (!topicMatch || !payloadMatch) {
      continue;
    }

    const topicName = topicMatch[1];
    if (!topicName || topicName.includes('${') || topicName.includes('+')) {
      continue;
    }
    const normalized = normalizeHint(topicName);
    let linked = false;
    for (const hint of topicHints) {
      if (!hint) continue;
      if (normalized === hint || normalized.includes(hint) || hint.includes(normalized)) {
        linked = true;
        break;
      }
    }
    if (!linked) {
      continue;
    }
    return { topicName, payloadType: payloadMatch[1] };
  }
  return undefined;
}

function detectAsyncApiFormat(content: string, filePath: string): SpecExportResult | undefined {
  try {
    const parsed = filePath.endsWith('.json') ? JSON.parse(content) : parse(content);
    if (!parsed || typeof parsed !== 'object' || !('asyncapi' in (parsed as Record<string, unknown>))) {
      return undefined;
    }
    return {
      content,
      format: filePath.endsWith('.json') ? 'asyncapi-json' : 'asyncapi-yaml',
      filename: path.basename(filePath),
      evidence: []
    };
  } catch {
    return undefined;
  }
}

export const resolveCodeDerivedContract: ResolveCodeDerivedContract = async ({
  repoRoot,
  topicName,
  topicArn,
  serviceHints = []
}) => {
  const evidence: string[] = [];
  const candidates: CodeDerivedCandidate[] = [];
  const hints = new Set(
    [
      normalizeHint(topicName),
      normalizeHint(topicArn),
      ...serviceHints.map(normalizeHint)
    ].filter(Boolean)
  );

  const springwolfPaths = [
    path.join(repoRoot, 'build', 'springwolf', 'asyncapi.json'),
    path.join(repoRoot, 'target', 'springwolf', 'asyncapi.json')
  ];
  for (const springwolfPath of springwolfPaths) {
    if (!(await fileExists(springwolfPath))) {
      continue;
    }
    const content = await readFile(springwolfPath, 'utf8').catch(() => undefined);
    if (!content) {
      continue;
    }
    const exportResult = detectAsyncApiFormat(content, springwolfPath);
    if (!exportResult) {
      continue;
    }
    candidates.push({
      kind: 'springwolf',
      sourcePath: springwolfPath,
      displayPath: relativePath(repoRoot, springwolfPath),
      result: exportResult
    });
  }

  const generatedAsyncApiPaths = [
    path.join(repoRoot, 'generated', 'asyncapi.json'),
    path.join(repoRoot, 'generated', 'asyncapi.yaml'),
    path.join(repoRoot, 'generated', 'asyncapi.yml')
  ];
  for (const generatedPath of generatedAsyncApiPaths) {
    if (!(await fileExists(generatedPath))) {
      continue;
    }
    const content = await readFile(generatedPath, 'utf8').catch(() => undefined);
    if (!content) {
      continue;
    }
    const exportResult = detectAsyncApiFormat(content, generatedPath);
    if (!exportResult) {
      continue;
    }
    candidates.push({
      kind: 'generated-asyncapi',
      sourcePath: generatedPath,
      displayPath: relativePath(repoRoot, generatedPath),
      result: exportResult
    });
  }

  const files = await walkFiles(repoRoot);
  for (const filePath of files) {
    const extension = path.extname(filePath).toLowerCase();
    if (!CODE_EXTENSIONS.has(extension) && !JAVA_EXTENSIONS.has(extension)) {
      continue;
    }

    const content = await readFile(filePath, 'utf8').catch(() => undefined);
    if (!content) {
      continue;
    }
    const displayPath = relativePath(repoRoot, filePath);

    if (CODE_EXTENSIONS.has(extension) && hasTopicLinkage(content, hints)) {
      const schemaReferencePattern = /(?:import\s+[\w*\s{},]*\s+from\s+|require\()\s*['"]([^'"]+\.json)['"]\)?/g;
      for (const schemaMatch of content.matchAll(schemaReferencePattern)) {
        const refPath = schemaMatch[1];
        if (!refPath) continue;
        const resolvedRefPath = path.resolve(path.dirname(filePath), refPath);
        const schemaContent = await readFile(resolvedRefPath, 'utf8').catch(() => undefined);
        if (!schemaContent) {
          continue;
        }
        try {
          const parsed = JSON.parse(schemaContent);
          if (!looksLikeJsonSchema(parsed)) {
            continue;
          }
          candidates.push({
            kind: 'json-schema-ref',
            sourcePath: resolvedRefPath,
            displayPath: relativePath(repoRoot, resolvedRefPath),
            result: {
              content: schemaContent,
              format: 'json-schema',
              filename: path.basename(resolvedRefPath),
              evidence: []
            }
          });
        } catch {
          // Ignore malformed references.
        }
      }

      if (/\bz\.object\s*\(/.test(content)) {
        candidates.push({
          kind: 'zod',
          sourcePath: filePath,
          displayPath,
          result: {
            content: createSyntheticJsonSchema(displayPath, 'zod', topicName),
            format: 'json-schema',
            filename: 'schema.json',
            evidence: []
          }
        });
      }

      if (/\bType\.Object\s*\(/.test(content)) {
        candidates.push({
          kind: 'typebox',
          sourcePath: filePath,
          displayPath,
          result: {
            content: createSyntheticJsonSchema(displayPath, 'typebox', topicName),
            format: 'json-schema',
            filename: 'schema.json',
            evidence: []
          }
        });
      }
    }

    if (JAVA_EXTENSIONS.has(extension)) {
      const annotation = parseStaticJavaSnsAnnotation(content, hints);
      if (annotation) {
        candidates.push({
          kind: 'java-annotation',
          sourcePath: filePath,
          displayPath,
          result: {
            content: createSyntheticJsonSchema(displayPath, 'java-annotation', topicName, {
              payloadType: annotation.payloadType,
              annotationTopicName: annotation.topicName
            }),
            format: 'json-schema',
            filename: 'schema.json',
            evidence: []
          }
        });
      }
    }
  }

  const uniqueCandidates = new Map<string, CodeDerivedCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.kind}:${candidate.sourcePath}`;
    if (!uniqueCandidates.has(key)) {
      uniqueCandidates.set(key, candidate);
    }
  }
  const deduped = [...uniqueCandidates.values()];
  if (deduped.length === 0) {
    return { evidence };
  }

  if (deduped.length > 1) {
    const ambiguousCandidates = deduped.map((candidate) => `${candidate.kind}:${candidate.displayPath}`);
    evidence.push(`Ambiguous code-derived candidates found: ${ambiguousCandidates.join(', ')}`);
    return { evidence, ambiguousCandidates };
  }

  const selected = deduped[0];
  if (!selected) {
    return { evidence };
  }

  return {
    evidence: [...evidence, `Resolved SNS contract from code-derived ${selected.kind} source ${selected.displayPath}`],
    resolved: {
      ...selected.result,
      evidence: [`Resolved SNS contract from code-derived ${selected.kind} source ${selected.displayPath}`]
    }
  };
};

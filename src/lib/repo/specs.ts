import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

const SPEC_CANDIDATES = [
  'openapi.yaml',
  'openapi.yml',
  'openapi.json',
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
  'src/schema.graphql'
];

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

export interface RepoSpecMatch {
  path: string;
  type: 'openapi' | 'graphql';
}

export async function findExistingRepoSpec(repoRoot: string): Promise<string | undefined> {
  const match = await findExistingRepoSpecTyped(repoRoot);
  return match?.path;
}

export async function findExistingRepoSpecTyped(repoRoot: string): Promise<RepoSpecMatch | undefined> {
  for (const candidate of SPEC_CANDIDATES) {
    const fullPath = path.resolve(repoRoot, candidate);
    try {
      const fileStat = await stat(fullPath);
      if (!fileStat.isFile()) {
        continue;
      }
      const content = await readFile(fullPath, 'utf8');
      const isGraphql = candidate.endsWith('.graphql') || candidate.endsWith('.gql');
      if (isGraphql && isLikelyGraphqlSchema(content)) {
        return { path: candidate.replace(/\\/g, '/'), type: 'graphql' };
      }
      if (!isGraphql && isLikelyOpenApiDocument(content)) {
        return { path: candidate.replace(/\\/g, '/'), type: 'openapi' };
      }
    } catch {
      // Continue search.
    }
  }

  return undefined;
}

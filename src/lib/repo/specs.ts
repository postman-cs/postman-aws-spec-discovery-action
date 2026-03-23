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
  'docs/openapi.json'
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

export async function findExistingRepoSpec(repoRoot: string): Promise<string | undefined> {
  for (const candidate of SPEC_CANDIDATES) {
    const fullPath = path.resolve(repoRoot, candidate);
    try {
      const fileStat = await stat(fullPath);
      if (!fileStat.isFile()) {
        continue;
      }
      const content = await readFile(fullPath, 'utf8');
      if (isLikelyOpenApiDocument(content)) {
        return candidate.replace(/\\/g, '/');
      }
    } catch {
      // Continue search.
    }
  }

  return undefined;
}

import { access } from 'node:fs/promises';
import path from 'node:path';

const SPEC_CANDIDATES = [
  'openapi.yaml',
  'openapi.yml',
  'swagger.yaml',
  'swagger.yml',
  'spec/openapi.yaml',
  'spec/openapi.yml',
  'api/openapi.yaml',
  'api/openapi.yml'
];

export async function findExistingRepoSpec(repoRoot: string): Promise<string | undefined> {
  for (const candidate of SPEC_CANDIDATES) {
    const fullPath = path.resolve(repoRoot, candidate);
    try {
      await access(fullPath);
      return candidate.replace(/\\/g, '/');
    } catch {
      // Continue search.
    }
  }

  return undefined;
}

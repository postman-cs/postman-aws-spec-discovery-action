import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface RepoSignals {
  serviceHints: string[];
  gatewayIdHints: string[];
  evidence: string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function extractGatewayIds(content: string): string[] {
  const matches = content.match(/\b[a-z0-9]{10}\b/g) ?? [];
  return unique(matches.map((value) => value.trim()));
}

function inferServiceNameFromRepoSlug(repoSlug?: string): string | undefined {
  if (!repoSlug) {
    return undefined;
  }
  const parts = repoSlug.split('/');
  return parts[parts.length - 1]?.trim();
}

export async function collectRepoSignals(
  repoRoot: string,
  repoSlug?: string,
  expectedServiceName?: string,
  expectedGatewayIds: string[] = []
): Promise<RepoSignals> {
  const serviceHints = unique([
    expectedServiceName ?? '',
    inferServiceNameFromRepoSlug(repoSlug) ?? ''
  ]);
  const gatewayHints = unique([...expectedGatewayIds]);
  const evidence: string[] = [];

  const inspectFiles = [
    '.github/workflows/deploy.yml',
    '.gitlab-ci.yml',
    'template.yaml',
    'serverless.yml',
    'README.md'
  ];

  for (const file of inspectFiles) {
    const fullPath = path.resolve(repoRoot, file);
    try {
      const content = await readFile(fullPath, 'utf8');
      const extracted = extractGatewayIds(content);
      if (extracted.length > 0) {
        gatewayHints.push(...extracted);
        evidence.push(`Found gateway ID hints in ${file}`);
      }
    } catch {
      // Optional file.
    }
  }

  return {
    serviceHints: unique(serviceHints),
    gatewayIdHints: unique(gatewayHints),
    evidence: unique(evidence)
  };
}

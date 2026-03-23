import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface RepoSignals {
  serviceHints: string[];
  explicitGatewayIdHints: string[];
  inferredGatewayIdHints: string[];
  evidence: string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function extractGatewayIds(content: string): string[] {
  const patterns = [
    /https:\/\/([a-z0-9]{10})\.execute-api\.[a-z0-9-]+\.amazonaws\.com/gi,
    /(?:--rest-api-id|--api-id)\s+([a-z0-9]{10})\b/gi,
    /restapis\/([a-z0-9]{10})\b/gi,
    /\b(?:REST_API_ID|HTTP_API_ID|API_GATEWAY_ID)\s*[:=]\s*["']?([a-z0-9]{10})\b/gi
  ];
  const matches: string[] = [];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const value = (match[1] ?? '').trim();
      if (value) {
        matches.push(value);
      }
    }
  }
  return unique(matches);
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
  const inferredGatewayHints: string[] = [];
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
        inferredGatewayHints.push(...extracted);
        evidence.push(`Found gateway ID hints in ${file}`);
      }
    } catch {
      // Optional file.
    }
  }

  return {
    serviceHints: unique(serviceHints),
    explicitGatewayIdHints: unique(expectedGatewayIds),
    inferredGatewayIdHints: unique(inferredGatewayHints),
    evidence: unique(evidence)
  };
}

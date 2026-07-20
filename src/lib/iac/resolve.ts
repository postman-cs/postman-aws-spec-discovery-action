import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { discoverCloudFormationTemplatePaths, resolveCloudFormationTemplate } from './cloudformation.js';
import { resolveCdkAssembly } from './cdk.js';
import { artifactClassRank } from './freshness.js';
import { createIacReadBudget } from './read.js';
import { resolveServerlessStatic } from './serverless.js';
import { resolveTerraformStatic } from './terraform.js';
import type {
  IacSpecCandidate,
  ResolveStaticIacOptions,
  StaticIacResolution
} from './types.js';

async function optionalRegularFile(repoRoot: string, relativePath: string): Promise<boolean> {
  try {
    const info = await lstat(path.resolve(repoRoot, relativePath));
    return !info.isSymbolicLink() && info.isFile();
  } catch {
    return false;
  }
}

function isEnabled(
  options: ResolveStaticIacOptions,
  source: keyof NonNullable<ResolveStaticIacOptions['enabledSources']>
): boolean {
  return options.enabledSources?.[source] !== false;
}

function dedupeCandidates(candidates: IacSpecCandidate[]): IacSpecCandidate[] {
  const seen = new Set<string>();
  const result: IacSpecCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    result.push(candidate);
  }
  return result;
}

function sortCandidates(candidates: IacSpecCandidate[]): IacSpecCandidate[] {
  return [...candidates].sort((left, right) => {
    const classDelta = artifactClassRank(right.artifactClass) - artifactClassRank(left.artifactClass);
    if (classDelta !== 0) return classDelta;
    const leftContent = left.content ? 1 : 0;
    const rightContent = right.content ? 1 : 0;
    if (rightContent !== leftContent) return rightContent - leftContent;
    return left.id.localeCompare(right.id);
  });
}

/**
 * Resolve static IaC specification references without executing builds,
 * loading plugins, evaluating arbitrary expressions, or downloading remote state.
 *
 * Returns a clean candidate API suitable for runtime integration. Content-bearing
 * OpenAPI candidates can be merged into repo inventory; physical API IDs feed
 * gateway correlation via signals.
 */
export async function resolveStaticIacCandidates(
  repoRoot: string,
  options: ResolveStaticIacOptions = {}
): Promise<StaticIacResolution> {
  const budget = createIacReadBudget({
    maxDepth: options.maxDepth,
    maxFiles: options.maxFiles,
    maxFileBytes: options.maxFileBytes,
    maxCumulativeBytes: options.maxCumulativeBytes
  });
  const errors: StaticIacResolution['errors'] = [];
  const raw: IacSpecCandidate[] = [];

  if (isEnabled(options, 'cloudformation') || isEnabled(options, 'sam')) {
    const templates = await discoverCloudFormationTemplatePaths(repoRoot, budget, errors);
    // Filter discovery noise: only keep unique templates that exist.
    const uniqueTemplates = [...new Set(templates)];
    for (const templatePath of uniqueTemplates) {
      // Skip generated locations here; CDK/SAM package paths handled below.
      if (templatePath.includes('cdk.out') || templatePath.includes('.aws-sam') || templatePath.includes('.serverless')) {
        continue;
      }
      raw.push(
        ...await resolveCloudFormationTemplate(repoRoot, templatePath, budget, errors, {
          s3Client: options.s3Client
        })
      );
    }

    // SAM build artifact (skip-if-absent; no missing-file noise)
    if (await optionalRegularFile(repoRoot, '.aws-sam/build/template.yaml')) {
      raw.push(
        ...await resolveCloudFormationTemplate(
          repoRoot,
          '.aws-sam/build/template.yaml',
          budget,
          errors,
          {
            s3Client: options.s3Client,
            forceSource: 'sam',
            sourceHints: ['template.yaml', 'template.yml', 'samconfig.toml']
          }
        )
      );
    }
  }

  if (isEnabled(options, 'cdk')) {
    raw.push(
      ...await resolveCdkAssembly(repoRoot, budget, errors, { s3Client: options.s3Client })
    );
  }

  if (isEnabled(options, 'terraform')) {
    raw.push(
      ...await resolveTerraformStatic(repoRoot, budget, errors, {
        statePaths: options.terraformStatePaths
      })
    );
  }

  if (isEnabled(options, 'serverless')) {
    raw.push(
      ...await resolveServerlessStatic(repoRoot, budget, errors, {
        deployedStackOutputs: options.deployedStackOutputs
      })
    );
  }

  if (budget.truncated) {
    errors.push({
      code: 'bounds-exceeded',
      path: '.',
      message: `Static IaC resolution truncated at maxFiles=${budget.maxFiles}, maxDepth=${budget.maxDepth}, maxCumulativeBytes=${budget.maxCumulativeBytes}`
    });
  }

  const candidates = sortCandidates(dedupeCandidates(raw));
  const physicalApiIds = [
    ...new Set(
      candidates
        .filter((candidate) => candidate.kind === 'physical-api-id' && candidate.physicalApiId)
        .map((candidate) => candidate.physicalApiId as string)
    )
  ].sort((a, b) => a.localeCompare(b));

  return { candidates, physicalApiIds, errors };
}

/** Content-bearing OpenAPI candidates only (for repo inventory merge). */
export function contentBearingIacCandidates(resolution: StaticIacResolution): IacSpecCandidate[] {
  return resolution.candidates.filter(
    (candidate) =>
      Boolean(candidate.content)
      && (candidate.kind === 'openapi-inline'
        || candidate.kind === 'openapi-local-ref'
        || candidate.kind === 'openapi-s3-ref')
  );
}

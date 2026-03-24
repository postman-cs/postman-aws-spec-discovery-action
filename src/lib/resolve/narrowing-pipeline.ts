import type { RepoSignals } from '../repo/signals.js';
import type { CloudFormationSpecClient } from '../aws/cloudformation-client.js';
import type { TaggingSpecClient } from '../aws/tagging-client.js';

export interface NarrowingResult {
  gatewayIds: string[];
  tier: string;
  evidence: string[];
}

export interface NarrowingContext {
  repoSlug?: string;
  serviceHints: string[];
  signals: RepoSignals;
  cfnClient?: CloudFormationSpecClient;
  taggingClient?: TaggingSpecClient;
}

function slugifyRepoName(repoSlug?: string): string[] {
  if (!repoSlug) return [];
  const repoName = repoSlug.split('/').pop()?.trim() ?? '';
  if (!repoName) return [];

  const slugs = [repoName];
  // Strip common suffixes
  for (const suffix of ['-service', '-api', '-backend', '-server', '-app']) {
    if (repoName.endsWith(suffix)) {
      slugs.push(repoName.slice(0, -suffix.length));
    }
  }
  return slugs.filter((s) => s.length > 2);
}

/** T1: IaC fingerprinting -- extract gateway IDs already found by signal collection. */
function tierIacFingerprint(signals: RepoSignals): NarrowingResult | undefined {
  const ids = [...signals.explicitGatewayIdHints, ...signals.inferredGatewayIdHints];
  if (ids.length === 0) return undefined;
  return {
    gatewayIds: ids,
    tier: 'iac-fingerprint',
    evidence: [`IaC fingerprinting found ${ids.length} gateway ID(s) from repo files`]
  };
}

/** T2: CloudFormation stack correlation -- find stacks named after the repo. */
async function tierCloudFormationCorrelation(
  ctx: NarrowingContext
): Promise<NarrowingResult | undefined> {
  if (!ctx.cfnClient) return undefined;

  const slugs = slugifyRepoName(ctx.repoSlug);
  if (slugs.length === 0) return undefined;

  let stacks;
  try {
    stacks = await ctx.cfnClient.listActiveStacks();
  } catch {
    return undefined;
  }

  const matchingIds: string[] = [];
  const evidence: string[] = [];

  for (const stack of stacks) {
    const stackLower = stack.name.toLowerCase();
    const matches = slugs.some((slug) => stackLower.includes(slug.toLowerCase()));
    if (!matches) continue;

    try {
      const resources = await ctx.cfnClient.listApiResources(stack.name);
      for (const resource of resources) {
        if (resource.physicalId) {
          matchingIds.push(resource.physicalId);
          evidence.push(`Stack ${stack.name} contains ${resource.type} -> ${resource.physicalId}`);
        }
      }
    } catch {
      // Stack may not have API resources
    }
  }

  if (matchingIds.length === 0) return undefined;
  return { gatewayIds: matchingIds, tier: 'cfn-correlation', evidence };
}

/** T3: Resource Groups Tagging API -- find resources tagged with repo info. */
async function tierTagPreFilter(ctx: NarrowingContext): Promise<NarrowingResult | undefined> {
  if (!ctx.taggingClient) return undefined;
  if (!ctx.repoSlug) return undefined;

  const tagKeys = ['postman:repo', 'repository', 'repo', 'github:repository'];
  const tagValues = [ctx.repoSlug];

  // Also try just the repo name without the org
  const repoName = ctx.repoSlug.split('/').pop()?.trim();
  if (repoName) tagValues.push(repoName);

  const apiGatewayTypes = [
    'apigateway:restapis',
    'apigateway:apis'
  ];

  for (const tagKey of tagKeys) {
    try {
      const resources = await ctx.taggingClient.getResourcesByTag(tagKey, tagValues, apiGatewayTypes);
      if (resources.length === 0) continue;

      const ids = resources
        .map((r) => {
          // ARN format: arn:aws:apigateway:region::/restapis/API_ID or arn:aws:apigateway:region::/apis/API_ID
          const match = r.arn.match(/\/(?:restapis|apis)\/([a-z0-9_-]+)/);
          return match?.[1];
        })
        .filter((id): id is string => Boolean(id));

      if (ids.length > 0) {
        return {
          gatewayIds: ids,
          tier: 'tag-prefilter',
          evidence: [`Found ${ids.length} API(s) tagged with ${tagKey}=${tagValues.join('|')}`]
        };
      }
    } catch {
      // Tag key may not exist
    }
  }

  return undefined;
}

/** T4: Naming heuristic -- match repo slug against API names. */
function tierNamingHeuristic(
  candidateNames: { id: string; name: string }[],
  ctx: NarrowingContext
): NarrowingResult | undefined {
  const slugs = slugifyRepoName(ctx.repoSlug);
  if (slugs.length === 0) return undefined;

  const matches = candidateNames.filter((c) => {
    const nameLower = c.name.toLowerCase();
    return slugs.some((slug) => nameLower.includes(slug.toLowerCase()));
  });

  if (matches.length === 0) return undefined;
  return {
    gatewayIds: matches.map((m) => m.id),
    tier: 'naming-heuristic',
    evidence: [`Name matching narrowed ${candidateNames.length} candidates to ${matches.length} using repo slug`]
  };
}

/**
 * Run the progressive narrowing pipeline.
 * Returns the first tier that produces results, or undefined if all tiers fail.
 * The caller should only apply maxCandidates to the full enumeration (T5) if all tiers return undefined.
 */
export async function runNarrowingPipeline(
  ctx: NarrowingContext,
  allCandidates: { id: string; name: string }[]
): Promise<NarrowingResult | undefined> {
  // T1: IaC fingerprinting (local, no API calls)
  const t1 = tierIacFingerprint(ctx.signals);
  if (t1) return t1;

  // T2: CloudFormation stack correlation
  const t2 = await tierCloudFormationCorrelation(ctx);
  if (t2) return t2;

  // T3: Resource Groups Tagging API
  const t3 = await tierTagPreFilter(ctx);
  if (t3) return t3;

  // T4: Naming heuristic (uses already-enumerated candidates)
  const t4 = tierNamingHeuristic(allCandidates, ctx);
  if (t4) return t4;

  // T5: Full enumeration -- caller handles maxCandidates
  return undefined;
}

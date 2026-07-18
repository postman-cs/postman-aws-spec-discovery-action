import type { RepoSignals } from '../repo/signals.js';
import type { CloudFormationSpecClient } from '../aws/cloudformation-client.js';
import type { TaggingSpecClient } from '../aws/tagging-client.js';

export type NarrowingTier = 'iac-fingerprint' | 'cfn-correlation' | 'tag-prefilter' | 'naming-heuristic';
export type NarrowingMode = 'select' | 'narrow';

export interface NarrowingResult {
  gatewayIds: string[]; // intersecting enumerated IDs only, in tier order
  tier: NarrowingTier;
  mode: NarrowingMode;
  droppedCount: number; // count demoted behind the intersection, never physically deleted
  evidence: string[];
}

export interface NarrowingContext {
  repoSlug?: string;
  serviceHints: string[];
  signals: RepoSignals;
  cfnClient?: CloudFormationSpecClient;
  taggingClient?: TaggingSpecClient;
}

interface TierHit {
  ids: string[]; // raw tier-produced IDs (may include unknown/duplicates)
  selectId?: string; // set only for exactly one exact canonical postman:repo match
  evidence: string[];
}

function slugifyRepoName(repoSlug?: string): string[] {
  if (!repoSlug) return [];
  const repoName = repoSlug.split('/').pop()?.trim() ?? '';
  if (!repoName) return [];

  const slugs = [repoName];
  for (const suffix of ['-service', '-api', '-backend', '-server', '-app']) {
    if (repoName.endsWith(suffix)) {
      slugs.push(repoName.slice(0, -suffix.length));
    }
  }
  return slugs.filter((s) => s.length > 2);
}

/** T1: IaC fingerprinting -- extract gateway IDs already found by signal collection. Never selects. */
function tierIacFingerprint(signals: RepoSignals): TierHit | undefined {
  const ids = [...signals.explicitGatewayIdHints, ...signals.inferredGatewayIdHints];
  if (ids.length === 0) return undefined;
  return {
    ids,
    evidence: [`IaC fingerprinting found ${ids.length} gateway ID(s) from repo files`]
  };
}

/** T2: CloudFormation stack correlation -- find stacks named after the repo. Never selects. */
async function tierCloudFormationCorrelation(ctx: NarrowingContext): Promise<TierHit | undefined> {
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
  return { ids: matchingIds, evidence };
}

const CANONICAL_REPO_TAG = 'postman:repo';
const GENERIC_TAG_KEYS = ['repo', 'repository', 'service', 'github:repository'];

/** T3: Resource Groups Tagging API. Only one exact canonical postman:repo=<repoSlug> match may select. */
async function tierTagPreFilter(ctx: NarrowingContext): Promise<TierHit | undefined> {
  if (!ctx.taggingClient) return undefined;
  if (!ctx.repoSlug) return undefined;

  const repoName = ctx.repoSlug.split('/').pop()?.trim();
  const apiGatewayTypes = ['apigateway:restapis', 'apigateway:apis'];

  const extractId = (arn: string): string | undefined =>
    arn.match(/\/(?:restapis|apis)\/([a-z0-9_-]+)/)?.[1];

  // Canonical key first: exact postman:repo=<repoSlug>. Track how many enumerated-distinct IDs match exactly.
  try {
    const canonical = await ctx.taggingClient.getResourcesByTag(CANONICAL_REPO_TAG, [ctx.repoSlug], apiGatewayTypes);
    const exactIds = canonical
      .filter((r) => (r.tags?.[CANONICAL_REPO_TAG] ?? '') === ctx.repoSlug)
      .map((r) => extractId(r.arn))
      .filter((id): id is string => Boolean(id));
    const uniqueExact = [...new Set(exactIds)];
    if (uniqueExact.length === 1) {
      return {
        ids: uniqueExact,
        selectId: uniqueExact[0],
        evidence: [`Exactly one API tagged ${CANONICAL_REPO_TAG}=${ctx.repoSlug}`]
      };
    }
    if (uniqueExact.length > 1) {
      // Two or more exact canonical matches: ambiguity, narrow only.
      return {
        ids: uniqueExact,
        evidence: [`Found ${uniqueExact.length} APIs tagged ${CANONICAL_REPO_TAG}=${ctx.repoSlug}`]
      };
    }
  } catch {
    // canonical tag key may not exist
  }

  // Generic keys: boost/narrow evidence only, never select.
  const tagValues = [ctx.repoSlug];
  if (repoName) tagValues.push(repoName);
  for (const tagKey of [CANONICAL_REPO_TAG, ...GENERIC_TAG_KEYS]) {
    try {
      const resources = await ctx.taggingClient.getResourcesByTag(tagKey, tagValues, apiGatewayTypes);
      if (resources.length === 0) continue;
      const ids = resources.map((r) => extractId(r.arn)).filter((id): id is string => Boolean(id));
      if (ids.length > 0) {
        return {
          ids,
          evidence: [`Found ${ids.length} API(s) tagged with ${tagKey}=${tagValues.join('|')}`]
        };
      }
    } catch {
      // Tag key may not exist
    }
  }
  return undefined;
}

/** T4: Naming heuristic -- match repo slug against API names. Rank signal only, never selects. */
function tierNamingHeuristic(candidateNames: { id: string; name: string }[], ctx: NarrowingContext): TierHit | undefined {
  const slugs = slugifyRepoName(ctx.repoSlug);
  if (slugs.length === 0) return undefined;
  const matches = candidateNames.filter((c) => {
    const nameLower = c.name.toLowerCase();
    return slugs.some((slug) => nameLower.includes(slug.toLowerCase()));
  });
  if (matches.length === 0) return undefined;
  return {
    ids: matches.map((m) => m.id),
    evidence: [`Name matching narrowed ${candidateNames.length} candidates to ${matches.length} using repo slug`]
  };
}

/**
 * Run the progressive narrowing pipeline.
 * Tier order: iac-fingerprint -> cfn-correlation -> tag-prefilter -> naming-heuristic.
 * A tier whose intersection with the enumerated set is empty falls through to the next tier.
 * Unknown IDs are ignored, duplicates de-duplicated, each enumerated candidate appears once.
 * mode 'select' is reserved for exactly one exact canonical postman:repo=<repoSlug> match.
 */
export async function runNarrowingPipeline(
  ctx: NarrowingContext,
  allCandidates: { id: string; name: string }[]
): Promise<NarrowingResult | undefined> {
  const enumeratedIds = allCandidates.map((c) => c.id);
  const enumeratedSet = new Set(enumeratedIds);

  const tiers: Array<{ tier: NarrowingTier; run: () => Promise<TierHit | undefined> | TierHit | undefined }> = [
    { tier: 'iac-fingerprint', run: () => tierIacFingerprint(ctx.signals) },
    { tier: 'cfn-correlation', run: () => tierCloudFormationCorrelation(ctx) },
    { tier: 'tag-prefilter', run: () => tierTagPreFilter(ctx) },
    { tier: 'naming-heuristic', run: () => tierNamingHeuristic(allCandidates, ctx) }
  ];

  for (const { tier, run } of tiers) {
    const hit = await run();
    if (!hit) continue;
    // Intersect with enumerated set, dedup, preserve tier order then enumeration order for stability.
    const intersecting: string[] = [];
    const seen = new Set<string>();
    for (const id of hit.ids) {
      if (enumeratedSet.has(id) && !seen.has(id)) {
        seen.add(id);
        intersecting.push(id);
      }
    }
    if (intersecting.length === 0) continue; // zero-intersection: fall through to next tier

    const demoted = allCandidates.length - intersecting.length;
    const isSelect = hit.selectId !== undefined && intersecting.length === 1 && intersecting[0] === hit.selectId;
    return {
      gatewayIds: intersecting,
      tier,
      mode: isSelect ? 'select' : 'narrow',
      droppedCount: demoted,
      evidence: [
        ...hit.evidence,
        `Narrowing (${tier}) ranked ${intersecting.length} candidate(s) first and demoted ${demoted} (not deleted)`
      ]
    };
  }
  return undefined;
}

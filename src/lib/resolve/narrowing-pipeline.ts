import type { RepoSignals } from '../repo/signals.js';
import type { CloudFormationSpecClient } from '../aws/cloudformation-client.js';
import type { TaggedResource, TaggingSpecClient } from '../aws/tagging-client.js';

export type NarrowingTier = 'iac-fingerprint' | 'cfn-correlation' | 'tag-prefilter' | 'naming-heuristic';
export type NarrowingMode = 'select' | 'narrow';
export type ExactRepoTagContract = 'postman:repo' | 'GithubOrg+GithubRepo';

export interface NarrowingResult {
  gatewayIds: string[]; // intersecting enumerated IDs only, in tier order
  tier: NarrowingTier;
  mode: NarrowingMode;
  droppedCount: number; // count demoted behind the intersection, never physically deleted
  evidence: string[];
  /** Present when the tag-prefilter tier produced an exact select-grade match set. */
  tagContract?: ExactRepoTagContract;
}

export interface NarrowingContext {
  repoSlug?: string;
  serviceHints: string[];
  signals: RepoSignals;
  cfnClient?: CloudFormationSpecClient;
  taggingClient?: TaggingSpecClient;
}

export interface ExactTagCorrelationResult {
  gatewayIds: string[];
  mode: NarrowingMode;
  selectId?: string;
  tagContract: ExactRepoTagContract;
  evidence: string[];
}

interface TierHit {
  ids: string[]; // raw tier-produced IDs (may include unknown/duplicates)
  selectId?: string; // set only for exactly one exact select-grade repo-tag match
  evidence: string[];
  tagContract?: ExactRepoTagContract;
}

const CANONICAL_REPO_TAG = 'postman:repo';
const FOX_ORG_TAG = 'GithubOrg';
const FOX_REPO_TAG = 'GithubRepo';
const GENERIC_TAG_KEYS = ['repo', 'repository', 'service', 'github:repository'];
const API_GATEWAY_RESOURCE_TYPES = ['apigateway:restapis', 'apigateway:apis'];

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

/** Normalize owner/repo identity values: trim, strip trailing .git, casefold. */
export function normalizeRepoIdentity(value: string): string {
  return value.trim().replace(/\.git$/i, '').toLowerCase();
}

/** Exact identity compare after safe value normalization (AWS tag keys stay case-sensitive elsewhere). */
export function repoIdentityEquals(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  const a = normalizeRepoIdentity(left);
  const b = normalizeRepoIdentity(right);
  return a.length > 0 && a === b;
}

export function parseRepoSlug(repoSlug: string): { owner: string; repo: string } | undefined {
  const parts = repoSlug.split('/').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return undefined;
  const owner = parts[0];
  const repo = parts.slice(1).join('/');
  if (!owner || !repo) return undefined;
  return { owner, repo };
}

export function extractGatewayIdFromArn(arn: string): string | undefined {
  return arn.match(/\/(?:restapis|apis)\/([a-z0-9_-]+)/i)?.[1];
}

/**
 * Select-grade repo tag contract on a tag bag: canonical postman:repo first, then
 * Fox GithubOrg+GithubRepo conjunction. Generic/fuzzy keys never match here.
 */
export function matchExactRepoTagContract(
  tags: Record<string, string> | undefined,
  repoSlug: string
): ExactRepoTagContract | undefined {
  if (!tags) return undefined;
  if (repoIdentityEquals(tags[CANONICAL_REPO_TAG], repoSlug)) {
    return 'postman:repo';
  }
  const parsed = parseRepoSlug(repoSlug);
  if (!parsed) return undefined;
  if (repoIdentityEquals(tags[FOX_ORG_TAG], parsed.owner) && repoIdentityEquals(tags[FOX_REPO_TAG], parsed.repo)) {
    return 'GithubOrg+GithubRepo';
  }
  return undefined;
}

function uniqueSortedIds(ids: Array<string | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function toExactResult(ids: string[], tagContract: ExactRepoTagContract, evidence: string[]): ExactTagCorrelationResult {
  if (ids.length === 1) {
    return {
      gatewayIds: ids,
      mode: 'select',
      selectId: ids[0],
      tagContract,
      evidence
    };
  }
  return {
    gatewayIds: ids,
    mode: 'narrow',
    tagContract,
    evidence
  };
}

/**
 * Exact repository tag correlation (canonical postman:repo, then Fox GithubOrg+GithubRepo).
 * Fail-soft on permission denial. One match may select; multiple exact matches stay ambiguity-safe.
 */
export async function correlateExactRepoTags(
  ctx: Pick<NarrowingContext, 'repoSlug' | 'taggingClient'>
): Promise<ExactTagCorrelationResult | undefined> {
  if (!ctx.taggingClient || !ctx.repoSlug) return undefined;
  const repoSlug = ctx.repoSlug;
  const parsed = parseRepoSlug(repoSlug);
  if (!parsed) return undefined;

  // Canonical first: exact postman:repo=<owner>/<repo>
  // Prefer value filter, then key-only fallback so mixed-case identity values still match after normalize.
  try {
    let canonical = await ctx.taggingClient.getResourcesByTag(CANONICAL_REPO_TAG, [repoSlug], API_GATEWAY_RESOURCE_TYPES);
    let exactIds = uniqueSortedIds(
      canonical
        .filter((resource) => repoIdentityEquals(resource.tags?.[CANONICAL_REPO_TAG], repoSlug))
        .map((resource) => extractGatewayIdFromArn(resource.arn))
    );
    if (exactIds.length === 0) {
      canonical = await ctx.taggingClient.getResourcesByTag(CANONICAL_REPO_TAG, [], API_GATEWAY_RESOURCE_TYPES);
      exactIds = uniqueSortedIds(
        canonical
          .filter((resource) => repoIdentityEquals(resource.tags?.[CANONICAL_REPO_TAG], repoSlug))
          .map((resource) => extractGatewayIdFromArn(resource.arn))
      );
    }
    if (exactIds.length === 1) {
      return toExactResult(exactIds, 'postman:repo', [
        `Matched tag contract postman:repo`,
        `Exactly one API tagged ${CANONICAL_REPO_TAG} for repository identity`
      ]);
    }
    if (exactIds.length > 1) {
      return toExactResult(exactIds, 'postman:repo', [
        `Matched tag contract postman:repo`,
        `Found ${exactIds.length} APIs tagged ${CANONICAL_REPO_TAG} for repository identity (per-environment ambiguity retained)`
      ]);
    }
  } catch {
    // Permission denial or missing key: fail soft and try Fox contract.
  }

  // Fox conjunction: resources that have BOTH GithubOrg and GithubRepo keys (AND filters),
  // then client-side identity normalize. Key-only filters preserve AWS key case while allowing
  // mixed-case owner/repo values. Covers REST (/restapis/) and HTTP/WebSocket (/apis/) ARNs.
  try {
    const foxResources = await ctx.taggingClient.getResourcesByTags(
      [{ key: FOX_ORG_TAG }, { key: FOX_REPO_TAG }],
      API_GATEWAY_RESOURCE_TYPES
    );
    const exactIds = uniqueSortedIds(
      foxResources
        .filter(
          (resource) =>
            repoIdentityEquals(resource.tags?.[FOX_ORG_TAG], parsed.owner) &&
            repoIdentityEquals(resource.tags?.[FOX_REPO_TAG], parsed.repo)
        )
        .map((resource) => extractGatewayIdFromArn(resource.arn))
    );
    if (exactIds.length === 1) {
      return toExactResult(exactIds, 'GithubOrg+GithubRepo', [
        `Matched tag contract GithubOrg+GithubRepo`,
        `Exactly one API tagged ${FOX_ORG_TAG}+${FOX_REPO_TAG} for repository identity`
      ]);
    }
    if (exactIds.length > 1) {
      return toExactResult(exactIds, 'GithubOrg+GithubRepo', [
        `Matched tag contract GithubOrg+GithubRepo`,
        `Found ${exactIds.length} APIs tagged ${FOX_ORG_TAG}+${FOX_REPO_TAG} for repository identity (per-environment ambiguity retained)`
      ]);
    }
  } catch {
    // Permission denial or missing keys: fail soft.
  }

  return undefined;
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

/** T3: Resource Groups Tagging API. Exact select-grade contracts may select; generic tags never select. */
async function tierTagPreFilter(ctx: NarrowingContext): Promise<TierHit | undefined> {
  if (!ctx.taggingClient) return undefined;
  if (!ctx.repoSlug) return undefined;

  const exact = await correlateExactRepoTags(ctx);
  if (exact) {
    return {
      ids: exact.gatewayIds,
      selectId: exact.selectId,
      evidence: exact.evidence,
      tagContract: exact.tagContract
    };
  }

  const repoName = ctx.repoSlug.split('/').pop()?.trim();
  const tagValues = [ctx.repoSlug];
  if (repoName) tagValues.push(repoName);

  // Generic keys: boost/narrow evidence only, never select.
  for (const tagKey of [CANONICAL_REPO_TAG, ...GENERIC_TAG_KEYS]) {
    try {
      const resources: TaggedResource[] = await ctx.taggingClient.getResourcesByTag(
        tagKey,
        tagValues,
        API_GATEWAY_RESOURCE_TYPES
      );
      if (resources.length === 0) continue;
      const ids = uniqueSortedIds(resources.map((r) => extractGatewayIdFromArn(r.arn)));
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
 * mode 'select' is reserved for exactly one select-grade repo-tag match (postman:repo or Fox pair).
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
      tagContract: hit.tagContract,
      evidence: [
        ...hit.evidence,
        `Narrowing (${tier}) ranked ${intersecting.length} candidate(s) first and demoted ${demoted} (not deleted)`
      ]
    };
  }
  return undefined;
}

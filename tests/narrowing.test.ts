import { describe, expect, it, vi } from 'vitest';

import {
  correlateExactRepoTags,
  matchExactRepoTagContract,
  repoIdentityEquals,
  runNarrowingPipeline
} from '../src/lib/resolve/narrowing-pipeline.js';
import { resolveServiceCandidate } from '../src/lib/resolve/service-resolver.js';
import { chooseSource } from '../src/lib/resolve/source-selector.js';
import type { RepoSignals } from '../src/lib/repo/signals.js';
import type { CloudFormationSpecClient } from '../src/lib/aws/cloudformation-client.js';
import type { TaggedResource, TagFilterSpec, TaggingSpecClient } from '../src/lib/aws/tagging-client.js';

function createSignals(overrides: Partial<RepoSignals> = {}): RepoSignals {
  return {
    serviceHints: [],
    explicitGatewayIdHints: [],
    inferredGatewayIdHints: [],
    evidence: [],
    ...overrides
  };
}

/** Build a TaggingSpecClient double that satisfies getResourcesByTags via conjunctive simulation. */
function createTaggingClientStub(
  byKey: (tagKey: string, tagValues: string[]) => Promise<TaggedResource[]> | TaggedResource[]
): TaggingSpecClient {
  const getResourcesByTag = vi.fn().mockImplementation(async (tagKey: string, tagValues: string[]) => byKey(tagKey, tagValues));
  const getResourcesByTags = vi.fn().mockImplementation(async (filters: TagFilterSpec[]) => {
    if (filters.length === 0) return [];
    let items = await byKey(filters[0].key, filters[0].values ?? []);
    for (const filter of filters.slice(1)) {
      const next = await byKey(filter.key, filter.values ?? []);
      const nextByArn = new Map(next.map((resource) => [resource.arn, resource]));
      items = items
        .filter((resource) => nextByArn.has(resource.arn))
        .map((resource) => ({
          arn: resource.arn,
          tags: { ...resource.tags, ...nextByArn.get(resource.arn)?.tags }
        }));
    }
    return items;
  });
  return {
    getResourcesByTag,
    getResourcesByTags,
    probe: vi.fn().mockResolvedValue(true)
  };
}

const allCandidates = [
  { id: 'rest-1', name: 'payments-api' },
  { id: 'rest-2', name: 'auth-service-prod' },
  { id: 'rest-3', name: 'internal-tools' },
  { id: 'http-1', name: 'checkout-http' }
];

describe('runNarrowingPipeline', () => {
  it('T1: returns IaC-fingerprinted gateway IDs when present', async () => {
    const result = await runNarrowingPipeline(
      {
        repoSlug: 'org/payments',
        serviceHints: ['payments'],
        signals: createSignals({ inferredGatewayIdHints: ['rest-1'] })
      },
      allCandidates
    );
    expect(result?.tier).toBe('iac-fingerprint');
    expect(result?.gatewayIds).toEqual(['rest-1']);
  });

  it('T2: correlates CloudFormation stacks by repo slug', async () => {
    const cfnClient: CloudFormationSpecClient = {
      listActiveStacks: vi.fn().mockResolvedValue([
        { name: 'auth-service-prod', id: 'stack-1', status: 'CREATE_COMPLETE' },
        { name: 'unrelated-stack', id: 'stack-2', status: 'CREATE_COMPLETE' }
      ]),
      listApiResources: vi.fn().mockImplementation(async (stackName: string) => {
        if (stackName === 'auth-service-prod') {
          return [{ logicalId: 'Api', physicalId: 'rest-2', type: 'AWS::ApiGateway::RestApi' }];
        }
        return [];
      }),
      getTemplate: vi.fn().mockResolvedValue('{}'),
      getStackTags: vi.fn().mockResolvedValue({}),
      probe: vi.fn().mockResolvedValue(true)
    };

    const result = await runNarrowingPipeline(
      {
        repoSlug: 'org/auth-service',
        serviceHints: ['auth-service'],
        signals: createSignals(),
        cfnClient
      },
      allCandidates
    );
    expect(result?.tier).toBe('cfn-correlation');
    expect(result?.gatewayIds).toContain('rest-2');
  });

  it('T3: filters by tag when tagging client is available', async () => {
    const taggingClient = createTaggingClientStub(async (tagKey, tagValues) => {
      if (tagKey === 'postman:repo' && tagValues.includes('org/payments')) {
        return [{ arn: 'arn:aws:apigateway:us-east-1::/restapis/rest-1', tags: { 'postman:repo': 'org/payments' } }];
      }
      return [];
    });

    const result = await runNarrowingPipeline(
      {
        repoSlug: 'org/payments',
        serviceHints: ['payments'],
        signals: createSignals(),
        taggingClient
      },
      allCandidates
    );
    expect(result?.tier).toBe('tag-prefilter');
    expect(result?.gatewayIds).toEqual(['rest-1']);
  });

  it('T4: falls back to naming heuristic', async () => {
    const result = await runNarrowingPipeline(
      {
        repoSlug: 'org/auth-service',
        serviceHints: ['auth-service'],
        signals: createSignals()
      },
      allCandidates
    );
    expect(result?.tier).toBe('naming-heuristic');
    expect(result?.gatewayIds).toEqual(['rest-2']);
  });

  it('returns undefined when no tier matches', async () => {
    const result = await runNarrowingPipeline(
      {
        repoSlug: 'org/unknown-thing',
        serviceHints: ['unknown-thing'],
        signals: createSignals()
      },
      allCandidates
    );
    expect(result).toBeUndefined();
  });

  it('stops at first matching tier', async () => {
    const cfnClient: CloudFormationSpecClient = {
      listActiveStacks: vi.fn().mockResolvedValue([]),
      listApiResources: vi.fn().mockResolvedValue([]),
      getTemplate: vi.fn().mockResolvedValue('{}'),
      getStackTags: vi.fn().mockResolvedValue({}),
      probe: vi.fn().mockResolvedValue(true)
    };

    // T1 has explicit IDs, should stop there even though cfn client exists
    const result = await runNarrowingPipeline(
      {
        repoSlug: 'org/auth-service',
        serviceHints: ['auth-service'],
        signals: createSignals({ explicitGatewayIdHints: ['rest-2'] }),
        cfnClient
      },
      allCandidates
    );
    expect(result?.tier).toBe('iac-fingerprint');
    expect(cfnClient.listActiveStacks).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// U1.x: partition-based progressive narrowing (v2.1)
// ---------------------------------------------------------------------------

describe('U1 partition-based narrowing', () => {
  it('U1.1 partition-never-delete: intersection first, all candidates retained, droppedCount counts demoted', async () => {
    const all = [
      { id: 'a', name: 'alpha' },
      { id: 'b', name: 'beta' },
      { id: 'c', name: 'gamma' },
      { id: 'd', name: 'delta' }
    ];
    const result = await runNarrowingPipeline(
      { repoSlug: 'org/x', serviceHints: [], signals: createSignals({ inferredGatewayIdHints: ['c'] }) },
      all
    );
    expect(result?.mode).toBe('narrow');
    expect(result?.gatewayIds).toEqual(['c']);
    expect(result?.droppedCount).toBe(3);
    // evidence must say demoted, not deleted
    expect(result?.evidence.join(' ')).toMatch(/demoted 3.*not deleted/i);
    // pipeline result must never be destructive: intersecting IDs are a subset, not a filter
    expect(result?.gatewayIds.length).toBe(1);
  });

  it('U1.2 zero-intersection fallthrough: stale IaC ID yields later naming tier, not iac', async () => {
    const all = [
      { id: 'rest-1', name: 'unrelated' },
      { id: 'rest-2', name: 'auth-service-prod' },
      { id: 'rest-3', name: 'other' }
    ];
    const result = await runNarrowingPipeline(
      {
        repoSlug: 'org/auth-service',
        serviceHints: ['auth-service'],
        signals: createSignals({ inferredGatewayIdHints: ['stale-id'] })
      },
      all
    );
    expect(result?.tier).toBe('naming-heuristic');
    expect(result?.tier).not.toBe('iac-fingerprint');
    expect(result?.gatewayIds).toEqual(['rest-2']);
  });

  it('U1.3 naming-gate-single: single fuzzy match is narrow/boost only, never select', async () => {
    const all = [
      { id: 'r1', name: 'zzz' },
      { id: 'r2', name: 'payments-api-prod' },
      { id: 'r3', name: 'yyy' }
    ];
    const result = await runNarrowingPipeline(
      { repoSlug: 'org/payments-api', serviceHints: [], signals: createSignals() },
      all
    );
    expect(result?.tier).toBe('naming-heuristic');
    expect(result?.mode).toBe('narrow');
    expect(result?.gatewayIds).toEqual(['r2']);
  });

  it('U1.5 canonical-tag-only-auto-resolve: exactly one exact postman:repo match selects', async () => {
    const taggingClient = createTaggingClientStub(async (key, values) => {
      if (key === 'postman:repo' && values.includes('org/payments')) {
        return [{ arn: 'arn:aws:apigateway:us-east-1::/restapis/rest-9', tags: { 'postman:repo': 'org/payments' } }];
      }
      return [];
    });
    const all = [{ id: 'rest-9', name: 'x' }, { id: 'rest-1', name: 'y' }];
    const result = await runNarrowingPipeline(
      { repoSlug: 'org/payments', serviceHints: [], signals: createSignals(), taggingClient },
      all
    );
    expect(result?.mode).toBe('select');
    expect(result?.gatewayIds).toEqual(['rest-9']);
    expect(result?.tagContract).toBe('postman:repo');
  });

  it('U1.5b two exact canonical matches do NOT select (ambiguity retained)', async () => {
    const taggingClient = createTaggingClientStub(async (key) => {
      if (key === 'postman:repo') {
        return [
          { arn: 'arn:aws:apigateway:us-east-1::/restapis/a', tags: { 'postman:repo': 'org/payments' } },
          { arn: 'arn:aws:apigateway:us-east-1::/restapis/b', tags: { 'postman:repo': 'org/payments' } }
        ];
      }
      return [];
    });
    const all = [{ id: 'a', name: 'x' }, { id: 'b', name: 'y' }];
    const result = await runNarrowingPipeline(
      { repoSlug: 'org/payments', serviceHints: [], signals: createSignals(), taggingClient },
      all
    );
    expect(result?.mode).toBe('narrow');
    expect(result?.gatewayIds).toEqual(['a', 'b']);
  });

  it('U1.6 generic-tag boost-only: repo/repository/service/github:repository never select', async () => {
    for (const key of ['repo', 'repository', 'service', 'github:repository']) {
      const taggingClient = createTaggingClientStub(async (k, values) => {
        if (k === 'postman:repo') return []; // no canonical match
        if (k === 'GithubOrg' || k === 'GithubRepo') return [];
        if (k === key) return [{ arn: 'arn:aws:apigateway:us-east-1::/restapis/rest-1', tags: { [key]: values[0] } }];
        return [];
      });
      const all = [{ id: 'rest-1', name: 'x' }, { id: 'rest-2', name: 'y' }];
      const result = await runNarrowingPipeline(
        { repoSlug: 'org/payments', serviceHints: [], signals: createSignals(), taggingClient },
        all
      );
      expect(result?.mode, `tag key ${key} must not select`).toBe('narrow');
    }
  });


  it('U1.4 naming-gate-multi: two fuzzy matches both retained and equal top confidence yields unresolved manual-review', async () => {
    const all = [
      { id: 'r1', name: 'payments-api' },
      { id: 'r2', name: 'payments-api-copy' },
      { id: 'r3', name: 'unrelated' }
    ];
    const result = await runNarrowingPipeline(
      { repoSlug: 'org/payments-api', serviceHints: [], signals: createSignals() },
      all
    );
    // Pipeline: both fuzzy matches retained together, never truncated to one, never select.
    expect(result?.tier).toBe('naming-heuristic');
    expect(result?.mode).toBe('narrow');
    expect(result?.gatewayIds).toEqual(['r1', 'r2']);
    expect(result?.droppedCount).toBe(1);

    // Resolution: equal top confidence across both matches is ambiguous -> unresolved manual-review.
    const candidate = resolveServiceCandidate(
      [
        { id: 'r1', name: 'payments-api', gatewayType: 'REST', tags: {} },
        { id: 'r2', name: 'payments-api-copy', gatewayType: 'REST', tags: {} }
      ],
      { serviceHints: ['payments'], explicitGatewayIdHints: [], inferredGatewayIdHints: [], evidence: [] }
    );
    expect(candidate?.ambiguous).toBe(true);
    const chosen = chooseSource({ fallbackServiceName: 'payments', candidate });
    expect(chosen.status).toBe('unresolved');
    expect(chosen.sourceType).toBe('manual-review');
    expect(chosen.evidence.length).toBeGreaterThan(0);
    expect(chosen.evidence.join(' ')).toMatch(/ambiguous/i);
  });

  it('U1.2b unknown IDs ignored and duplicates de-duplicated', async () => {
    const all = [{ id: 'a', name: 'x' }, { id: 'b', name: 'y' }];
    const result = await runNarrowingPipeline(
      { repoSlug: 'org/x', serviceHints: [], signals: createSignals({ inferredGatewayIdHints: ['a', 'a', 'unknown-id', 'b'] }) },
      all
    );
    expect(result?.gatewayIds).toEqual(['a', 'b']);
  });
});

describe('POS-392 exact repo tag correlation', () => {
  it('canonical postman:repo selects exactly one REST match', async () => {
    const taggingClient = createTaggingClientStub(async (key, values) => {
      if (key === 'postman:repo' && values.includes('org/payments')) {
        return [{ arn: 'arn:aws:apigateway:us-east-1::/restapis/rest-1', tags: { 'postman:repo': 'org/payments' } }];
      }
      return [];
    });
    const result = await correlateExactRepoTags({ repoSlug: 'org/payments', taggingClient });
    expect(result?.mode).toBe('select');
    expect(result?.tagContract).toBe('postman:repo');
    expect(result?.gatewayIds).toEqual(['rest-1']);
  });

  it('the customer GithubOrg+GithubRepo conjunction selects one HTTP API', async () => {
    const taggingClient = createTaggingClientStub(async (key) => {
      if (key === 'postman:repo') return [];
      if (key === 'GithubOrg' || key === 'GithubRepo') {
        return [
          {
            arn: 'arn:aws:apigateway:us-east-1::/apis/http-1',
            tags: { GithubOrg: 'org', GithubRepo: 'payments' }
          }
        ];
      }
      return [];
    });
    const result = await correlateExactRepoTags({ repoSlug: 'org/payments', taggingClient });
    expect(result?.mode).toBe('select');
    expect(result?.tagContract).toBe('GithubOrg+GithubRepo');
    expect(result?.gatewayIds).toEqual(['http-1']);
    expect(taggingClient.getResourcesByTags).toHaveBeenCalledWith(
      [{ key: 'GithubOrg' }, { key: 'GithubRepo' }],
      ['apigateway:restapis', 'apigateway:apis']
    );
  });

  it('GithubOrg/GithubRepo conjunction matches WebSocket /apis ARN and mixed-case identity values', async () => {
    const taggingClient = createTaggingClientStub(async (key) => {
      if (key === 'postman:repo') return [];
      if (key === 'GithubOrg' || key === 'GithubRepo') {
        return [
          {
            arn: 'arn:aws:apigateway:us-east-1::/apis/ws-9',
            tags: { GithubOrg: 'Org', GithubRepo: 'Payments' }
          }
        ];
      }
      return [];
    });
    const result = await correlateExactRepoTags({ repoSlug: 'org/payments', taggingClient });
    expect(result?.mode).toBe('select');
    expect(result?.gatewayIds).toEqual(['ws-9']);
    expect(repoIdentityEquals('Org', 'org')).toBe(true);
    expect(matchExactRepoTagContract({ GithubOrg: 'Org', GithubRepo: 'Payments.git' }, 'org/payments')).toBe(
      'GithubOrg+GithubRepo'
    );
  });

  it('canonical tier wins over the customer when both are present', async () => {
    const taggingClient = createTaggingClientStub(async (key) => {
      if (key === 'postman:repo') {
        return [{ arn: 'arn:aws:apigateway:us-east-1::/restapis/canonical-1', tags: { 'postman:repo': 'org/payments' } }];
      }
      if (key === 'GithubOrg' || key === 'GithubRepo') {
        return [{ arn: 'arn:aws:apigateway:us-east-1::/apis/github-org-repo-1', tags: { GithubOrg: 'org', GithubRepo: 'payments' } }];
      }
      return [];
    });
    const result = await correlateExactRepoTags({ repoSlug: 'org/payments', taggingClient });
    expect(result?.tagContract).toBe('postman:repo');
    expect(result?.gatewayIds).toEqual(['canonical-1']);
  });

  it('wrong org, wrong repo, or missing the customer half do not match', async () => {
    const cases: Array<{ label: string; byKey: (key: string) => TaggedResource[] }> = [
      {
        label: 'wrong org',
        byKey: (key) =>
          key === 'GithubOrg' || key === 'GithubRepo'
            ? [{ arn: 'arn:aws:apigateway:us-east-1::/restapis/r1', tags: { GithubOrg: 'other', GithubRepo: 'payments' } }]
            : []
      },
      {
        label: 'wrong repo',
        byKey: (key) =>
          key === 'GithubOrg' || key === 'GithubRepo'
            ? [{ arn: 'arn:aws:apigateway:us-east-1::/restapis/r1', tags: { GithubOrg: 'org', GithubRepo: 'other' } }]
            : []
      },
      {
        label: 'missing GithubRepo',
        byKey: (key) =>
          key === 'GithubOrg'
            ? [{ arn: 'arn:aws:apigateway:us-east-1::/restapis/r1', tags: { GithubOrg: 'org' } }]
            : []
      },
      {
        label: 'missing GithubOrg',
        byKey: (key) =>
          key === 'GithubRepo'
            ? [{ arn: 'arn:aws:apigateway:us-east-1::/restapis/r1', tags: { GithubRepo: 'payments' } }]
            : []
      }
    ];
    for (const testCase of cases) {
      const taggingClient = createTaggingClientStub(async (key) => testCase.byKey(key));
      const result = await correlateExactRepoTags({ repoSlug: 'org/payments', taggingClient });
      expect(result, testCase.label).toBeUndefined();
    }
  });

  it('multiple exact the customer per-environment matches remain narrow and deterministically ordered', async () => {
    const taggingClient = createTaggingClientStub(async (key) => {
      if (key === 'postman:repo') return [];
      if (key === 'GithubOrg' || key === 'GithubRepo') {
        return [
          { arn: 'arn:aws:apigateway:us-east-1::/restapis/b-env', tags: { GithubOrg: 'org', GithubRepo: 'payments', Environment: 'qa' } },
          { arn: 'arn:aws:apigateway:us-east-1::/restapis/a-env', tags: { GithubOrg: 'org', GithubRepo: 'payments', Environment: 'prod' } }
        ];
      }
      return [];
    });
    const result = await correlateExactRepoTags({ repoSlug: 'org/payments', taggingClient });
    expect(result?.mode).toBe('narrow');
    expect(result?.gatewayIds).toEqual(['a-env', 'b-env']);
    expect(result?.evidence.join(' ')).toMatch(/per-environment ambiguity retained/i);
  });

  it('permission denial fails soft without throwing', async () => {
    const taggingClient: TaggingSpecClient = {
      getResourcesByTag: vi.fn().mockRejectedValue(new Error('AccessDenied')),
      getResourcesByTags: vi.fn().mockRejectedValue(new Error('AccessDenied')),
      probe: vi.fn().mockResolvedValue(false)
    };
    await expect(correlateExactRepoTags({ repoSlug: 'org/payments', taggingClient })).resolves.toBeUndefined();
  });

  it('pipeline the customer select and multi-match retain tagContract evidence', async () => {
    const one = createTaggingClientStub(async (key) => {
      if (key === 'postman:repo') return [];
      if (key === 'GithubOrg' || key === 'GithubRepo') {
        return [{ arn: 'arn:aws:apigateway:us-east-1::/restapis/rest-1', tags: { GithubOrg: 'org', GithubRepo: 'payments' } }];
      }
      return [];
    });
    const selected = await runNarrowingPipeline(
      { repoSlug: 'org/payments', serviceHints: [], signals: createSignals(), taggingClient: one },
      [
        { id: 'rest-1', name: 'payments-dev' },
        { id: 'rest-2', name: 'other' }
      ]
    );
    expect(selected?.mode).toBe('select');
    expect(selected?.tagContract).toBe('GithubOrg+GithubRepo');

    const many = createTaggingClientStub(async (key) => {
      if (key === 'postman:repo') return [];
      if (key === 'GithubOrg' || key === 'GithubRepo') {
        return [
          { arn: 'arn:aws:apigateway:us-east-1::/restapis/rest-1', tags: { GithubOrg: 'org', GithubRepo: 'payments' } },
          { arn: 'arn:aws:apigateway:us-east-1::/apis/http-1', tags: { GithubOrg: 'org', GithubRepo: 'payments' } }
        ];
      }
      return [];
    });
    const ambiguous = await runNarrowingPipeline(
      { repoSlug: 'org/payments', serviceHints: [], signals: createSignals(), taggingClient: many },
      [
        { id: 'rest-1', name: 'payments-dev' },
        { id: 'http-1', name: 'payments-prod' },
        { id: 'rest-2', name: 'other' }
      ]
    );
    expect(ambiguous?.mode).toBe('narrow');
    expect(ambiguous?.gatewayIds).toEqual(['http-1', 'rest-1']);
  });
});

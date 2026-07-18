import { describe, expect, it, vi } from 'vitest';

import { runNarrowingPipeline } from '../src/lib/resolve/narrowing-pipeline.js';
import { resolveServiceCandidate } from '../src/lib/resolve/service-resolver.js';
import { chooseSource } from '../src/lib/resolve/source-selector.js';
import type { RepoSignals } from '../src/lib/repo/signals.js';
import type { CloudFormationSpecClient } from '../src/lib/aws/cloudformation-client.js';
import type { TaggingSpecClient } from '../src/lib/aws/tagging-client.js';

function createSignals(overrides: Partial<RepoSignals> = {}): RepoSignals {
  return {
    serviceHints: [],
    explicitGatewayIdHints: [],
    inferredGatewayIdHints: [],
    evidence: [],
    ...overrides
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
    const taggingClient: TaggingSpecClient = {
      getResourcesByTag: vi.fn().mockImplementation(async (tagKey: string, tagValues: string[]) => {
        if (tagKey === 'postman:repo' && tagValues.includes('org/payments')) {
          return [{ arn: 'arn:aws:apigateway:us-east-1::/restapis/rest-1', tags: { 'postman:repo': 'org/payments' } }];
        }
        return [];
      }),
      probe: vi.fn().mockResolvedValue(true)
    };

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
    const taggingClient: TaggingSpecClient = {
      getResourcesByTag: vi.fn().mockImplementation(async (key: string, values: string[]) => {
        if (key === 'postman:repo' && values.includes('org/payments')) {
          return [{ arn: 'arn:aws:apigateway:us-east-1::/restapis/rest-9', tags: { 'postman:repo': 'org/payments' } }];
        }
        return [];
      }),
      probe: vi.fn().mockResolvedValue(true)
    };
    const all = [{ id: 'rest-9', name: 'x' }, { id: 'rest-1', name: 'y' }];
    const result = await runNarrowingPipeline(
      { repoSlug: 'org/payments', serviceHints: [], signals: createSignals(), taggingClient },
      all
    );
    expect(result?.mode).toBe('select');
    expect(result?.gatewayIds).toEqual(['rest-9']);
  });

  it('U1.5b two exact canonical matches do NOT select (ambiguity retained)', async () => {
    const taggingClient: TaggingSpecClient = {
      getResourcesByTag: vi.fn().mockImplementation(async (key: string) => {
        if (key === 'postman:repo') {
          return [
            { arn: 'arn:aws:apigateway:us-east-1::/restapis/a', tags: { 'postman:repo': 'org/payments' } },
            { arn: 'arn:aws:apigateway:us-east-1::/restapis/b', tags: { 'postman:repo': 'org/payments' } }
          ];
        }
        return [];
      }),
      probe: vi.fn().mockResolvedValue(true)
    };
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
      const taggingClient: TaggingSpecClient = {
        getResourcesByTag: vi.fn().mockImplementation(async (k: string, values: string[]) => {
          if (k === 'postman:repo') return []; // no canonical match
          if (k === key) return [{ arn: 'arn:aws:apigateway:us-east-1::/restapis/rest-1', tags: { [key]: values[0] } }];
          return [];
        }),
        probe: vi.fn().mockResolvedValue(true)
      };
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

import { describe, expect, it, vi } from 'vitest';

import { runNarrowingPipeline } from '../src/lib/resolve/narrowing-pipeline.js';
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

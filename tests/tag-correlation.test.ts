import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { GetResourcesCommand } from '@aws-sdk/client-resource-groups-tagging-api';

import type { AwsGatewayClient } from '../src/lib/aws/client.js';
import { TaggingSdkClient, type TaggingSpecClient } from '../src/lib/aws/tagging-client.js';
import { runResolution } from '../src/runtime.js';

function createCoreStub() {
  const infos: string[] = [];
  const warnings: string[] = [];
  return {
    core: {
      group: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      info: (message: string) => {
        infos.push(message);
      },
      warning: (message: string) => {
        warnings.push(message);
      }
    },
    infos,
    warnings
  };
}

function createAwsClientStub(overrides: Partial<AwsGatewayClient> = {}): AwsGatewayClient {
  return {
    listRestApis: vi.fn().mockResolvedValue([]),
    listHttpApis: vi.fn().mockResolvedValue([]),
    getRestApi: vi.fn().mockResolvedValue(undefined),
    getHttpApi: vi.fn().mockResolvedValue(undefined),
    listRestStages: vi.fn().mockResolvedValue([]),
    listHttpStages: vi.fn().mockResolvedValue([]),
    getRestTags: vi.fn().mockResolvedValue({}),
    getHttpTags: vi.fn().mockResolvedValue({}),
    exportRestApi: vi.fn().mockResolvedValue('openapi: 3.0.1'),
    exportHttpApi: vi.fn().mockResolvedValue('openapi: 3.0.1'),
    exportWebSocketApi: vi.fn().mockResolvedValue('openapi: 3.0.3'),
    getCallerIdentity: vi.fn().mockResolvedValue({
      accountId: '123456789012',
      arn: 'arn:aws:iam::123456789012:role/test'
    }),
    probeApiGatewayReadAccess: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

function baseInputs(repoRoot: string, maxCandidates: number) {
  return {
    mode: 'resolve-one' as const,
    awsRegion: 'us-east-1',
    repoRoot,
    repoContext: { provider: 'github' as const, repoSlug: 'org/payments' },
    expectedServiceName: 'payments',
    expectedGatewayIds: [] as string[],
    stage: undefined,
    apiFilter: undefined,
    serviceMapping: {},
    outputDir: 'discovered-specs',
    maxCandidates,
    dryRun: true,
    preflightChecks: false,
    preflightPermissionProbe: false,
    requestTimeoutMs: 30000,
    maxAttempts: 3,
    includeV2: true
  };
}

function foxTaggingClient(resources: Array<{ arn: string; tags: Record<string, string> }>): TaggingSpecClient {
  return {
    getResourcesByTag: vi.fn().mockResolvedValue([]),
    getResourcesByTags: vi.fn().mockImplementation(async (filters) => {
      const keys = new Set(filters.map((filter: { key: string }) => filter.key));
      if (!keys.has('GithubOrg') || !keys.has('GithubRepo')) return [];
      return resources.filter((resource) => resource.tags.GithubOrg && resource.tags.GithubRepo);
    }),
    probe: vi.fn().mockResolvedValue(true)
  };
}

describe('POS-392 tag correlation runtime + tagging client', () => {
  it('TaggingSdkClient paginates and returns deterministic ARN order', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: 'arn:aws:apigateway:us-east-1::/restapis/z-api',
            Tags: [{ Key: 'GithubOrg', Value: 'org' }, { Key: 'GithubRepo', Value: 'payments' }]
          }
        ],
        PaginationToken: 'page-2'
      })
      .mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: 'arn:aws:apigateway:us-east-1::/apis/a-api',
            Tags: [{ Key: 'GithubOrg', Value: 'org' }, { Key: 'GithubRepo', Value: 'payments' }]
          }
        ],
        PaginationToken: undefined
      });

    const client = new TaggingSdkClient('us-east-1');
    (client as unknown as { client: { send: typeof send } }).client = { send };

    const resources = await client.getResourcesByTags([{ key: 'GithubOrg' }, { key: 'GithubRepo' }], [
      'apigateway:restapis',
      'apigateway:apis'
    ]);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetResourcesCommand);
    expect(resources.map((resource) => resource.arn)).toEqual([
      'arn:aws:apigateway:us-east-1::/apis/a-api',
      'arn:aws:apigateway:us-east-1::/restapis/z-api'
    ]);
  });

  it('exact Fox match selects below max-candidates threshold', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-tag-below-'));
    try {
      const aws = createAwsClientStub({
        listRestApis: vi.fn().mockResolvedValue([
          { id: 'rest-other', name: 'other-api' },
          { id: 'rest-pay', name: 'payments-api' }
        ]),
        listRestStages: vi.fn().mockResolvedValue([{ stageName: 'prod' }]),
        getRestTags: vi.fn().mockImplementation(async (id: string) =>
          id === 'rest-pay' ? { GithubOrg: 'org', GithubRepo: 'payments' } : {}
        )
      });
      const { core, infos } = createCoreStub();
      const resolution = await runResolution(baseInputs(tempDir, 50), aws, core, vi.fn().mockResolvedValue(undefined), {
        narrowingClients: {
          taggingClient: foxTaggingClient([
            {
              arn: 'arn:aws:apigateway:us-east-1::/restapis/rest-pay',
              tags: { GithubOrg: 'org', GithubRepo: 'payments' }
            }
          ])
        }
      });

      expect(infos.join(' ')).toMatch(/Exact tag correlation \(GithubOrg\+GithubRepo\) selected candidate rest-pay/);
      expect(resolution.narrowing).toEqual({ tier: 'tag-prefilter', mode: 'select', droppedCount: 1 });
      expect(resolution.status).toBe('resolved');
      expect(resolution.sourceType).toBe('gateway-export');
      expect(resolution.gatewayId).toBe('rest-pay');
      expect(resolution.evidence.join(' ')).toMatch(/Matched tag contract GithubOrg\+GithubRepo/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('exact correlation still selects when candidates are above max-candidates', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-tag-above-'));
    try {
      const enumerated = Array.from({ length: 20 }, (_, index) => ({
        id: `rest-${String(index + 1).padStart(2, '0')}`,
        name: `unrelated-${index + 1}`
      }));
      enumerated.push({ id: 'rest-pay', name: 'payments-api' });
      const aws = createAwsClientStub({
        listRestApis: vi.fn().mockResolvedValue(enumerated),
        listRestStages: vi.fn().mockResolvedValue([{ stageName: 'prod' }]),
        getRestTags: vi.fn().mockImplementation(async (id: string) =>
          id === 'rest-pay' ? { GithubOrg: 'org', GithubRepo: 'payments', Environment: 'prod' } : {}
        )
      });
      const { core, infos, warnings } = createCoreStub();
      const resolution = await runResolution(baseInputs(tempDir, 5), aws, core, vi.fn().mockResolvedValue(undefined), {
        narrowingClients: {
          taggingClient: foxTaggingClient([
            {
              arn: 'arn:aws:apigateway:us-east-1::/restapis/rest-pay',
              tags: { GithubOrg: 'org', GithubRepo: 'payments', Environment: 'prod' }
            }
          ])
        }
      });

      expect(infos.join(' ')).toMatch(/Exact tag correlation \(GithubOrg\+GithubRepo\) selected candidate rest-pay/);
      expect(warnings.join(' ')).not.toMatch(/after narrowing still exceeds limit/);
      expect(resolution.narrowing?.mode).toBe('select');
      expect(resolution.gatewayId).toBe('rest-pay');
      expect(resolution.status).toBe('resolved');
      expect(resolution.sourceType).toBe('gateway-export');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('multiple exact per-environment matches stay ambiguity-safe even under a low max-candidates cap', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-tag-multi-'));
    try {
      const aws = createAwsClientStub({
        listRestApis: vi.fn().mockResolvedValue([
          { id: 'rest-qa', name: 'payments-qa' },
          { id: 'rest-prod', name: 'payments-prod' },
          { id: 'rest-other', name: 'other' }
        ]),
        getRestTags: vi.fn().mockImplementation(async (id: string) => {
          if (id === 'rest-qa') return { GithubOrg: 'org', GithubRepo: 'payments', Environment: 'qa' };
          if (id === 'rest-prod') return { GithubOrg: 'org', GithubRepo: 'payments', Environment: 'prod' };
          return {};
        })
      });
      const { core, infos } = createCoreStub();
      const resolution = await runResolution(baseInputs(tempDir, 1), aws, core, vi.fn().mockResolvedValue(undefined), {
        narrowingClients: {
          taggingClient: foxTaggingClient([
            {
              arn: 'arn:aws:apigateway:us-east-1::/restapis/rest-qa',
              tags: { GithubOrg: 'org', GithubRepo: 'payments', Environment: 'qa' }
            },
            {
              arn: 'arn:aws:apigateway:us-east-1::/restapis/rest-prod',
              tags: { GithubOrg: 'org', GithubRepo: 'payments', Environment: 'prod' }
            }
          ])
        }
      });

      expect(infos.join(' ')).toMatch(/retained 2 per-environment candidate/);
      expect(resolution.narrowing).toEqual({ tier: 'tag-prefilter', mode: 'narrow', droppedCount: 1 });
      expect(resolution.status).toBe('unresolved');
      expect(resolution.sourceType).toBe('manual-review');
      expect(resolution.rankedCandidates?.map((candidate) => candidate.gatewayId).sort()).toEqual(['rest-prod', 'rest-qa']);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

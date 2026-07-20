import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppSyncSdkClient } from '../src/lib/aws/appsync-client.js';

const { appSyncSendMock } = vi.hoisted(() => ({
  appSyncSendMock: vi.fn()
}));

vi.mock('@aws-sdk/client-appsync', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-appsync')>('@aws-sdk/client-appsync');
  return {
    ...actual,
    AppSyncClient: class {
      public send = appSyncSendMock;
    }
  };
});

describe('AppSyncSdkClient source association listing', () => {
  beforeEach(() => {
    appSyncSendMock.mockReset();
  });

  it('paginates source API associations and retains sanitized identifiers only', async () => {
    appSyncSendMock
      .mockResolvedValueOnce({
        sourceApiAssociationSummaries: [{ associationId: 'assoc-1', sourceApiId: 'source-a', sourceApiArn: 'arn:aws:appsync:us-east-1:123456789012:apis/source-a' }],
        nextToken: 'page-2'
      })
      .mockResolvedValueOnce({
        sourceApiAssociationSummaries: [{ associationId: 'assoc-2', sourceApiId: 'source-b' }]
      });

    const client = new AppSyncSdkClient('us-east-1');
    const result = await client.listSourceApiAssociations('merged-1');

    expect(appSyncSendMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      associations: [
        { associationId: 'assoc-1', sourceApiId: 'source-a' },
        { associationId: 'assoc-2', sourceApiId: 'source-b' }
      ],
      evidence: ['Listed 2 AppSync source API association(s) for merged API merged-1']
    });
    expect(JSON.stringify(result.associations)).not.toMatch(/123456789012/);
  });

  it('uses the configured bounded page size for source API associations', async () => {
    appSyncSendMock.mockResolvedValue({ sourceApiAssociationSummaries: [] });

    const client = new AppSyncSdkClient('us-east-1', { sourceAssociationPageSize: 1 });
    await client.listSourceApiAssociations('merged-1');

    expect(appSyncSendMock).toHaveBeenCalledWith(expect.objectContaining({ input: {
      apiId: 'merged-1',
      nextToken: undefined,
      maxResults: 1
    } }));
  });

  it('marks association listing denied while leaving callers free to export SDL', async () => {
    appSyncSendMock.mockRejectedValue(Object.assign(new Error('User is not authorized'), { name: 'AccessDeniedException' }));

    const client = new AppSyncSdkClient('us-east-1');
    const result = await client.listSourceApiAssociations('merged-1');

    expect(result.denied).toBe(true);
    expect(result.associations).toEqual([]);
    expect(result.evidence.join('\n')).toMatch(/denied/i);
  });

  it('truncates association pagination after the configured page bound', async () => {
    appSyncSendMock.mockImplementation(async () => ({
      sourceApiAssociationSummaries: [{ associationId: 'assoc-x', sourceApiId: 'source-x' }],
      nextToken: 'more'
    }));

    const client = new AppSyncSdkClient('us-east-1');
    const result = await client.listSourceApiAssociations('merged-1');

    expect(appSyncSendMock).toHaveBeenCalledTimes(20);
    expect(result.truncated).toBe(true);
    expect(result.associations).toHaveLength(20);
    expect(result.evidence.join('\n')).toMatch(/truncated/i);
  });

  it('rethrows IAM denials from probe for ProviderRegistry classification', async () => {
    const error = Object.assign(new Error('access denied'), { name: 'AccessDeniedException' });
    appSyncSendMock.mockRejectedValue(error);

    const client = new AppSyncSdkClient('us-east-1');

    await expect(client.probe()).rejects.toBe(error);
  });

  it('fails probe closed for non-IAM errors', async () => {
    appSyncSendMock.mockRejectedValue(new Error('network unavailable'));

    const client = new AppSyncSdkClient('us-east-1');

    await expect(client.probe()).resolves.toBe(false);
  });
});

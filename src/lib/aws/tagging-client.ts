import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand
} from '@aws-sdk/client-resource-groups-tagging-api';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export interface TaggedResource {
  arn: string;
  tags: Record<string, string>;
}

export interface TaggingSpecClient {
  getResourcesByTag(tagKey: string, tagValues: string[], resourceTypes?: string[]): Promise<TaggedResource[]>;
  probe(): Promise<boolean>;
}

export class TaggingSdkClient implements TaggingSpecClient {
  private readonly client: ResourceGroupsTaggingAPIClient;

  public constructor(region: string, options: { requestTimeoutMs?: number; maxAttempts?: number } = {}) {
    const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.client = new ResourceGroupsTaggingAPIClient({
      region,
      maxAttempts: options.maxAttempts ?? 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: requestTimeoutMs,
        socketTimeout: requestTimeoutMs
      })
    });
  }

  public async getResourcesByTag(tagKey: string, tagValues: string[], resourceTypes?: string[]): Promise<TaggedResource[]> {
    const items: TaggedResource[] = [];
    let paginationToken: string | undefined;
    do {
      const response = await this.client.send(
        new GetResourcesCommand({
          TagFilters: [{ Key: tagKey, Values: tagValues.length > 0 ? tagValues : undefined }],
          ResourceTypeFilters: resourceTypes,
          PaginationToken: paginationToken
        })
      );
      for (const mapping of response.ResourceTagMappingList ?? []) {
        if (!mapping.ResourceARN) continue;
        const tags: Record<string, string> = {};
        for (const tag of mapping.Tags ?? []) {
          if (tag.Key) tags[tag.Key] = tag.Value ?? '';
        }
        items.push({ arn: mapping.ResourceARN, tags });
      }
      paginationToken = response.PaginationToken;
    } while (paginationToken);
    return items;
  }

  public async probe(): Promise<boolean> {
    try {
      await this.client.send(new GetResourcesCommand({ ResourceTypeFilters: ['apigateway'], TagFilters: [] }));
      return true;
    } catch {
      return false;
    }
  }
}

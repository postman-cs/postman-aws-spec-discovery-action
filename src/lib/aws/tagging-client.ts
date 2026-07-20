import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand
} from '@aws-sdk/client-resource-groups-tagging-api';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export interface TaggedResource {
  arn: string;
  tags: Record<string, string>;
}

/** One Resource Groups Tagging API filter. Multiple filters are conjunctive (AND). */
export interface TagFilterSpec {
  /** AWS tag key; case is preserved exactly as provided. */
  key: string;
  /** Optional values for this key (OR within the key). Omit or pass [] for key-only. */
  values?: string[];
}

export interface TaggingSpecClient {
  getResourcesByTag(tagKey: string, tagValues: string[], resourceTypes?: string[]): Promise<TaggedResource[]>;
  /** Conjunctive multi-key tag query. Filters are AND; values within one key are OR. */
  getResourcesByTags(filters: TagFilterSpec[], resourceTypes?: string[]): Promise<TaggedResource[]>;
  probe(): Promise<boolean>;
}

function sortByArn(items: TaggedResource[]): TaggedResource[] {
  return [...items].sort((left, right) => (left.arn < right.arn ? -1 : left.arn > right.arn ? 1 : 0));
}

/** Finite upper bound for Resource Groups Tagging API pagination. */
export const MAX_TAGGING_PAGES = 100;

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
    return this.getResourcesByTags([{ key: tagKey, values: tagValues }], resourceTypes);
  }

  public async getResourcesByTags(filters: TagFilterSpec[], resourceTypes?: string[]): Promise<TaggedResource[]> {
    const items: TaggedResource[] = [];
    const seenTokens = new Set<string>();
    let paginationToken: string | undefined;
    for (let page = 1; page <= MAX_TAGGING_PAGES; page += 1) {
      const response = await this.client.send(
        new GetResourcesCommand({
          TagFilters: filters.map((filter) => ({
            Key: filter.key,
            Values: filter.values && filter.values.length > 0 ? filter.values : undefined
          })),
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
      const next = response.PaginationToken || undefined;
      if (!next) return sortByArn(items);
      if (next === paginationToken || seenTokens.has(next)) {
        throw new Error(
          'Resource Groups Tagging API pagination returned a repeated PaginationToken; aborting'
        );
      }
      seenTokens.add(next);
      paginationToken = next;
    }
    throw new Error(
      `Resource Groups Tagging API pagination exceeded ${MAX_TAGGING_PAGES} pages; aborting`
    );
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

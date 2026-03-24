import {
  AppSyncClient as AwsAppSyncClient,
  ListGraphqlApisCommand,
  GetIntrospectionSchemaCommand,
  ListTagsForResourceCommand
} from '@aws-sdk/client-appsync';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export interface GraphqlApiSummary {
  id: string;
  name: string;
  arn: string;
  apiType: string;
}

export interface AppSyncSpecClient {
  listGraphqlApis(): Promise<GraphqlApiSummary[]>;
  getSchema(apiId: string): Promise<string>;
  getTags(arn: string): Promise<Record<string, string>>;
  probe(): Promise<boolean>;
}

export class AppSyncSdkClient implements AppSyncSpecClient {
  private readonly client: AwsAppSyncClient;

  public constructor(region: string, options: { requestTimeoutMs?: number; maxAttempts?: number } = {}) {
    const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.client = new AwsAppSyncClient({
      region,
      maxAttempts: options.maxAttempts ?? 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: requestTimeoutMs,
        socketTimeout: requestTimeoutMs
      })
    });
  }

  public async listGraphqlApis(): Promise<GraphqlApiSummary[]> {
    const items: GraphqlApiSummary[] = [];
    let nextToken: string | undefined;
    do {
      const response = await this.client.send(new ListGraphqlApisCommand({ nextToken, maxResults: 25 }));
      for (const api of response.graphqlApis ?? []) {
        if (!api.apiId) continue;
        items.push({
          id: api.apiId,
          name: (api.name ?? '').trim() || api.apiId,
          arn: api.arn ?? '',
          apiType: (api.apiType ?? 'GRAPHQL').toUpperCase()
        });
      }
      nextToken = response.nextToken;
    } while (nextToken);
    return items;
  }

  public async getSchema(apiId: string): Promise<string> {
    const response = await this.client.send(
      new GetIntrospectionSchemaCommand({ apiId, format: 'SDL' })
    );
    if (!response.schema) {
      throw new Error(`No schema returned for AppSync API ${apiId}`);
    }
    return new TextDecoder().decode(response.schema);
  }

  public async getTags(arn: string): Promise<Record<string, string>> {
    const response = await this.client.send(new ListTagsForResourceCommand({ resourceArn: arn }));
    return response.tags ?? {};
  }

  public async probe(): Promise<boolean> {
    try {
      await this.client.send(new ListGraphqlApisCommand({ maxResults: 1 }));
      return true;
    } catch {
      return false;
    }
  }
}

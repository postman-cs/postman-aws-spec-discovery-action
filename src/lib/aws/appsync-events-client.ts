import {
  AppSyncClient,
  ListApisCommand,
  ListChannelNamespacesCommand,
  type Api,
  type AuthMode,
  type ChannelNamespace
} from '@aws-sdk/client-appsync';
import { NodeHttpHandler } from '@smithy/node-http-handler';

import { createAwsPaginationGuard } from './pagination.js';

export interface AppSyncEventApiSummary {
  apiId: string;
  name: string;
  apiArn?: string;
  dns?: Record<string, string>;
  tags?: Record<string, string>;
}

export interface AppSyncChannelNamespaceSummary {
  apiId: string;
  name: string;
  channelNamespaceArn?: string;
  publishAuthModes?: AuthMode[];
  subscribeAuthModes?: AuthMode[];
  codeHandlers?: string;
  tags?: Record<string, string>;
}

export interface AppSyncEventsSpecClient {
  listEventApis(): Promise<AppSyncEventApiSummary[]>;
  listChannelNamespaces(apiId: string): Promise<AppSyncChannelNamespaceSummary[]>;
  probe(): Promise<boolean>;
}

export class AppSyncEventsSdkClient implements AppSyncEventsSpecClient {
  private readonly client: AppSyncClient;

  public constructor(region: string, options: { requestTimeoutMs?: number; maxAttempts?: number } = {}) {
    const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.client = new AppSyncClient({
      region,
      maxAttempts: options.maxAttempts ?? 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: requestTimeoutMs,
        socketTimeout: requestTimeoutMs
      })
    });
  }

  public async listEventApis(): Promise<AppSyncEventApiSummary[]> {
    const apis: AppSyncEventApiSummary[] = [];
    const guard = createAwsPaginationGuard('AppSync Events ListApis');
    let nextToken: string | undefined;
    do {
      guard.beginPage();
      const response = await this.client.send(new ListApisCommand({ nextToken, maxResults: 25 }));
      for (const api of response.apis ?? []) {
        const mapped = mapEventApi(api);
        if (mapped) apis.push(mapped);
      }
      nextToken = guard.takeNextToken(response.nextToken);
    } while (nextToken);
    return apis;
  }

  public async listChannelNamespaces(apiId: string): Promise<AppSyncChannelNamespaceSummary[]> {
    const namespaces: AppSyncChannelNamespaceSummary[] = [];
    const guard = createAwsPaginationGuard('AppSync Events ListChannelNamespaces');
    let nextToken: string | undefined;
    do {
      guard.beginPage();
      const response = await this.client.send(new ListChannelNamespacesCommand({ apiId, nextToken, maxResults: 25 }));
      for (const namespace of response.channelNamespaces ?? []) {
        const mapped = mapChannelNamespace(namespace, apiId);
        if (mapped) namespaces.push(mapped);
      }
      nextToken = guard.takeNextToken(response.nextToken);
    } while (nextToken);
    return namespaces;
  }

  public async probe(): Promise<boolean> {
    try {
      await this.client.send(new ListApisCommand({ maxResults: 1 }));
      return true;
    } catch {
      return false;
    }
  }
}

function mapEventApi(api: Api): AppSyncEventApiSummary | undefined {
  if (!api.apiId || !api.name || !api.eventConfig) return undefined;
  return {
    apiId: api.apiId,
    name: api.name,
    apiArn: api.apiArn,
    dns: api.dns,
    tags: api.tags
  };
}

function mapChannelNamespace(namespace: ChannelNamespace, apiId: string): AppSyncChannelNamespaceSummary | undefined {
  if (!namespace.name) return undefined;
  return {
    apiId: namespace.apiId ?? apiId,
    name: namespace.name,
    channelNamespaceArn: namespace.channelNamespaceArn,
    publishAuthModes: namespace.publishAuthModes,
    subscribeAuthModes: namespace.subscribeAuthModes,
    codeHandlers: namespace.codeHandlers,
    tags: namespace.tags
  };
}

import {
  AppSyncClient as AwsAppSyncClient,
  ListGraphqlApisCommand,
  GetIntrospectionSchemaCommand,
  ListTagsForResourceCommand,
  ListSourceApiAssociationsCommand
} from '@aws-sdk/client-appsync';
import { NodeHttpHandler } from '@smithy/node-http-handler';

import { parseAwsError } from './client.js';

export interface GraphqlApiSummary {
  id: string;
  name: string;
  arn: string;
  apiType: string;
}

export interface AppSyncSourceAssociationSummary {
  associationId?: string;
  sourceApiId?: string;
  associationStatus?: string;
}

export interface AppSyncSourceAssociationListResult {
  associations: AppSyncSourceAssociationSummary[];
  truncated?: boolean;
  denied?: boolean;
  evidence: string[];
}

export interface AppSyncSpecClient {
  listGraphqlApis(): Promise<GraphqlApiSummary[]>;
  getSchema(apiId: string): Promise<string>;
  getTags(arn: string): Promise<Record<string, string>>;
  listSourceApiAssociations?(mergedApiId: string): Promise<AppSyncSourceAssociationListResult>;
  probe(): Promise<boolean>;
}

const MAX_SOURCE_ASSOCIATION_PAGES = 20;
const DEFAULT_SOURCE_ASSOCIATION_PAGE_SIZE = 25;

function sourceAssociationPageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SOURCE_ASSOCIATION_PAGE_SIZE;
  return Math.min(DEFAULT_SOURCE_ASSOCIATION_PAGE_SIZE, Math.max(1, Math.trunc(value)));
}

function isIamProbeError(error: unknown): boolean {
  const parsed = parseAwsError(error);
  return (
    parsed.httpStatusCode === 403 ||
    parsed.name === 'AccessDenied' ||
    parsed.name === 'AccessDeniedException' ||
    parsed.name === 'UnauthorizedOperation'
  );
}

export class AppSyncSdkClient implements AppSyncSpecClient {
  private readonly client: AwsAppSyncClient;
  private readonly sourceAssociationPageSize: number;

  public constructor(region: string, options: { requestTimeoutMs?: number; maxAttempts?: number; sourceAssociationPageSize?: number } = {}) {
    const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.sourceAssociationPageSize = sourceAssociationPageSize(options.sourceAssociationPageSize);
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

  public async listSourceApiAssociations(mergedApiId: string): Promise<AppSyncSourceAssociationListResult> {
    const associations: AppSyncSourceAssociationSummary[] = [];
    const evidence: string[] = [];
    let nextToken: string | undefined;
    let page = 0;
    try {
      do {
        page += 1;
        if (page > MAX_SOURCE_ASSOCIATION_PAGES) {
          return {
            associations,
            truncated: true,
            evidence: [
              ...evidence,
              `AppSync source API association listing truncated after ${MAX_SOURCE_ASSOCIATION_PAGES} pages`
            ]
          };
        }
        const response = await this.client.send(
          new ListSourceApiAssociationsCommand({
            apiId: mergedApiId,
            nextToken,
            maxResults: this.sourceAssociationPageSize
          })
        );
        for (const item of response.sourceApiAssociationSummaries ?? []) {
          const associationId = (item.associationId ?? '').trim() || undefined;
          const sourceApiId = (item.sourceApiId ?? '').trim() || undefined;
          if (!associationId && !sourceApiId) continue;
          // List summaries expose identifiers only; do not fabricate association status/type.
          associations.push({
            associationId,
            sourceApiId
          });
        }
        nextToken = response.nextToken;
      } while (nextToken);
      evidence.push(`Listed ${associations.length} AppSync source API association(s) for merged API ${mergedApiId}`);
      return { associations, evidence };
    } catch (error) {
      const parsed = parseAwsError(error);
      const denied =
        parsed.name === 'AccessDeniedException' ||
        parsed.name === 'AccessDenied' ||
        parsed.name === 'UnauthorizedException' ||
        /access denied|not authorized|unauthorized/i.test(parsed.message);
      return {
        associations,
        denied,
        evidence: [
          ...evidence,
          denied
            ? `AppSync source API association listing denied for merged API ${mergedApiId}; merged SDL export continues`
            : `AppSync source API association listing failed for merged API ${mergedApiId}; merged SDL export continues`
        ]
      };
    }
  }

  public async probe(): Promise<boolean> {
    try {
      await this.client.send(new ListGraphqlApisCommand({ maxResults: 1 }));
      return true;
    } catch (error) {
      if (isIamProbeError(error)) throw error;
      return false;
    }
  }
}

import {
  SchemasClient,
  ListRegistriesCommand,
  ListSchemasCommand,
  ExportSchemaCommand,
  DescribeSchemaCommand,
  ListTagsForResourceCommand
} from '@aws-sdk/client-schemas';
import { NodeHttpHandler } from '@smithy/node-http-handler';

import { createAwsPaginationGuard } from './pagination.js';

export interface RegistrySummary {
  name: string;
  arn: string;
}

export interface SchemaSummary {
  name: string;
  arn: string;
  registryName: string;
  versionCount: number;
}

export interface EventBridgeSchemasSpecClient {
  listRegistries(): Promise<RegistrySummary[]>;
  listSchemas(registryName: string): Promise<SchemaSummary[]>;
  exportSchema(registryName: string, schemaName: string): Promise<string>;
  describeSchema(registryName: string, schemaName: string): Promise<{ content: string; schemaVersion: string }>;
  getTags(arn: string): Promise<Record<string, string>>;
  probe(): Promise<boolean>;
}

export class EventBridgeSchemasSdkClient implements EventBridgeSchemasSpecClient {
  private readonly client: SchemasClient;

  public constructor(region: string, options: { requestTimeoutMs?: number; maxAttempts?: number } = {}) {
    const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.client = new SchemasClient({
      region,
      maxAttempts: options.maxAttempts ?? 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: requestTimeoutMs,
        socketTimeout: requestTimeoutMs
      })
    });
  }

  public async listRegistries(): Promise<RegistrySummary[]> {
    const items: RegistrySummary[] = [];
    const guard = createAwsPaginationGuard('EventBridge Schemas ListRegistries');
    let nextToken: string | undefined;
    do {
      guard.beginPage();
      const response = await this.client.send(new ListRegistriesCommand({ NextToken: nextToken }));
      for (const registry of response.Registries ?? []) {
        if (!registry.RegistryName) continue;
        items.push({
          name: registry.RegistryName,
          arn: registry.RegistryArn ?? ''
        });
      }
      nextToken = guard.takeNextToken(response.NextToken);
    } while (nextToken);
    return items;
  }

  public async listSchemas(registryName: string): Promise<SchemaSummary[]> {
    const items: SchemaSummary[] = [];
    const guard = createAwsPaginationGuard('EventBridge Schemas ListSchemas');
    let nextToken: string | undefined;
    do {
      guard.beginPage();
      const response = await this.client.send(
        new ListSchemasCommand({ RegistryName: registryName, NextToken: nextToken })
      );
      for (const schema of response.Schemas ?? []) {
        if (!schema.SchemaName) continue;
        items.push({
          name: schema.SchemaName,
          arn: schema.SchemaArn ?? '',
          registryName,
          versionCount: schema.VersionCount ?? 0
        });
      }
      nextToken = guard.takeNextToken(response.NextToken);
    } while (nextToken);
    return items;
  }

  public async exportSchema(registryName: string, schemaName: string): Promise<string> {
    const response = await this.client.send(
      new ExportSchemaCommand({
        RegistryName: registryName,
        SchemaName: schemaName,
        Type: 'OpenApi3'
      })
    );
    return response.Content ?? '';
  }

  public async describeSchema(registryName: string, schemaName: string): Promise<{ content: string; schemaVersion: string }> {
    const response = await this.client.send(
      new DescribeSchemaCommand({ RegistryName: registryName, SchemaName: schemaName })
    );
    return {
      content: response.Content ?? '',
      schemaVersion: response.SchemaVersion ?? ''
    };
  }

  public async getTags(arn: string): Promise<Record<string, string>> {
    const response = await this.client.send(new ListTagsForResourceCommand({ ResourceArn: arn }));
    return response.Tags ?? {};
  }

  public async probe(): Promise<boolean> {
    try {
      await this.client.send(new ListRegistriesCommand({ Limit: 1 }));
      return true;
    } catch {
      return false;
    }
  }
}

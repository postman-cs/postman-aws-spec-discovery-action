import {
  GlueClient,
  ListRegistriesCommand,
  ListSchemasCommand,
  GetSchemaVersionCommand,
  GetTagsCommand
} from '@aws-sdk/client-glue';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export interface GlueRegistrySummary {
  name: string;
  arn: string;
}

export interface GlueSchemaSummary {
  name: string;
  arn: string;
  registryName: string;
}

export interface GlueSchemaVersionDetail {
  content: string;
  dataFormat: string;
  versionNumber: number;
}

export interface GlueSchemaSpecClient {
  listRegistries(): Promise<GlueRegistrySummary[]>;
  listSchemas(registryName: string): Promise<GlueSchemaSummary[]>;
  getLatestSchemaVersion(schemaArn: string): Promise<GlueSchemaVersionDetail>;
  getTags(arn: string): Promise<Record<string, string>>;
  probe(): Promise<boolean>;
}

export class GlueSchemaSdkClient implements GlueSchemaSpecClient {
  private readonly client: GlueClient;

  public constructor(region: string, options: { requestTimeoutMs?: number; maxAttempts?: number } = {}) {
    const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.client = new GlueClient({
      region,
      maxAttempts: options.maxAttempts ?? 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: requestTimeoutMs,
        socketTimeout: requestTimeoutMs
      })
    });
  }

  public async listRegistries(): Promise<GlueRegistrySummary[]> {
    const items: GlueRegistrySummary[] = [];
    let nextToken: string | undefined;
    do {
      const response = await this.client.send(new ListRegistriesCommand({ NextToken: nextToken, MaxResults: 100 }));
      for (const registry of response.Registries ?? []) {
        if (!registry.RegistryName) continue;
        items.push({
          name: registry.RegistryName,
          arn: registry.RegistryArn ?? ''
        });
      }
      nextToken = response.NextToken;
    } while (nextToken);
    return items;
  }

  public async listSchemas(registryName: string): Promise<GlueSchemaSummary[]> {
    const items: GlueSchemaSummary[] = [];
    let nextToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListSchemasCommand({
          RegistryId: { RegistryName: registryName },
          NextToken: nextToken,
          MaxResults: 100
        })
      );
      for (const schema of response.Schemas ?? []) {
        if (!schema.SchemaName) continue;
        items.push({
          name: schema.SchemaName,
          arn: schema.SchemaArn ?? '',
          registryName
        });
      }
      nextToken = response.NextToken;
    } while (nextToken);
    return items;
  }

  public async getLatestSchemaVersion(schemaArn: string): Promise<GlueSchemaVersionDetail> {
    const response = await this.client.send(
      new GetSchemaVersionCommand({
        SchemaId: { SchemaArn: schemaArn },
        SchemaVersionNumber: { LatestVersion: true }
      })
    );
    return {
      content: response.SchemaDefinition ?? '',
      dataFormat: response.DataFormat ?? 'UNKNOWN',
      versionNumber: response.VersionNumber ?? 0
    };
  }

  public async getTags(arn: string): Promise<Record<string, string>> {
    const response = await this.client.send(new GetTagsCommand({ ResourceArn: arn }));
    return response.Tags ?? {};
  }

  public async probe(): Promise<boolean> {
    try {
      await this.client.send(new ListRegistriesCommand({ MaxResults: 1 }));
      return true;
    } catch {
      return false;
    }
  }
}

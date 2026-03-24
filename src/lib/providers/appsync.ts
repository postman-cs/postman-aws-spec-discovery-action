import type { AppSyncSpecClient } from '../aws/appsync-client.js';
import type { ExportOptions, SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

export class AppSyncProvider implements SpecProvider {
  public readonly type = 'appsync' as const;

  public constructor(private readonly client: AppSyncSpecClient) {}

  public async probe(): Promise<boolean> {
    return this.client.probe();
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const apis = await this.client.listGraphqlApis();
    return apis
      .filter((api) => api.apiType === 'GRAPHQL' || api.apiType === 'MERGED')
      .map((api) => ({
        id: api.id,
        name: api.name,
        providerType: 'appsync' as const,
        tags: {},
        evidence: [`AppSync ${api.apiType} API discovered`],
        meta: { arn: api.arn, apiType: api.apiType }
      }));
  }

  public async exportSpec(candidate: SpecCandidate, _options?: ExportOptions): Promise<SpecExportResult> {
    const content = await this.client.getSchema(candidate.id);
    const tags = await this.client.getTags(candidate.meta.arn ?? '');
    const serviceName = (tags['postman:project-name'] ?? '').trim() || (tags.Name ?? '').trim() || candidate.name;

    return {
      content,
      format: 'graphql-sdl',
      filename: 'schema.graphql',
      evidence: [`Exported GraphQL SDL schema for AppSync API ${candidate.id} (${serviceName})`]
    };
  }
}

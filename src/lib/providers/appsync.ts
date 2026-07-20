import type { AppSyncSourceAssociationProvenance, DeployedSourceProvenance } from '../../contracts.js';
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
    void _options;
    const content = await this.client.getSchema(candidate.id);
    const tags = await this.client.getTags(candidate.meta.arn ?? '');
    const serviceName = (tags['postman:project-name'] ?? '').trim() || (tags.Name ?? '').trim() || candidate.name;
    const evidence = [`Exported GraphQL SDL schema for AppSync API ${candidate.id} (${serviceName})`];
    const provenance: DeployedSourceProvenance = {
      apiId: candidate.id,
      protocol: 'GRAPHQL',
      queryTimestamp: new Date().toISOString()
    };

    const apiType = (candidate.meta.apiType ?? '').toUpperCase();
    if (apiType === 'MERGED' && this.client.listSourceApiAssociations) {
      const associationResult = await this.client.listSourceApiAssociations(candidate.id);
      evidence.push(...associationResult.evidence);
      const associations: AppSyncSourceAssociationProvenance[] = associationResult.associations.map((item) => ({
        associationId: item.associationId,
        sourceApiId: item.sourceApiId,
        associationStatus: item.associationStatus,
        denied: associationResult.denied || undefined
      }));
      provenance.appsyncSourceAssociations = associations;
      if (associationResult.denied) {
        provenance.appsyncAssociationEvidence = 'denied';
      } else if (associationResult.truncated) {
        provenance.appsyncAssociationEvidence = 'partial';
        provenance.truncation = {
          truncated: true,
          reason: 'AppSync source API association pagination limit reached'
        };
      } else {
        provenance.appsyncAssociationEvidence = 'complete';
      }
      evidence.push(
        `Retained ${associations.length} sanitized AppSync source association identifier(s) as provenance; exported merged SDL once`
      );
    }

    return {
      content,
      format: 'graphql-sdl',
      filename: 'schema.graphql',
      evidence,
      provenance
    };
  }
}

import type { SpecFormat } from '../../contracts.js';
import type { GlueSchemaSpecClient } from '../aws/glue-client.js';
import type { ExportOptions, SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

function dataFormatToSpecFormat(dataFormat: string): { format: SpecFormat; filename: string } {
  switch (dataFormat.toUpperCase()) {
    case 'AVRO':
      return { format: 'avro', filename: 'schema.avsc' };
    case 'PROTOBUF':
      return { format: 'protobuf', filename: 'schema.proto' };
    case 'JSON':
      return { format: 'json-schema', filename: 'schema.json' };
    default:
      return { format: 'json-schema', filename: 'schema.json' };
  }
}

export class GlueSchemaProvider implements SpecProvider {
  public readonly type = 'glue' as const;

  public constructor(private readonly client: GlueSchemaSpecClient) {}

  public async probe(): Promise<boolean> {
    return this.client.probe();
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const registries = await this.client.listRegistries();
    const candidates: SpecCandidate[] = [];

    for (const registry of registries) {
      const schemas = await this.client.listSchemas(registry.name);
      for (const schema of schemas) {
        candidates.push({
          id: `${registry.name}/${schema.name}`,
          name: schema.name,
          providerType: 'glue',
          tags: {},
          evidence: [`Glue Schema Registry schema in registry ${registry.name}`],
          meta: {
            registryName: registry.name,
            schemaName: schema.name,
            schemaArn: schema.arn
          }
        });
      }
    }

    return candidates;
  }

  public async exportSpec(candidate: SpecCandidate, _options?: ExportOptions): Promise<SpecExportResult> {
    void _options;
    const schemaArn = candidate.meta.schemaArn ?? '';
    const version = await this.client.getLatestSchemaVersion(schemaArn);
    const { format, filename } = dataFormatToSpecFormat(version.dataFormat);

    return {
      content: version.content,
      format,
      filename,
      evidence: [
        `Exported Glue Schema Registry schema ${candidate.name} v${version.versionNumber} (${version.dataFormat}) from registry ${candidate.meta.registryName}`
      ]
    };
  }
}

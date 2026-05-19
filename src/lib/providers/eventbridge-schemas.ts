import type { EventBridgeSchemasSpecClient } from '../aws/schemas-client.js';
import type { ExportOptions, SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

function detectSchemaFormat(content: string): Pick<SpecExportResult, 'format' | 'filename'> {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.openapi || parsed.swagger) {
      return { format: 'openapi-json', filename: 'index.json' };
    }
  } catch {
    // EventBridge schema content is usually JSON; leave non-JSON as JSON Schema fallback.
  }
  return { format: 'json-schema', filename: 'index.json' };
}

export class EventBridgeSchemasProvider implements SpecProvider {
  public readonly type = 'eventbridge-schemas' as const;

  public constructor(private readonly client: EventBridgeSchemasSpecClient) {}

  public async probe(): Promise<boolean> {
    return this.client.probe();
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const registries = await this.client.listRegistries();
    const candidates: SpecCandidate[] = [];

    for (const registry of registries) {
      // Skip the AWS-managed discovered schemas registry by default -- it is noisy.
      if (registry.name === 'aws.events') continue;

      const schemas = await this.client.listSchemas(registry.name);
      for (const schema of schemas) {
        candidates.push({
          id: `${registry.name}/${schema.name}`,
          name: schema.name,
          providerType: 'eventbridge-schemas',
          tags: {},
          evidence: [`EventBridge schema in registry ${registry.name}`],
          meta: {
            registryName: registry.name,
            schemaName: schema.name,
            arn: schema.arn
          }
        });
      }
    }

    return candidates;
  }

  public async exportSpec(candidate: SpecCandidate, _options?: ExportOptions): Promise<SpecExportResult> {
    void _options;
    const registryName = candidate.meta.registryName ?? '';
    const schemaName = candidate.meta.schemaName ?? '';

    // DescribeSchema returns the raw content regardless of schema type.
    // ExportSchema only supports JSONSchemaDraft4 as output type, so it fails
    // for schemas stored as OpenApi3. DescribeSchema works for all types.
    const { content } = await this.client.describeSchema(registryName, schemaName);
    const detected = detectSchemaFormat(content);

    return {
      content,
      format: detected.format,
      filename: detected.filename,
      evidence: [`Exported EventBridge schema ${schemaName} from registry ${registryName}`]
    };
  }
}

import type { VerifiedPermissionsSpecClient } from '../aws/verified-permissions-client.js';
import type { ExportOptions, SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

export class VerifiedPermissionsProvider implements SpecProvider {
  public readonly type = 'verified-permissions' as const;

  public constructor(private readonly client: VerifiedPermissionsSpecClient) {}

  public async probe(): Promise<boolean> {
    return this.client.probe();
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    return (await this.client.listPolicyStores()).map((store) => ({
      id: store.policyStoreId,
      name: store.description || store.policyStoreId,
      providerType: 'verified-permissions',
      tags: {},
      evidence: [`Verified Permissions policy store discovered: ${store.policyStoreId}`],
      meta: {
        policyStoreId: store.policyStoreId,
        arn: store.arn,
        description: store.description ?? ''
      }
    }));
  }

  public async exportSpec(candidate: SpecCandidate, _options?: ExportOptions): Promise<SpecExportResult> {
    void _options;
    const detail = await this.client.getSchema(candidate.meta.policyStoreId || candidate.id);
    const document = {
      openapi: '3.1.0',
      info: {
        title: candidate.name,
        version: '1.0.0',
        description: 'Verified Permissions Cedar schemas describe authorization entities and actions; no HTTP endpoints are inferred.'
      },
      paths: {},
      'x-aws-verified-permissions': {
        policyStoreId: detail.policyStoreId,
        arn: candidate.meta.arn,
        namespaces: detail.namespaces,
        cedarSchema: parseSchema(detail.schema)
      }
    };
    return {
      content: `${JSON.stringify(document, null, 2)}\n`,
      format: 'openapi-json',
      filename: 'index.json',
      derivedOpenApiCompleteness: 'partial',
      evidence: [`Exported Verified Permissions Cedar schema metadata for policy store ${detail.policyStoreId}`]
    };
  }
}

function parseSchema(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

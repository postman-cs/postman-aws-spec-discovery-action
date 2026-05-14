import type { GatewayType } from '../../contracts.js';
import type { AwsGatewayClient, HttpApiSummary, RestApiSummary } from '../aws/client.js';
import { normalizeOpenApiYaml } from '../spec/normalize-openapi.js';
import type { ExportOptions, SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

export interface ApiGatewayProviderOptions {
  includeV2: boolean;
  apiFilter?: RegExp;
  /**
   * Optional hook invoked for each rewritten operationId so callers can
   * log the diff. We pass the original method/path so the message stays
   * actionable even when nothing else about the candidate is logged.
   */
  onOperationIdRenamed?: (rename: {
    path: string;
    method: string;
    original: string | null;
    renamed: string;
    candidateId: string;
  }) => void;
}

export class ApiGatewayProvider implements SpecProvider {
  public readonly type = 'api-gateway' as const;

  public constructor(
    private readonly client: AwsGatewayClient,
    private readonly options: ApiGatewayProviderOptions
  ) {}

  public async probe(): Promise<boolean> {
    try {
      await this.client.probeApiGatewayReadAccess();
      return true;
    } catch {
      return false;
    }
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const restApis = await this.client.listRestApis();
    const httpApis = this.options.includeV2 ? await this.client.listHttpApis() : [];

    const rest = restApis.map((api) => this.toCandidate(api, 'REST'));
    const http = httpApis
      .filter((api) => !api.protocolType || api.protocolType === 'HTTP' || api.protocolType === 'WEBSOCKET')
      .map((api) => this.toCandidate(api, api.protocolType === 'WEBSOCKET' ? 'WEBSOCKET' : 'HTTP'));

    const all = [...rest, ...http];
    if (this.options.apiFilter) {
      const filter = this.options.apiFilter;
      return all.filter((c) => filter.test(c.name));
    }
    return all;
  }

  public async exportSpec(candidate: SpecCandidate, options: ExportOptions): Promise<SpecExportResult> {
    const gatewayType = candidate.meta.gatewayType as GatewayType;
    const stage = options.stage ?? candidate.meta.stage;

    const rawContent =
      gatewayType === 'REST'
        ? await this.client.exportRestApi(candidate.id, stage ?? '')
        : await this.client.exportHttpApi(candidate.id, stage);

    const normalized = safeNormalizeOpenApi(rawContent);
    const evidence = [`Exported ${gatewayType} API ${candidate.id} via API Gateway`];
    if (normalized.renamed.length > 0) {
      evidence.push(`Normalized ${normalized.renamed.length} operationId(s) for OpenAPI uniqueness`);
      if (this.options.onOperationIdRenamed) {
        for (const rename of normalized.renamed) {
          this.options.onOperationIdRenamed({ ...rename, candidateId: candidate.id });
        }
      }
    }

    return {
      content: normalized.content,
      format: 'openapi-yaml',
      filename: 'index.yaml',
      stage,
      evidence
    };
  }

  private toCandidate(api: RestApiSummary | HttpApiSummary, gatewayType: GatewayType): SpecCandidate {
    return {
      id: api.id,
      name: api.name,
      providerType: 'api-gateway',
      tags: {},
      evidence: [],
      meta: { gatewayType }
    };
  }
}

// Run the normalizer but treat any unexpected error as a soft fail.
// If we throw here the export step fails outright, which is strictly
// worse than letting the original spec through and letting bootstrap's
// validator surface the underlying problem.
function safeNormalizeOpenApi(content: string): { content: string; renamed: { path: string; method: string; original: string | null; renamed: string }[] } {
  try {
    const result = normalizeOpenApiYaml(content);
    return { content: result.content, renamed: result.renamed };
  } catch {
    return { content, renamed: [] };
  }
}

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
  private restReadable: boolean | undefined;
  private v2Readable: boolean | undefined;

  public constructor(
    private readonly client: AwsGatewayClient,
    private readonly options: ApiGatewayProviderOptions
  ) {}

  public async probe(): Promise<boolean> {
    const checks: Promise<boolean>[] = [
      (async () => {
        try {
          await this.client.probeApiGatewayReadAccess();
          this.restReadable = true;
          return true;
        } catch {
          this.restReadable = false;
          return false;
        }
      })()
    ];

    if (this.options.includeV2 && this.client.probeHttpApiGatewayReadAccess) {
      checks.push((async () => {
        try {
          await this.client.probeHttpApiGatewayReadAccess?.();
          this.v2Readable = true;
          return true;
        } catch {
          this.v2Readable = false;
          return false;
        }
      })());
    }

    return (await Promise.all(checks)).some(Boolean);
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    let restApis: RestApiSummary[] = [];
    let httpApis: HttpApiSummary[] = [];

    if (this.restReadable !== false) {
      try {
        restApis = await this.client.listRestApis();
      } catch {
        restApis = [];
        this.restReadable = false;
      }
    }

    if (this.options.includeV2 && this.v2Readable !== false) {
      try {
        httpApis = await this.client.listHttpApis();
      } catch {
        httpApis = [];
        this.v2Readable = false;
      }
    }

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
        : gatewayType === 'WEBSOCKET'
          ? await this.client.exportWebSocketApi(candidate.id, stage)
          : await this.client.exportHttpApi(candidate.id, stage);

    const normalized = safeNormalizeOpenApi(rawContent);
    const evidence = [
      gatewayType === 'WEBSOCKET'
        ? `Synthesized partial OpenAPI 3.0 spec for WebSocket API ${candidate.id}`
        : `Exported ${gatewayType} API ${candidate.id} via API Gateway`
    ];
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

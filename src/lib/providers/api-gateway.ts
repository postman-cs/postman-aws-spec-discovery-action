import type { GatewayType } from '../../contracts.js';
import type { AwsGatewayClient, HttpApiSummary, RestApiSummary } from '../aws/client.js';
import type { ExportOptions, SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

export interface ApiGatewayProviderOptions {
  includeV2: boolean;
  apiFilter?: RegExp;
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

    const content =
      gatewayType === 'REST'
        ? await this.client.exportRestApi(candidate.id, stage ?? '')
        : await this.client.exportHttpApi(candidate.id, stage);

    return {
      content,
      format: 'openapi-yaml',
      filename: 'index.yaml',
      stage,
      evidence: [`Exported ${gatewayType} API ${candidate.id} via API Gateway`]
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

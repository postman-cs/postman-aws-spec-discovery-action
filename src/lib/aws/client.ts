import {
  APIGatewayClient,
  GetExportCommand,
  GetRestApiCommand,
  GetRestApisCommand,
  GetStagesCommand as GetRestStagesCommand,
  GetTagsCommand as GetRestTagsCommand,
  paginateGetRestApis
} from '@aws-sdk/client-api-gateway';
import {
  ApiGatewayV2Client,
  ExportApiCommand,
  GetApiCommand,
  GetApisCommand,
  GetStagesCommand as GetHttpStagesCommand,
  GetTagsCommand as GetHttpTagsCommand
} from '@aws-sdk/client-apigatewayv2';

export interface RestApiSummary {
  id: string;
  name: string;
}

export interface HttpApiSummary {
  id: string;
  name: string;
  protocolType: string;
}

export interface AwsGatewayClient {
  listRestApis(): Promise<RestApiSummary[]>;
  listHttpApis(): Promise<HttpApiSummary[]>;
  getRestApi(apiId: string): Promise<RestApiSummary | undefined>;
  getHttpApi(apiId: string): Promise<HttpApiSummary | undefined>;
  listRestStages(apiId: string): Promise<string[]>;
  listHttpStages(apiId: string): Promise<string[]>;
  getRestTags(apiId: string): Promise<Record<string, string>>;
  getHttpTags(apiId: string): Promise<Record<string, string>>;
  exportRestApi(apiId: string, stage: string): Promise<string>;
  exportHttpApi(apiId: string, stage?: string): Promise<string>;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readExportBody(body: unknown): Promise<string> {
  if (!body) {
    return '';
  }

  if (typeof body === 'string') {
    return body;
  }

  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }

  if (typeof body === 'object') {
    const maybeTransformable = body as {
      transformToString?: () => Promise<string>;
      transformToByteArray?: () => Promise<Uint8Array>;
    };
    if (typeof maybeTransformable.transformToString === 'function') {
      return await maybeTransformable.transformToString();
    }
    if (typeof maybeTransformable.transformToByteArray === 'function') {
      const bytes = await maybeTransformable.transformToByteArray();
      return new TextDecoder().decode(bytes);
    }
  }

  throw new Error('Unsupported AWS SDK export body type');
}

function isAwsNotFoundError(message: string): boolean {
  const lowered = message.toLowerCase();
  return lowered.includes('notfoundexception') || lowered.includes('not found');
}

export class AwsApiGatewaySdkClient implements AwsGatewayClient {
  private readonly restClient: APIGatewayClient;
  private readonly httpClient: ApiGatewayV2Client;

  public constructor(private readonly region: string) {
    this.restClient = new APIGatewayClient({ region });
    this.httpClient = new ApiGatewayV2Client({ region });
  }

  public async listRestApis(): Promise<RestApiSummary[]> {
    const items: RestApiSummary[] = [];
    for await (const page of paginateGetRestApis({ client: this.restClient }, {})) {
      for (const item of page.items ?? []) {
        if (!item.id) {
          continue;
        }
        items.push({
          id: item.id,
          name: (item.name ?? '').trim() || item.id
        });
      }
    }
    return items;
  }

  public async listHttpApis(): Promise<HttpApiSummary[]> {
    const items: HttpApiSummary[] = [];
    let nextToken: string | undefined;
    do {
      const response = await this.httpClient.send(
        new GetApisCommand({
          NextToken: nextToken
        })
      );
      for (const item of response.Items ?? []) {
        if (!item.ApiId) {
          continue;
        }
        items.push({
          id: item.ApiId,
          name: (item.Name ?? '').trim() || item.ApiId,
          protocolType: (item.ProtocolType ?? '').trim().toUpperCase()
        });
      }
      nextToken = response.NextToken;
    } while (nextToken);
    return items;
  }

  public async getRestApi(apiId: string): Promise<RestApiSummary | undefined> {
    try {
      const response = await this.restClient.send(
        new GetRestApiCommand({
          restApiId: apiId
        })
      );
      if (!response.id) {
        return undefined;
      }
      return {
        id: response.id,
        name: (response.name ?? '').trim() || response.id
      };
    } catch (error) {
      const message = toErrorMessage(error);
      if (isAwsNotFoundError(message)) {
        return undefined;
      }
      throw error;
    }
  }

  public async getHttpApi(apiId: string): Promise<HttpApiSummary | undefined> {
    try {
      const response = await this.httpClient.send(
        new GetApiCommand({
          ApiId: apiId
        })
      );
      if (!response.ApiId) {
        return undefined;
      }
      return {
        id: response.ApiId,
        name: (response.Name ?? '').trim() || response.ApiId,
        protocolType: (response.ProtocolType ?? '').trim().toUpperCase()
      };
    } catch (error) {
      const message = toErrorMessage(error);
      if (isAwsNotFoundError(message)) {
        return undefined;
      }
      throw error;
    }
  }

  public async listRestStages(apiId: string): Promise<string[]> {
    const response = await this.restClient.send(
      new GetRestStagesCommand({
        restApiId: apiId
      })
    );
    return (response.item ?? [])
      .map((stage) => (stage.stageName ?? '').trim())
      .filter((stage) => stage.length > 0);
  }

  public async listHttpStages(apiId: string): Promise<string[]> {
    const response = await this.httpClient.send(
      new GetHttpStagesCommand({
        ApiId: apiId
      })
    );
    return (response.Items ?? [])
      .map((stage) => (stage.StageName ?? '').trim())
      .filter((stage) => stage.length > 0);
  }

  public async getRestTags(apiId: string): Promise<Record<string, string>> {
    const resourceArn = `arn:aws:apigateway:${this.region}::/restapis/${apiId}`;
    const response = await this.restClient.send(
      new GetRestTagsCommand({
        resourceArn
      })
    );
    return response.tags ?? {};
  }

  public async getHttpTags(apiId: string): Promise<Record<string, string>> {
    const resourceArn = `arn:aws:apigateway:${this.region}::/apis/${apiId}`;
    const response = await this.httpClient.send(
      new GetHttpTagsCommand({
        ResourceArn: resourceArn
      })
    );
    return response.Tags ?? {};
  }

  public async exportRestApi(apiId: string, stage: string): Promise<string> {
    const response = await this.restClient.send(
      new GetExportCommand({
        restApiId: apiId,
        stageName: stage,
        exportType: 'oas30',
        accepts: 'application/yaml',
        parameters: {
          extensions: 'apigateway'
        }
      })
    );
    return await readExportBody(response.body);
  }

  public async exportHttpApi(apiId: string, stage?: string): Promise<string> {
    const response = await this.httpClient.send(
      new ExportApiCommand({
        ApiId: apiId,
        Specification: 'OAS30',
        OutputType: 'YAML',
        IncludeExtensions: stage ? true : false,
        StageName: stage
      })
    );
    return await readExportBody(response.body);
  }
}

import type { ExecOptions } from '@actions/exec';

export interface ExecLike {
  getExecOutput(
    commandLine: string,
    args?: string[],
    options?: ExecOptions
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

interface RestApisResponse {
  items?: Array<{
    id?: string;
    name?: string;
  }>;
}

interface HttpApisResponse {
  Items?: Array<{
    ApiId?: string;
    Name?: string;
  }>;
}

interface RestStagesResponse {
  item?: Array<{
    stageName?: string;
  }>;
}

interface HttpStagesResponse {
  Items?: Array<{
    StageName?: string;
  }>;
}

interface TagsResponse {
  tags?: Record<string, string>;
}

export interface RestApiSummary {
  id: string;
  name: string;
}

export interface HttpApiSummary {
  id: string;
  name: string;
}

export interface AwsGatewayClient {
  listRestApis(): Promise<RestApiSummary[]>;
  listHttpApis(): Promise<HttpApiSummary[]>;
  listRestStages(apiId: string): Promise<string[]>;
  listHttpStages(apiId: string): Promise<string[]>;
  getRestTags(apiId: string): Promise<Record<string, string>>;
  getHttpTags(apiId: string): Promise<Record<string, string>>;
  exportRestApi(apiId: string, stage: string): Promise<string>;
  exportHttpApi(apiId: string, stage: string): Promise<string>;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeMaybeBase64(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return raw;
  }

  const base64Pattern = /^[A-Za-z0-9+/=\r\n]+$/;
  if (!base64Pattern.test(trimmed) || trimmed.length % 4 !== 0) {
    return raw;
  }

  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    const printableChars = [...decoded].filter((ch) => {
      const code = ch.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126);
    }).length;
    const ratio = decoded.length === 0 ? 0 : printableChars / decoded.length;
    if (ratio >= 0.85) {
      return decoded;
    }
  } catch {
    return raw;
  }

  return raw;
}

export class AwsApiGatewayCliClient implements AwsGatewayClient {
  public constructor(
    private readonly exec: ExecLike,
    private readonly region: string
  ) {}

  public async listRestApis(): Promise<RestApiSummary[]> {
    const response = await this.runJson<RestApisResponse>([
      'apigateway',
      'get-rest-apis',
      '--region',
      this.region
    ]);

    return (response.items ?? [])
      .filter((item): item is { id: string; name?: string } => Boolean(item.id))
      .map((item) => ({
        id: item.id,
        name: (item.name ?? '').trim() || item.id
      }));
  }

  public async listHttpApis(): Promise<HttpApiSummary[]> {
    const response = await this.runJson<HttpApisResponse>([
      'apigatewayv2',
      'get-apis',
      '--region',
      this.region
    ]);

    return (response.Items ?? [])
      .filter((item): item is { ApiId: string; Name?: string } => Boolean(item.ApiId))
      .map((item) => ({
        id: item.ApiId,
        name: (item.Name ?? '').trim() || item.ApiId
      }));
  }

  public async listRestStages(apiId: string): Promise<string[]> {
    const response = await this.runJson<RestStagesResponse>([
      'apigateway',
      'get-stages',
      '--rest-api-id',
      apiId,
      '--region',
      this.region
    ]);
    return (response.item ?? [])
      .map((stage) => (stage.stageName ?? '').trim())
      .filter((stage) => stage.length > 0);
  }

  public async listHttpStages(apiId: string): Promise<string[]> {
    const response = await this.runJson<HttpStagesResponse>([
      'apigatewayv2',
      'get-stages',
      '--api-id',
      apiId,
      '--region',
      this.region
    ]);
    return (response.Items ?? [])
      .map((stage) => (stage.StageName ?? '').trim())
      .filter((stage) => stage.length > 0);
  }

  public async getRestTags(apiId: string): Promise<Record<string, string>> {
    const resourceArn = `arn:aws:apigateway:${this.region}::/restapis/${apiId}`;
    const response = await this.runJson<TagsResponse>([
      'apigateway',
      'get-tags',
      '--resource-arn',
      resourceArn,
      '--region',
      this.region
    ]);
    return response.tags ?? {};
  }

  public async getHttpTags(apiId: string): Promise<Record<string, string>> {
    const resourceArn = `arn:aws:apigateway:${this.region}::/apis/${apiId}`;
    const response = await this.runJson<TagsResponse>([
      'apigatewayv2',
      'get-tags',
      '--resource-arn',
      resourceArn,
      '--region',
      this.region
    ]);
    return response.tags ?? {};
  }

  public async exportRestApi(apiId: string, stage: string): Promise<string> {
    const body = await this.runText([
      'apigateway',
      'get-export',
      '--rest-api-id',
      apiId,
      '--stage-name',
      stage,
      '--parameters',
      "extensions='apigateway'",
      '--export-type',
      'oas30',
      '--accepts',
      'application/yaml',
      '--region',
      this.region,
      '--query',
      'body',
      '--output',
      'text'
    ]);
    return decodeMaybeBase64(body);
  }

  public async exportHttpApi(apiId: string, stage: string): Promise<string> {
    const body = await this.runText([
      'apigatewayv2',
      'export-api',
      '--api-id',
      apiId,
      '--stage-name',
      stage,
      '--specification',
      'OAS30',
      '--output-type',
      'YAML',
      '--region',
      this.region,
      '--query',
      'body',
      '--output',
      'text'
    ]);
    return decodeMaybeBase64(body);
  }

  private async runJson<T>(args: string[]): Promise<T> {
    const result = await this.exec.getExecOutput('aws', args, {
      ignoreReturnCode: true,
      silent: true
    });

    if (result.exitCode !== 0) {
      throw new Error(`aws ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }

    try {
      return JSON.parse(result.stdout) as T;
    } catch (error) {
      throw new Error(`Failed to parse AWS CLI JSON output: ${toErrorMessage(error)}`);
    }
  }

  private async runText(args: string[]): Promise<string> {
    const result = await this.exec.getExecOutput('aws', args, {
      ignoreReturnCode: true,
      silent: true
    });

    if (result.exitCode !== 0) {
      throw new Error(`aws ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }

    return result.stdout;
  }
}

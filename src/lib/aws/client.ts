import type { ExecOptions } from '@actions/exec';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
    ProtocolType?: string;
  }>;
}

interface RestApiDetailResponse {
  id?: string;
  name?: string;
}

interface HttpApiDetailResponse {
  ApiId?: string;
  Name?: string;
  ProtocolType?: string;
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

function isAwsNotFoundError(message: string): boolean {
  const lowered = message.toLowerCase();
  return lowered.includes('notfoundexception') || lowered.includes('not found');
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
      .filter((item): item is { ApiId: string; Name?: string; ProtocolType?: string } => Boolean(item.ApiId))
      .map((item) => ({
        id: item.ApiId,
        name: (item.Name ?? '').trim() || item.ApiId,
        protocolType: (item.ProtocolType ?? '').trim().toUpperCase()
      }));
  }

  public async getRestApi(apiId: string): Promise<RestApiSummary | undefined> {
    try {
      const response = await this.runJson<RestApiDetailResponse>([
        'apigateway',
        'get-rest-api',
        '--rest-api-id',
        apiId,
        '--region',
        this.region
      ]);
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
      const response = await this.runJson<HttpApiDetailResponse>([
        'apigatewayv2',
        'get-api',
        '--api-id',
        apiId,
        '--region',
        this.region
      ]);
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
    const body = await this.runTextToFile([
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
      this.region
    ]);
    return decodeMaybeBase64(body);
  }

  public async exportHttpApi(apiId: string, stage?: string): Promise<string> {
    const args = [
      'apigatewayv2',
      'export-api',
      '--api-id',
      apiId,
      '--specification',
      'OAS30',
      '--output-type',
      'YAML',
      '--region',
      this.region
    ];
    if (stage) {
      args.push('--stage-name', stage);
    } else {
      args.push('--no-include-extensions');
    }
    const body = await this.runTextToFile(args);
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

  private async runTextToFile(args: string[]): Promise<string> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-aws-spec-'));
    const outFile = path.join(tempDir, 'spec.out');
    try {
      const result = await this.exec.getExecOutput('aws', [...args, outFile], {
        ignoreReturnCode: true,
        silent: true
      });
      if (result.exitCode !== 0) {
        throw new Error(`aws ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      try {
        return await readFile(outFile, 'utf8');
      } catch (error) {
        // Test stubs and some CLI responses may surface content in stdout.
        if (result.stdout.trim().length > 0) {
          return result.stdout;
        }
        throw error;
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

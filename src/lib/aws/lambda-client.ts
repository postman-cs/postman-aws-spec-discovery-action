import {
  LambdaClient,
  GetFunctionUrlConfigCommand,
  ListFunctionsCommand,
  ListTagsCommand,
  paginateListFunctions
} from '@aws-sdk/client-lambda';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export interface LambdaFunctionSummary {
  name: string;
  arn: string;
  runtime?: string;
}

export interface LambdaUrlCors {
  allowCredentials?: boolean;
  allowHeaders?: string[];
  allowMethods?: string[];
  allowOrigins?: string[];
  exposeHeaders?: string[];
  maxAge?: number;
}

export interface LambdaUrlConfig {
  functionArn: string;
  functionUrl: string;
  authType: 'NONE' | 'AWS_IAM';
  invokeMode?: 'BUFFERED' | 'RESPONSE_STREAM';
  cors?: LambdaUrlCors;
}

export interface LambdaSpecClient {
  listFunctions(): Promise<LambdaFunctionSummary[]>;
  getFunctionUrlConfig(functionName: string): Promise<LambdaUrlConfig | undefined>;
  getTags(functionArn: string): Promise<Record<string, string>>;
  probe(): Promise<boolean>;
}

function isResourceNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const maybe = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  if (maybe.name === 'ResourceNotFoundException') {
    return true;
  }
  if (maybe.$metadata?.httpStatusCode === 404) {
    return true;
  }
  const message = (maybe.message ?? '').toLowerCase();
  return message.includes('resourcenotfoundexception') || message.includes('not found');
}

export class LambdaSdkClient implements LambdaSpecClient {
  private readonly client: LambdaClient;

  public constructor(region: string, options: { requestTimeoutMs?: number; maxAttempts?: number } = {}) {
    const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.client = new LambdaClient({
      region,
      maxAttempts: options.maxAttempts ?? 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: requestTimeoutMs,
        socketTimeout: requestTimeoutMs
      })
    });
  }

  public async listFunctions(): Promise<LambdaFunctionSummary[]> {
    const items: LambdaFunctionSummary[] = [];
    for await (const page of paginateListFunctions({ client: this.client }, {})) {
      for (const fn of page.Functions ?? []) {
        if (!fn.FunctionName || !fn.FunctionArn) continue;
        items.push({
          name: fn.FunctionName,
          arn: fn.FunctionArn,
          runtime: fn.Runtime
        });
      }
    }
    return items;
  }

  public async getFunctionUrlConfig(functionName: string): Promise<LambdaUrlConfig | undefined> {
    try {
      const response = await this.client.send(new GetFunctionUrlConfigCommand({ FunctionName: functionName }));
      if (!response.FunctionUrl || !response.FunctionArn || !response.AuthType) {
        return undefined;
      }
      const cors = response.Cors;
      return {
        functionArn: response.FunctionArn,
        functionUrl: response.FunctionUrl,
        authType: response.AuthType as 'NONE' | 'AWS_IAM',
        invokeMode: response.InvokeMode as 'BUFFERED' | 'RESPONSE_STREAM' | undefined,
        cors: cors
          ? {
              allowCredentials: cors.AllowCredentials,
              allowHeaders: cors.AllowHeaders,
              allowMethods: cors.AllowMethods,
              allowOrigins: cors.AllowOrigins,
              exposeHeaders: cors.ExposeHeaders,
              maxAge: cors.MaxAge
            }
          : undefined
      };
    } catch (error) {
      if (isResourceNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  public async getTags(functionArn: string): Promise<Record<string, string>> {
    try {
      const response = await this.client.send(new ListTagsCommand({ Resource: functionArn }));
      return response.Tags ?? {};
    } catch (error) {
      if (isResourceNotFound(error)) {
        return {};
      }
      throw error;
    }
  }

  public async probe(): Promise<boolean> {
    try {
      await this.client.send(new ListFunctionsCommand({ MaxItems: 1 }));
      return true;
    } catch {
      return false;
    }
  }
}

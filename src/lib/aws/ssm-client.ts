import {
  SSMClient,
  GetParametersByPathCommand
} from '@aws-sdk/client-ssm';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export interface SsmSpecEntry {
  serviceName: string;
  key: string;
  value: string;
}

export interface SsmSpecClient {
  listSpecParameters(pathPrefix?: string): Promise<SsmSpecEntry[]>;
  probe(): Promise<boolean>;
}

const DEFAULT_PATH_PREFIX = '/postman/specs';

export class SsmSdkClient implements SsmSpecClient {
  private readonly client: SSMClient;

  public constructor(region: string, options: { requestTimeoutMs?: number; maxAttempts?: number } = {}) {
    const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.client = new SSMClient({
      region,
      maxAttempts: options.maxAttempts ?? 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: requestTimeoutMs,
        socketTimeout: requestTimeoutMs
      })
    });
  }

  public async listSpecParameters(pathPrefix: string = DEFAULT_PATH_PREFIX): Promise<SsmSpecEntry[]> {
    const items: SsmSpecEntry[] = [];
    let nextToken: string | undefined;
    do {
      const response = await this.client.send(
        new GetParametersByPathCommand({
          Path: pathPrefix,
          Recursive: true,
          WithDecryption: true,
          NextToken: nextToken
        })
      );
      for (const param of response.Parameters ?? []) {
        if (!param.Name || !param.Value) continue;
        // Path format: /postman/specs/{service-name}/{key}
        // e.g., /postman/specs/auth-service/url
        //        /postman/specs/auth-service/content
        const parts = param.Name.replace(pathPrefix, '').replace(/^\//, '').split('/');
        if (parts.length < 2) continue;
        const serviceName = parts[0] ?? '';
        const key = parts.slice(1).join('/');
        items.push({ serviceName, key, value: param.Value });
      }
      nextToken = response.NextToken;
    } while (nextToken);
    return items;
  }

  public async probe(): Promise<boolean> {
    try {
      await this.client.send(
        new GetParametersByPathCommand({ Path: DEFAULT_PATH_PREFIX, Recursive: false, MaxResults: 1 })
      );
      return true;
    } catch {
      return false;
    }
  }
}

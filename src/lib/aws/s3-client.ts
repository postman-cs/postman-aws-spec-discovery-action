import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export interface S3SpecClient {
  getObject(bucket: string, key: string, versionId?: string): Promise<string>;
}

async function readObjectBody(body: unknown): Promise<string> {
  if (!body) return '';
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (typeof body === 'object') {
    const maybeTransformable = body as {
      transformToString?: () => Promise<string>;
      transformToByteArray?: () => Promise<Uint8Array>;
    };
    if (typeof maybeTransformable.transformToString === 'function') {
      return await maybeTransformable.transformToString();
    }
    if (typeof maybeTransformable.transformToByteArray === 'function') {
      return new TextDecoder().decode(await maybeTransformable.transformToByteArray());
    }
  }
  throw new Error('Unsupported S3 object body type');
}

export class S3SdkClient implements S3SpecClient {
  private readonly client: S3Client;

  public constructor(region: string, options: { requestTimeoutMs?: number; maxAttempts?: number } = {}) {
    const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.client = new S3Client({
      region,
      maxAttempts: options.maxAttempts ?? 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: requestTimeoutMs,
        socketTimeout: requestTimeoutMs
      })
    });
  }

  public async getObject(bucket: string, key: string, versionId?: string): Promise<string> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        VersionId: versionId
      })
    );
    return readObjectBody(response.Body);
  }
}

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';

/**
 * Exact-object S3 client used for trusted BodyS3Location / s3:// DefinitionUri refs.
 * Callers must never enumerate buckets; only exact bucket/key/version triples are eligible.
 */
export interface S3SpecClient {
  getObject(bucket: string, key: string, versionId?: string): Promise<string>;
}

/** Deterministic maximum object size for exact S3 OpenAPI reads (10 MiB). */
export const MAX_S3_OBJECT_BYTES = 10 * 1024 * 1024;

export interface S3SdkClientOptions {
  requestTimeoutMs?: number;
  maxAttempts?: number;
  /** Overrideable for tests; production defaults to {@link MAX_S3_OBJECT_BYTES}. */
  maxObjectBytes?: number;
}

async function readObjectBodyBounded(
  body: unknown,
  contentLength: number | undefined,
  maxBytes: number
): Promise<string> {
  if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`S3 object too large (${contentLength} bytes); limit is ${maxBytes}`);
  }

  if (!body) return '';
  if (typeof body === 'string') {
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > maxBytes) {
      throw new Error(`S3 object body too large (over ${maxBytes} bytes); limit is ${maxBytes}`);
    }
    return body;
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) {
      throw new Error(`S3 object body too large (over ${maxBytes} bytes); limit is ${maxBytes}`);
    }
    return new TextDecoder().decode(body);
  }

  if (typeof body === 'object') {
    const streamLike = body as {
      getReader?: () => ReadableStreamDefaultReader<Uint8Array>;
      destroy?: (error?: Error) => void;
      [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string | Buffer>;
      transformToByteArray?: () => Promise<Uint8Array>;
      transformToString?: () => Promise<string>;
    };

    if (typeof streamLike.getReader === 'function') {
      const reader = streamLike.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          received += value.byteLength;
          if (received > maxBytes) {
            await reader.cancel();
            throw new Error(`S3 object body too large (over ${maxBytes} bytes); limit is ${maxBytes}`);
          }
          chunks.push(value);
        }
      } catch (error) {
        try {
          await reader.cancel();
        } catch {
          // ignore cancel races
        }
        throw error;
      }
      const buffer = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(buffer);
    }

    if (typeof streamLike[Symbol.asyncIterator] === 'function') {
      const chunks: Uint8Array[] = [];
      let received = 0;
      try {
        for await (const chunk of streamLike as AsyncIterable<Uint8Array | string | Buffer>) {
          const bytes =
            typeof chunk === 'string'
              ? new TextEncoder().encode(chunk)
              : chunk instanceof Uint8Array
                ? chunk
                : new Uint8Array(chunk);
          received += bytes.byteLength;
          if (received > maxBytes) {
            if (typeof streamLike.destroy === 'function') {
              streamLike.destroy(new Error(`S3 object body too large (over ${maxBytes} bytes)`));
            }
            throw new Error(`S3 object body too large (over ${maxBytes} bytes); limit is ${maxBytes}`);
          }
          chunks.push(bytes);
        }
      } catch (error) {
        if (typeof streamLike.destroy === 'function') {
          try {
            streamLike.destroy();
          } catch {
            // ignore destroy races
          }
        }
        throw error;
      }
      const buffer = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(buffer);
    }

    // Last resort for SDK stream mixins that only expose transform helpers.
    // Prefer transformToByteArray so we can enforce the byte limit before decoding.
    if (typeof streamLike.transformToByteArray === 'function') {
      const bytes = await streamLike.transformToByteArray();
      if (bytes.byteLength > maxBytes) {
        throw new Error(`S3 object body too large (over ${maxBytes} bytes); limit is ${maxBytes}`);
      }
      return new TextDecoder().decode(bytes);
    }
    if (typeof streamLike.transformToString === 'function') {
      const text = await streamLike.transformToString();
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > maxBytes) {
        throw new Error(`S3 object body too large (over ${maxBytes} bytes); limit is ${maxBytes}`);
      }
      return text;
    }
  }

  throw new Error('Unsupported S3 object body type');
}

export class S3SdkClient implements S3SpecClient {
  private readonly client: S3Client;
  private readonly maxObjectBytes: number;

  public constructor(region: string, options: S3SdkClientOptions = {}) {
    const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.maxObjectBytes = options.maxObjectBytes ?? MAX_S3_OBJECT_BYTES;
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
    return readObjectBodyBounded(response.Body, response.ContentLength, this.maxObjectBytes);
  }
}

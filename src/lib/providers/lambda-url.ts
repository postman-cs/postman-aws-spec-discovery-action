import type { LambdaSpecClient, LambdaUrlCors } from '../aws/lambda-client.js';
import type { ExportOptions, SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

export class LambdaUrlProvider implements SpecProvider {
  public readonly type = 'lambda-url' as const;

  public constructor(private readonly client: LambdaSpecClient) {}

  public async probe(): Promise<boolean> {
    return this.client.probe();
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const functions = await this.client.listFunctions();
    const candidates: SpecCandidate[] = [];

    for (const fn of functions) {
      const config = await this.client.getFunctionUrlConfig(fn.name);
      if (!config) {
        continue;
      }
      const tags = await this.client.getTags(config.functionArn).catch((): Record<string, string> => ({}));
      candidates.push({
        id: fn.name,
        name: fn.name,
        providerType: 'lambda-url',
        tags,
        evidence: [`Lambda Function URL configured for ${fn.name} (${config.authType})`],
        meta: {
          functionArn: config.functionArn,
          functionUrl: config.functionUrl,
          authType: config.authType,
          invokeMode: config.invokeMode ?? '',
          corsJson: config.cors ? JSON.stringify(config.cors) : '',
          runtime: fn.runtime ?? '',
          gatewayType: 'LAMBDA_URL'
        }
      });
    }

    return candidates;
  }

  public async exportSpec(candidate: SpecCandidate, _options?: ExportOptions): Promise<SpecExportResult> {
    void _options;
    const functionArn = candidate.meta.functionArn ?? '';
    const functionUrl = candidate.meta.functionUrl ?? '';
    const authType = (candidate.meta.authType as 'NONE' | 'AWS_IAM' | undefined) ?? 'NONE';
    const invokeMode = (candidate.meta.invokeMode || undefined) as 'BUFFERED' | 'RESPONSE_STREAM' | undefined;
    const cors = parseCors(candidate.meta.corsJson);
    const title =
      (candidate.tags['postman:project-name'] ?? '').trim() ||
      (candidate.tags.Name ?? '').trim() ||
      candidate.name;

    const yaml = synthesizeLambdaUrlOpenApi({
      title,
      functionArn,
      functionUrl,
      authType,
      invokeMode,
      cors
    });

    return {
      content: yaml,
      format: 'openapi-yaml',
      filename: 'index.yaml',
      evidence: [`Synthesized OpenAPI spec for Lambda Function URL ${candidate.name} (${authType})`]
    };
  }
}

function parseCors(raw: string | undefined): LambdaUrlCors | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as LambdaUrlCors;
    return parsed;
  } catch {
    return undefined;
  }
}

interface SynthesizeArgs {
  title: string;
  functionArn: string;
  functionUrl: string;
  authType: 'NONE' | 'AWS_IAM';
  invokeMode?: 'BUFFERED' | 'RESPONSE_STREAM';
  cors?: LambdaUrlCors;
}

const STANDARD_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;

export function synthesizeLambdaUrlOpenApi(args: SynthesizeArgs): string {
  const lines: string[] = [];
  lines.push('openapi: 3.0.3');
  lines.push('info:');
  lines.push(`  title: ${quoteYaml(args.title)}`);
  lines.push(`  description: ${quoteYaml(`Synthesized specification for Lambda Function URL (${args.authType}). Lambda functions accept any path and method; this spec uses a catch-all path.`)}`);
  lines.push('  version: "1.0.0"');
  lines.push('servers:');
  lines.push(`  - url: ${quoteYaml(stripTrailingSlash(args.functionUrl))}`);
  lines.push(`    description: ${quoteYaml('Lambda Function URL endpoint')}`);
  lines.push(`x-aws-lambda-function-arn: ${quoteYaml(args.functionArn)}`);
  lines.push(`x-aws-lambda-function-url-auth-type: ${quoteYaml(args.authType)}`);
  if (args.invokeMode) {
    lines.push(`x-aws-lambda-invoke-mode: ${quoteYaml(args.invokeMode)}`);
  }
  if (args.cors) {
    lines.push('x-aws-cors:');
    if (args.cors.allowCredentials !== undefined) {
      lines.push(`  allowCredentials: ${args.cors.allowCredentials ? 'true' : 'false'}`);
    }
    if (args.cors.allowOrigins?.length) {
      lines.push('  allowOrigins:');
      for (const origin of args.cors.allowOrigins) {
        lines.push(`    - ${quoteYaml(origin)}`);
      }
    }
    if (args.cors.allowMethods?.length) {
      lines.push('  allowMethods:');
      for (const method of args.cors.allowMethods) {
        lines.push(`    - ${quoteYaml(method)}`);
      }
    }
    if (args.cors.allowHeaders?.length) {
      lines.push('  allowHeaders:');
      for (const header of args.cors.allowHeaders) {
        lines.push(`    - ${quoteYaml(header)}`);
      }
    }
    if (args.cors.exposeHeaders?.length) {
      lines.push('  exposeHeaders:');
      for (const header of args.cors.exposeHeaders) {
        lines.push(`    - ${quoteYaml(header)}`);
      }
    }
    if (args.cors.maxAge !== undefined) {
      lines.push(`  maxAge: ${args.cors.maxAge}`);
    }
  }

  lines.push('paths:');
  lines.push("  /{proxy}:");
  lines.push('    parameters:');
  lines.push('      - name: proxy');
  lines.push('        in: path');
  lines.push('        required: true');
  lines.push('        description: Catch-all path forwarded to the Lambda handler.');
  lines.push('        schema:');
  lines.push('          type: string');
  for (const method of STANDARD_METHODS) {
    lines.push(`    ${method}:`);
    lines.push(`      summary: ${quoteYaml(`${method.toUpperCase()} request handled by Lambda`)}`);
    lines.push('      operationId: ' + `${method}LambdaUrl`);
    if (args.authType === 'AWS_IAM') {
      lines.push('      security:');
      lines.push('        - awsSigV4: []');
    }
    lines.push('      requestBody:');
    lines.push('        required: false');
    lines.push('        content:');
    lines.push('          application/json:');
    lines.push('            schema:');
    lines.push('              type: object');
    lines.push('              additionalProperties: true');
    lines.push('      responses:');
    lines.push('        "200":');
    lines.push('          description: Lambda handler response');
    lines.push('          content:');
    lines.push('            application/json:');
    lines.push('              schema:');
    lines.push('                type: object');
    lines.push('                additionalProperties: true');
    lines.push('        default:');
    lines.push('          description: Error response');
    lines.push('          content:');
    lines.push('            application/json:');
    lines.push('              schema:');
    lines.push('                type: object');
    lines.push('                additionalProperties: true');
  }

  if (args.authType === 'AWS_IAM') {
    lines.push('components:');
    lines.push('  securitySchemes:');
    lines.push('    awsSigV4:');
    lines.push('      type: apiKey');
    lines.push('      in: header');
    lines.push('      name: Authorization');
    lines.push('      description: AWS Signature Version 4 signed request required by IAM auth.');
    lines.push('security:');
    lines.push('  - awsSigV4: []');
  }

  return lines.join('\n') + '\n';
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function quoteYaml(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

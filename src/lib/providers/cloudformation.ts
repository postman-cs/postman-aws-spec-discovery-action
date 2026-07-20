import { parse } from 'yaml';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { CloudFormationSpecClient } from '../aws/cloudformation-client.js';
import type { S3SpecClient } from '../aws/s3-client.js';
import type { ExportOptions, SpecCandidate, SpecExportResult, SpecProvider } from './types.js';
import { resolvePathWithinRoot } from '../utils/resolve-path-within-root.js';

export interface TemplateResource {
  Type: string;
  Properties?: Record<string, unknown>;
}

export interface ParsedTemplate {
  Resources?: Record<string, TemplateResource>;
}

export const CFN_CUSTOM_TAGS = [
  '!Ref', '!Sub', '!GetAtt', '!Join', '!Select', '!Split',
  '!If', '!Equals', '!Not', '!And', '!Or', '!FindInMap',
  '!Base64', '!Cidr', '!ImportValue', '!GetAZs', '!Transform',
  '!Condition'
].map((tag) => ({ tag, identify: () => false, resolve: (_v: unknown) => _v }));

interface S3Location {
  bucket: string;
  key: string;
  version?: string;
}

export interface ExtractedSpec {
  content: string;
  format: SpecExportResult['format'];
  filename: string;
}

export function isOpenApiDocument(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && ((value as Record<string, unknown>).openapi || (value as Record<string, unknown>).swagger));
}

/** True when a template value is an unresolved CloudFormation intrinsic. */
export function isCfnUnresolvedIntrinsic(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') {
    return /\$\{/.test(value) || /^!/.test(value.trim());
  }
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0) return false;
  return keys.every((key) => /^(Ref|Fn::|Condition)$/.test(key) || key.startsWith('Fn::'));
}

export function describeCfnUnresolved(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface CfnLiteralOutput {
  name: string;
  value: string;
  noEcho: boolean;
}

/** Extract literal string Outputs only; unresolved Values are omitted. */
export function extractLiteralCfnOutputs(template: ParsedTemplate & { Outputs?: Record<string, unknown> }): CfnLiteralOutput[] {
  const outputs = template.Outputs;
  if (!outputs || typeof outputs !== 'object') return [];
  const results: CfnLiteralOutput[] = [];
  for (const name of Object.keys(outputs).sort()) {
    const entry = outputs[name];
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const value = record.Value;
    if (typeof value === 'string' && !isCfnUnresolvedIntrinsic(value)) {
      results.push({ name, value, noEcho: Boolean(record.NoEcho) });
    }
  }
  return results;
}

function detectOpenApiContent(content: string): boolean {
  try {
    const parsed = content.trim().startsWith('{') ? JSON.parse(content) : parse(content, { customTags: CFN_CUSTOM_TAGS as never[] });
    return isOpenApiDocument(parsed);
  } catch {
    return false;
  }
}

function openApiFormatForContent(content: string): Pick<ExtractedSpec, 'format' | 'filename'> {
  return content.trim().startsWith('{')
    ? { format: 'openapi-json', filename: 'index.json' }
    : { format: 'openapi-yaml', filename: 'index.yaml' };
}

function parseS3Uri(uri: string): S3Location | undefined {
  if (!uri.startsWith('s3://')) return undefined;
  const withoutScheme = uri.slice('s3://'.length);
  const [bucket, ...rest] = withoutScheme.split('/');
  const key = rest.join('/');
  if (!bucket || !key) return undefined;
  return { bucket, key };
}

function parseS3Location(value: unknown): S3Location | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const bucket = typeof record.Bucket === 'string' ? record.Bucket : typeof record.bucket === 'string' ? record.bucket : undefined;
  const key = typeof record.Key === 'string' ? record.Key : typeof record.key === 'string' ? record.key : undefined;
  const version =
    typeof record.Version === 'string'
      ? record.Version
      : typeof record.VersionId === 'string'
        ? record.VersionId
        : typeof record.version === 'string'
          ? record.version
          : undefined;
  return bucket && key ? { bucket, key, version } : undefined;
}

async function readReferencedSpec(repoRoot: string, s3Client: S3SpecClient | undefined, value: unknown): Promise<string | undefined> {
  if (isCfnUnresolvedIntrinsic(value)) {
    return undefined;
  }
  if (typeof value === 'string') {
    const s3 = parseS3Uri(value);
    if (s3) {
      if (!s3Client) return undefined;
      return s3Client.getObject(s3.bucket, s3.key, s3.version);
    }
    if (/^https?:\/\//i.test(value)) {
      return undefined;
    }
    const localPath = resolvePathWithinRoot(path.resolve(repoRoot), value, 'definition-uri');
    return readFile(localPath, 'utf8');
  }

  const s3 = parseS3Location(value);
  if (s3 && s3Client) {
    return s3Client.getObject(s3.bucket, s3.key, s3.version);
  }
  return undefined;
}

async function extractEmbeddedSpec(resource: TemplateResource, repoRoot: string, s3Client?: S3SpecClient): Promise<ExtractedSpec | undefined> {
  const props = resource.Properties;
  if (!props) return undefined;

  // SAM resources use DefinitionBody, CloudFormation uses Body
  const body = props.DefinitionBody ?? props.Body;
  if (body && typeof body === 'object' && isOpenApiDocument(body)) {
    // It's an inline OpenAPI/Swagger spec -- serialize it back
    return { content: JSON.stringify(body, null, 2), format: 'openapi-json', filename: 'index.json' };
  }

  const ref = props.DefinitionUri ?? props.BodyS3Location;
  const referenced = await readReferencedSpec(repoRoot, s3Client, ref);
  if (referenced && detectOpenApiContent(referenced)) {
    return { content: referenced, ...openApiFormatForContent(referenced) };
  }

  return undefined;
}

/** Parse a CloudFormation/SAM template body (JSON or YAML with CFN intrinsics). */
export function parseCfnTemplateBody(templateBody: string): ParsedTemplate {
  if (templateBody.trim().startsWith('{')) {
    return JSON.parse(templateBody) as ParsedTemplate;
  }
  const originalWarn = process.emitWarning;
  process.emitWarning = (() => {}) as typeof process.emitWarning;
  try {
    return parse(templateBody, { customTags: CFN_CUSTOM_TAGS as never[] }) as ParsedTemplate;
  } finally {
    process.emitWarning = originalWarn;
  }
}

/**
 * Extract an inline OpenAPI/Swagger document from a template resource Body or
 * DefinitionBody. Never follows DefinitionUri/BodyS3Location references.
 */
export function extractInlineEmbeddedSpec(resource: TemplateResource): ExtractedSpec | undefined {
  const props = resource.Properties;
  if (!props) return undefined;
  const body = props.DefinitionBody ?? props.Body;
  if (body && typeof body === 'object' && isOpenApiDocument(body)) {
    return { content: JSON.stringify(body, null, 2), format: 'openapi-json', filename: 'index.json' };
  }
  return undefined;
}

export class CloudFormationProvider implements SpecProvider {
  public readonly type = 'cloudformation' as const;

  public constructor(
    private readonly client: CloudFormationSpecClient,
    private readonly repoRoot = '.',
    private readonly s3Client?: S3SpecClient
  ) {}

  public async probe(): Promise<boolean> {
    return this.client.probe();
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const stacks = await this.client.listActiveStacks();
    const candidates: SpecCandidate[] = [];

    for (const stack of stacks) {
      const apiResources = await this.client.listApiResources(stack.name);
      if (apiResources.length === 0) continue;

      for (const resource of apiResources) {
        candidates.push({
          id: `${stack.name}/${resource.logicalId}`,
          name: resource.logicalId,
          providerType: 'cloudformation',
          tags: {},
          evidence: [`Found ${resource.type} in CloudFormation stack ${stack.name}`],
          meta: {
            stackName: stack.name,
            logicalId: resource.logicalId,
            physicalId: resource.physicalId,
            resourceType: resource.type
          }
        });
      }
    }

    return candidates;
  }

  public async exportSpec(candidate: SpecCandidate, _options?: ExportOptions): Promise<SpecExportResult> {
    void _options;
    const stackName = candidate.meta.stackName ?? '';
    const logicalId = candidate.meta.logicalId ?? '';

    const templateBody = await this.client.getTemplate(stackName);
    let template: ParsedTemplate;
    try {
      if (templateBody.trim().startsWith('{')) {
        template = JSON.parse(templateBody);
      } else {
        // Suppress YAML warnings for CloudFormation intrinsic functions (!Ref, !Sub, etc.)
        const originalWarn = process.emitWarning;
        process.emitWarning = (() => {}) as typeof process.emitWarning;
        try {
          template = parse(templateBody, { customTags: CFN_CUSTOM_TAGS as never[] });
        } finally {
          process.emitWarning = originalWarn;
        }
      }
    } catch {
      throw new Error(`Failed to parse CloudFormation template for stack ${stackName}`);
    }

    const resource = template.Resources?.[logicalId];
    if (!resource) {
      throw new Error(`Resource ${logicalId} not found in stack ${stackName} template`);
    }

    const spec = await extractEmbeddedSpec(resource, this.repoRoot, this.s3Client);
    if (!spec) {
      throw new Error(`No embedded or referenced OpenAPI spec found in ${candidate.meta.resourceType} resource ${logicalId} of stack ${stackName}`);
    }

    return {
      content: spec.content,
      format: spec.format,
      filename: spec.filename,
      evidence: [`Extracted embedded spec from ${candidate.meta.resourceType} in CloudFormation stack ${stackName}`]
    };
  }
}

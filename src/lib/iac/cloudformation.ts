import path from 'node:path';

import type { GatewayType } from '../../contracts.js';
import {
  extractInlineEmbeddedSpec,
  parseCfnTemplateBody,
  type ParsedTemplate,
  type TemplateResource
} from '../providers/cloudformation.js';
import type { S3SpecClient } from '../aws/s3-client.js';
import { classifyIacArtifact } from './freshness.js';
import {
  describeUnresolved,
  detectOpenApiContent,
  isExactApiGatewayId,
  isUnresolvedIntrinsic,
  openApiFormatForContent
} from './openapi.js';
import { createIacTraversal, dirnamePosix, readIacFile, toPosix, type IacReadBudget } from './read.js';
import {
  API_RESOURCE_TYPES,
  type IacResolutionError,
  type IacSpecCandidate,
  type IacSourceKind
} from './types.js';

interface S3Location {
  bucket: string;
  key: string;
  version?: string;
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
  if (isUnresolvedIntrinsic(record)) return undefined;
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
  if (!bucket || !key || isUnresolvedIntrinsic(bucket) || isUnresolvedIntrinsic(key)) {
    return undefined;
  }
  return { bucket, key, version };
}

function gatewayTypeFor(resourceType: string | undefined): GatewayType | undefined {
  if (!resourceType) return undefined;
  return (API_RESOURCE_TYPES as Record<string, GatewayType>)[resourceType];
}

function sourceKindFor(templatePath: string, resourceType?: string): IacSourceKind {
  if (resourceType?.startsWith('AWS::Serverless::') || /(^|\/)template\.ya?ml$/i.test(templatePath) && templatePath.includes('.aws-sam')) {
    return 'sam';
  }
  if (templatePath.includes('cdk.out') || templatePath.endsWith('.template.json')) {
    return 'cdk';
  }
  if (resourceType?.startsWith('AWS::Serverless::')) {
    return 'sam';
  }
  return 'cloudformation';
}

async function resolveReferencedSpec(
  repoRoot: string,
  templateRelative: string,
  value: unknown,
  budget: IacReadBudget,
  errors: IacResolutionError[],
  s3Client?: S3SpecClient
): Promise<{ content: string; kind: 'openapi-local-ref' | 'openapi-s3-ref'; evidence: string } | { unresolved: string } | undefined> {
  if (isUnresolvedIntrinsic(value)) {
    return { unresolved: describeUnresolved(value) };
  }

  if (typeof value === 'string') {
    if (isUnresolvedIntrinsic(value)) {
      return { unresolved: value };
    }
    const s3 = parseS3Uri(value);
    if (s3) {
      if (!s3Client) {
        return { unresolved: `s3://${s3.bucket}/${s3.key} (no S3 client)` };
      }
      try {
        const content = await s3Client.getObject(s3.bucket, s3.key, s3.version);
        if (detectOpenApiContent(content)) {
          return {
            content,
            kind: 'openapi-s3-ref',
            evidence: `Resolved exact S3 DefinitionUri s3://${s3.bucket}/${s3.key}`
          };
        }
      } catch (error) {
        errors.push({
          code: 'unreadable',
          path: templateRelative,
          message: `Failed S3 getObject s3://${s3.bucket}/${s3.key}: ${error instanceof Error ? error.message : String(error)}`
        });
      }
      return undefined;
    }
    if (/^https?:\/\//i.test(value)) {
      return { unresolved: value };
    }
    const baseDir = dirnamePosix(templateRelative);
    const traversal = createIacTraversal();
    const local = await readIacFile(repoRoot, value, budget, errors, {
      fieldName: 'definition-uri',
      basePath: baseDir || undefined,
      traversal
    });
    if (!local) return undefined;
    if (detectOpenApiContent(local.content)) {
      return {
        content: local.content,
        kind: 'openapi-local-ref',
        evidence: `Resolved local DefinitionUri ${local.relativePath}`
      };
    }
    return undefined;
  }

  const s3 = parseS3Location(value);
  if (s3) {
    if (!s3Client) {
      return { unresolved: `BodyS3Location ${s3.bucket}/${s3.key} (no S3 client)` };
    }
    try {
      const content = await s3Client.getObject(s3.bucket, s3.key, s3.version);
      if (detectOpenApiContent(content)) {
        return {
          content,
          kind: 'openapi-s3-ref',
          evidence: `Resolved exact BodyS3Location s3://${s3.bucket}/${s3.key}`
        };
      }
    } catch (error) {
      errors.push({
        code: 'unreadable',
        path: templateRelative,
        message: `Failed S3 getObject ${s3.bucket}/${s3.key}: ${error instanceof Error ? error.message : String(error)}`
      });
    }
    return undefined;
  }

  if (value && typeof value === 'object') {
    return { unresolved: describeUnresolved(value) };
  }
  return undefined;
}

function extractLiteralOutputs(template: ParsedTemplate & { Outputs?: Record<string, unknown> }): Array<{
  name: string;
  value: string;
  sensitive: boolean;
}> {
  const outputs = template.Outputs;
  if (!outputs || typeof outputs !== 'object') return [];
  const results: Array<{ name: string; value: string; sensitive: boolean }> = [];
  for (const name of Object.keys(outputs).sort()) {
    const entry = outputs[name];
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const value = record.Value;
    const sensitive = Boolean(record.NoEcho) || /secret|password|token|key/i.test(name);
    if (typeof value === 'string' && !isUnresolvedIntrinsic(value)) {
      results.push({ name, value, sensitive });
    } else if (isUnresolvedIntrinsic(value)) {
      results.push({ name, value: describeUnresolved(value), sensitive: true });
    }
  }
  return results;
}

function extractNestedTemplateRefs(
  resources: Record<string, TemplateResource>,
  templateRelative: string
): Array<{ logicalId: string; ref: string }> {
  const refs: Array<{ logicalId: string; ref: string }> = [];
  for (const logicalId of Object.keys(resources).sort()) {
    const resource = resources[logicalId];
    if (!resource) continue;
    if (resource.Type !== 'AWS::CloudFormation::Stack' && resource.Type !== 'AWS::Serverless::Application') {
      continue;
    }
    const props = resource.Properties ?? {};
    const templateUrl = props.TemplateURL ?? props.Location;
    if (typeof templateUrl === 'string' && !isUnresolvedIntrinsic(templateUrl) && !/^https?:\/\//i.test(templateUrl) && !templateUrl.startsWith('s3://')) {
      const base = dirnamePosix(templateRelative);
      const joined = base ? path.posix.join(base, templateUrl) : templateUrl;
      refs.push({ logicalId, ref: toPosix(joined) });
    } else if (isUnresolvedIntrinsic(templateUrl) || (typeof templateUrl === 'string' && (/^https?:\/\//i.test(templateUrl) || templateUrl.startsWith('s3://')))) {
      // remote / dynamic nested templates are intentionally unresolved
      refs.push({ logicalId, ref: `__unresolved__:${describeUnresolved(templateUrl)}` });
    }
  }
  return refs;
}

export async function resolveCloudFormationTemplate(
  repoRoot: string,
  templateRelative: string,
  budget: IacReadBudget,
  errors: IacResolutionError[],
  options: {
    s3Client?: S3SpecClient;
    sourceHints?: string[];
    visited?: Set<string>;
    forceSource?: IacSourceKind;
  } = {}
): Promise<IacSpecCandidate[]> {
  const visited = options.visited ?? new Set<string>();
  const relative = toPosix(templateRelative);
  if (visited.has(relative)) return [];
  visited.add(relative);

  const loaded = await readIacFile(repoRoot, relative, budget, errors, {
    fieldName: 'cfn-template',
    countAsReference: false
  });
  if (!loaded) return [];

  let template: ParsedTemplate & { Outputs?: Record<string, unknown> };
  try {
    template = parseCfnTemplateBody(loaded.content) as ParsedTemplate & { Outputs?: Record<string, unknown> };
  } catch (error) {
    errors.push({
      code: 'malformed',
      path: relative,
      message: `Failed to parse template: ${error instanceof Error ? error.message : String(error)}`
    });
    return [];
  }

  const artifactClass = await classifyIacArtifact(repoRoot, relative, options.sourceHints);
  const candidates: IacSpecCandidate[] = [];
  const resources = template.Resources ?? {};

  for (const logicalId of Object.keys(resources).sort()) {
    const resource = resources[logicalId];
    if (!resource) continue;
    const gatewayType = gatewayTypeFor(resource.Type);
    const source = options.forceSource ?? sourceKindFor(relative, resource.Type);

    if (gatewayType) {
      const inline = extractInlineEmbeddedSpec(resource);
      if (inline) {
        candidates.push({
          id: `${relative}#${logicalId}`,
          source,
          kind: 'openapi-inline',
          artifactClass,
          sourcePath: relative,
          logicalId,
          gatewayType,
          content: inline.content,
          format: inline.format,
          filename: inline.filename,
          evidence: [`Inline Body/DefinitionBody OpenAPI in ${relative}#${logicalId}`]
        });
        continue;
      }

      const props = resource.Properties ?? {};
      const ref = props.DefinitionUri ?? props.BodyS3Location;
      if (ref !== undefined) {
        const resolved = await resolveReferencedSpec(
          repoRoot,
          relative,
          ref,
          budget,
          errors,
          options.s3Client
        );
        if (resolved && 'unresolved' in resolved) {
          candidates.push({
            id: `${relative}#${logicalId}:unresolved`,
            source,
            kind: 'unresolved-evidence',
            artifactClass,
            sourcePath: relative,
            logicalId,
            gatewayType,
            evidence: [`Unresolved DefinitionUri/BodyS3Location in ${relative}#${logicalId}`],
            unresolvedExpression: resolved.unresolved
          });
        } else if (resolved) {
          const fmt = openApiFormatForContent(resolved.content);
          candidates.push({
            id: `${relative}#${logicalId}`,
            source,
            kind: resolved.kind,
            artifactClass,
            sourcePath: relative,
            logicalId,
            gatewayType,
            content: resolved.content,
            format: fmt.format,
            filename: fmt.filename,
            evidence: [resolved.evidence]
          });
        }
      }
    }
  }

  for (const output of extractLiteralOutputs(template)) {
    if (output.sensitive && !isExactApiGatewayId(output.value)) {
      candidates.push({
        id: `${relative}#Output:${output.name}:redacted`,
        source: options.forceSource ?? sourceKindFor(relative),
        kind: 'unresolved-evidence',
        artifactClass,
        sourcePath: relative,
        logicalId: output.name,
        evidence: [`Sensitive or non-literal output ${output.name} redacted from ${relative}`],
        unresolvedExpression: '[redacted]'
      });
      continue;
    }
    if (isExactApiGatewayId(output.value)) {
      candidates.push({
        id: `${relative}#Output:${output.name}`,
        source: options.forceSource ?? sourceKindFor(relative),
        kind: 'physical-api-id',
        artifactClass,
        sourcePath: relative,
        logicalId: output.name,
        physicalApiId: output.value,
        gatewayType: 'REST',
        evidence: [`Literal output ${output.name}=${output.value} in ${relative}`]
      });
    }
  }

  for (const nested of extractNestedTemplateRefs(resources, relative)) {
    if (nested.ref.startsWith('__unresolved__:')) {
      candidates.push({
        id: `${relative}#${nested.logicalId}:nested-unresolved`,
        source: options.forceSource ?? sourceKindFor(relative),
        kind: 'unresolved-evidence',
        artifactClass,
        sourcePath: relative,
        logicalId: nested.logicalId,
        evidence: [`Nested template reference unresolved in ${relative}#${nested.logicalId}`],
        unresolvedExpression: nested.ref.slice('__unresolved__:'.length)
      });
      continue;
    }
    const nestedCandidates = await resolveCloudFormationTemplate(
      repoRoot,
      nested.ref,
      budget,
      errors,
      { ...options, visited }
    );
    for (const candidate of nestedCandidates) {
      candidate.evidence = [
        ...candidate.evidence,
        `Via nested template ${nested.logicalId} from ${relative}`
      ];
      candidates.push(candidate);
    }
  }

  return candidates;
}

/** Discover conventional CFN/SAM template paths under the repo (bounded). */
export async function discoverCloudFormationTemplatePaths(
  repoRoot: string,
  budget: IacReadBudget,
  _errors: IacResolutionError[]
): Promise<string[]> {
  void _errors;
  void budget;
  const { readdir, lstat } = await import('node:fs/promises');
  const found = new Set<string>();
  const roots = ['.', 'infrastructure', 'infra', 'deploy', 'cloudformation', 'sam', 'templates'];

  for (const dir of roots) {
    const absolute = path.resolve(repoRoot, dir);
    let info;
    try {
      info = await lstat(absolute);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isFile()) {
      const base = path.basename(dir).toLowerCase();
      if (base === 'template.yaml' || base === 'template.yml' || base === 'template.json') {
        found.add(toPosix(dir));
      }
      continue;
    }
    if (!info.isDirectory()) continue;
    const entries = (await readdir(absolute).catch(() => [] as string[])).sort();
    for (const entry of entries) {
      const lower = entry.toLowerCase();
      if (
        lower === 'template.yaml'
        || lower === 'template.yml'
        || lower === 'template.json'
        || (lower.endsWith('.yaml') && lower.includes('template'))
        || (lower.endsWith('.yml') && lower.includes('template'))
      ) {
        const relative = dir === '.' ? entry : `${dir}/${entry}`;
        // Skip symlink candidates during discovery.
        try {
          const entryInfo = await lstat(path.resolve(repoRoot, relative));
          if (entryInfo.isSymbolicLink() || !entryInfo.isFile()) continue;
        } catch {
          continue;
        }
        found.add(toPosix(relative));
      }
    }
  }

  return [...found].sort((a, b) => a.localeCompare(b));
}

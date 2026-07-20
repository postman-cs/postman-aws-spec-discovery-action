import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { classifyIacArtifact } from './freshness.js';
import {
  describeUnresolved,
  detectOpenApiContent,
  isExactApiGatewayId,
  openApiFormatForContent
} from './openapi.js';
import { createIacTraversal, dirnamePosix, readIacFile, toPosix, type IacReadBudget } from './read.js';
import type { IacResolutionError, IacSpecCandidate } from './types.js';

const DYNAMIC_EXPR_RE = /\$\{|var\.|local\.|module\.|data\.|terraform\.|path\.|file\s*\(|templatefile\s*\(|jsonencode\s*\(/i;
const FILE_CALL_RE = /(?:body|filename|definition|openapi_spec|content)\s*=\s*file\(\s*["']([^"']+)["']\s*\)/gi;
const HEREDOC_BODY_RE = /(?:body|definition|content)\s*=\s*<<-?([A-Za-z_][A-Za-z0-9_]*)\n([\s\S]*?)\n\s*\1/gi;
const LITERAL_BODY_RE = /(?:body|definition|content)\s*=\s*["'](\{[\s\S]*?["']|openapi:[\s\S]*?["'])/i;
const LITERAL_API_ID_ATTR_RE = /\b(?:id|rest_api_id|api_id)\s*=\s*["']([a-z0-9]{10})["']/gi;
const OUTPUT_SENSITIVE_RE = /sensitive\s*=\s*true/i;
const RESOURCE_HEADER_RE = /resource\s+"(aws_api_gateway_rest_api|aws_apigatewayv2_api)"\s+"([^"]+)"\s*\{/gi;
const OUTPUT_HEADER_RE = /output\s+"([^"]+)"\s*\{/gi;

function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/#.*/g, '');
}

function isDynamicExpression(value: string): boolean {
  return DYNAMIC_EXPR_RE.test(value);
}

/**
 * Extract a brace-balanced HCL block body starting after the opening `{`.
 * Skips braces that appear inside heredoc regions so JSON OpenAPI bodies do not
 * prematurely terminate the surrounding resource/output block.
 */
function extractBalancedBlock(content: string, openBraceIndex: number): string | undefined {
  if (content[openBraceIndex] !== '{') return undefined;
  let depth = 0;
  let i = openBraceIndex;
  let heredocMarker: string | undefined;

  while (i < content.length) {
    const ch = content[i];

    if (heredocMarker) {
      if (ch === '\n') {
        const lineStart = i + 1;
        const lineEnd = content.indexOf('\n', lineStart);
        const line = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd).trim();
        if (line === heredocMarker) {
          heredocMarker = undefined;
          i = lineEnd === -1 ? content.length : lineEnd;
          continue;
        }
      }
      i += 1;
      continue;
    }

    if (ch === '<' && content.startsWith('<<', i)) {
      const markerMatch = /^<<-?([A-Za-z_][A-Za-z0-9_]*)/.exec(content.slice(i));
      if (markerMatch) {
        heredocMarker = markerMatch[1];
        i += markerMatch[0].length;
        continue;
      }
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < content.length) {
        if (content[i] === '\\') {
          i += 2;
          continue;
        }
        if (content[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return content.slice(openBraceIndex + 1, i);
      }
    }
    i += 1;
  }
  return undefined;
}

function* iterNamedBlocks(
  content: string,
  headerRe: RegExp
): Generator<{ match: RegExpExecArray; block: string }> {
  headerRe.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(content)) !== null) {
    const openBrace = content.indexOf('{', match.index + match[0].length - 1);
    if (openBrace < 0) continue;
    const block = extractBalancedBlock(content, openBrace);
    if (block === undefined) continue;
    yield { match, block };
    headerRe.lastIndex = openBrace + block.length + 2;
  }
}

async function resolveLocalFileRef(
  repoRoot: string,
  tfRelative: string,
  fileRef: string,
  budget: IacReadBudget,
  errors: IacResolutionError[]
): Promise<{ content: string; relativePath: string } | undefined> {
  if (isDynamicExpression(fileRef) || fileRef.includes('${')) {
    return undefined;
  }
  const base = dirnamePosix(tfRelative);
  const traversal = createIacTraversal();
  return readIacFile(repoRoot, fileRef, budget, errors, {
    fieldName: 'terraform-file-ref',
    basePath: base || undefined,
    traversal
  });
}

function redactSensitiveValue(name: string, value: string, sensitive: boolean): string | undefined {
  if (sensitive || /secret|password|token|private_key|api_key/i.test(name)) {
    return undefined;
  }
  return value;
}

async function resolveTfFile(
  repoRoot: string,
  relative: string,
  budget: IacReadBudget,
  errors: IacResolutionError[]
): Promise<IacSpecCandidate[]> {
  const loaded = await readIacFile(repoRoot, relative, budget, errors, {
    fieldName: 'terraform-source',
    countAsReference: false
  });
  if (!loaded) return [];

  const artifactClass = await classifyIacArtifact(repoRoot, loaded.relativePath);
  const content = stripComments(loaded.content);
  const candidates: IacSpecCandidate[] = [];

  for (const { match, block } of iterNamedBlocks(content, RESOURCE_HEADER_RE)) {
    const resourceType = match[1] ?? '';
    const logicalId = match[2] ?? '';
    const gatewayType = resourceType === 'aws_apigatewayv2_api' ? 'HTTP' : 'REST';

    for (const fileMatch of block.matchAll(FILE_CALL_RE)) {
      const fileRef = fileMatch[1] ?? '';
      if (!fileRef || isDynamicExpression(fileRef)) {
        candidates.push({
          id: `${loaded.relativePath}#${logicalId}:dynamic-file`,
          source: 'terraform',
          kind: 'unresolved-evidence',
          artifactClass,
          sourcePath: loaded.relativePath,
          logicalId,
          gatewayType,
          evidence: [`Dynamic Terraform file() expression in ${loaded.relativePath}#${logicalId}`],
          unresolvedExpression: fileMatch[0]
        });
        continue;
      }
      const local = await resolveLocalFileRef(repoRoot, loaded.relativePath, fileRef, budget, errors);
      if (!local) {
        candidates.push({
          id: `${loaded.relativePath}#${logicalId}:missing-file`,
          source: 'terraform',
          kind: 'unresolved-evidence',
          artifactClass,
          sourcePath: loaded.relativePath,
          logicalId,
          gatewayType,
          evidence: [`Missing Terraform file() target ${fileRef}`],
          unresolvedExpression: fileRef
        });
        continue;
      }
      if (detectOpenApiContent(local.content)) {
        const fmt = openApiFormatForContent(local.content);
        candidates.push({
          id: `${loaded.relativePath}#${logicalId}`,
          source: 'terraform',
          kind: 'openapi-local-ref',
          artifactClass,
          sourcePath: loaded.relativePath,
          logicalId,
          gatewayType,
          content: local.content,
          format: fmt.format,
          filename: fmt.filename,
          evidence: [`Terraform file() OpenAPI ${local.relativePath} from ${loaded.relativePath}#${logicalId}`]
        });
      }
    }

    for (const heredoc of block.matchAll(HEREDOC_BODY_RE)) {
      const body = heredoc[2] ?? '';
      if (isDynamicExpression(body)) {
        candidates.push({
          id: `${loaded.relativePath}#${logicalId}:dynamic-heredoc`,
          source: 'terraform',
          kind: 'unresolved-evidence',
          artifactClass,
          sourcePath: loaded.relativePath,
          logicalId,
          gatewayType,
          evidence: [`Dynamic expression inside Terraform heredoc body in ${loaded.relativePath}#${logicalId}`],
          unresolvedExpression: describeUnresolved(body.slice(0, 200))
        });
        continue;
      }
      if (detectOpenApiContent(body)) {
        const fmt = openApiFormatForContent(body);
        candidates.push({
          id: `${loaded.relativePath}#${logicalId}:heredoc`,
          source: 'terraform',
          kind: 'openapi-inline',
          artifactClass,
          sourcePath: loaded.relativePath,
          logicalId,
          gatewayType,
          content: body,
          format: fmt.format,
          filename: fmt.filename,
          evidence: [`Literal Terraform heredoc OpenAPI in ${loaded.relativePath}#${logicalId}`]
        });
      }
    }

    for (const idMatch of block.matchAll(LITERAL_API_ID_ATTR_RE)) {
      const apiId = idMatch[1] ?? '';
      if (isExactApiGatewayId(apiId)) {
        candidates.push({
          id: `${loaded.relativePath}#${logicalId}:id:${apiId}`,
          source: 'terraform',
          kind: 'physical-api-id',
          artifactClass,
          sourcePath: loaded.relativePath,
          logicalId,
          gatewayType,
          physicalApiId: apiId,
          evidence: [`Literal Terraform API ID ${apiId} in ${loaded.relativePath}#${logicalId}`]
        });
      }
    }

    const hasFileCall = [...block.matchAll(new RegExp(FILE_CALL_RE.source, 'gi'))].length > 0;
    const hasHeredoc = [...block.matchAll(new RegExp(HEREDOC_BODY_RE.source, 'gi'))].length > 0;
    if (/\bbody\s*=/.test(block) && !hasFileCall && !hasHeredoc) {
      const bodyLine = block.match(/\bbody\s*=\s*([^\n]+)/);
      const expr = bodyLine?.[1]?.trim() ?? '';
      if (expr && isDynamicExpression(expr) && !LITERAL_BODY_RE.test(block)) {
        candidates.push({
          id: `${loaded.relativePath}#${logicalId}:dynamic-body`,
          source: 'terraform',
          kind: 'unresolved-evidence',
          artifactClass,
          sourcePath: loaded.relativePath,
          logicalId,
          gatewayType,
          evidence: [`Unresolved dynamic Terraform body expression in ${loaded.relativePath}#${logicalId}`],
          unresolvedExpression: expr
        });
      }
    }
  }

  for (const { match, block } of iterNamedBlocks(content, OUTPUT_HEADER_RE)) {
    const name = match[1] ?? '';
    const sensitive = OUTPUT_SENSITIVE_RE.test(block);
    const valueMatch = /value\s*=\s*"([^"]+)"/.exec(block);
    if (!valueMatch) {
      if (/value\s*=/.test(block)) {
        const expr = block.match(/value\s*=\s*([^\n]+)/)?.[1]?.trim() ?? '';
        candidates.push({
          id: `${loaded.relativePath}#output:${name}:unresolved`,
          source: 'terraform',
          kind: 'unresolved-evidence',
          artifactClass,
          sourcePath: loaded.relativePath,
          logicalId: name,
          evidence: [`Non-literal Terraform output ${name} preserved as evidence`],
          unresolvedExpression: sensitive ? '[redacted]' : expr
        });
      }
      continue;
    }
    const rawValue = valueMatch[1] ?? '';
    const value = redactSensitiveValue(name, rawValue, sensitive);
    if (value === undefined) {
      candidates.push({
        id: `${loaded.relativePath}#output:${name}:redacted`,
        source: 'terraform',
        kind: 'unresolved-evidence',
        artifactClass,
        sourcePath: loaded.relativePath,
        logicalId: name,
        evidence: [`Sensitive Terraform output ${name} redacted`],
        unresolvedExpression: '[redacted]'
      });
      continue;
    }
    if (isExactApiGatewayId(value)) {
      candidates.push({
        id: `${loaded.relativePath}#output:${name}`,
        source: 'terraform',
        kind: 'physical-api-id',
        artifactClass,
        sourcePath: loaded.relativePath,
        logicalId: name,
        physicalApiId: value,
        gatewayType: 'REST',
        evidence: [`Literal Terraform output ${name}=${value}`]
      });
    }
  }

  return candidates;
}

async function resolveLocalStateArtifact(
  repoRoot: string,
  relative: string,
  budget: IacReadBudget,
  errors: IacResolutionError[]
): Promise<IacSpecCandidate[]> {
  const loaded = await readIacFile(repoRoot, relative, budget, errors, {
    fieldName: 'terraform-state',
    countAsReference: false
  });
  if (!loaded) return [];

  // Refuse remote backends / serialised credentials blobs.
  if (/"backend"\s*:\s*\{[^}]*"type"\s*:\s*"(s3|remote|http|azurerm|gcs)"/i.test(loaded.content)) {
    errors.push({
      code: 'unresolved-expression',
      path: loaded.relativePath,
      message: 'Remote Terraform backend detected; state download is not performed'
    });
    return [{
      id: `${loaded.relativePath}:remote-backend`,
      source: 'terraform',
      kind: 'unresolved-evidence',
      artifactClass: 'freshness-unknown',
      sourcePath: loaded.relativePath,
      evidence: ['Remote Terraform backend present; refusing automatic state download'],
      unresolvedExpression: 'remote-backend'
    }];
  }

  let parsed: {
    outputs?: Record<string, { value?: unknown; sensitive?: boolean }>;
    resources?: Array<{ type?: string; name?: string; instances?: Array<{ attributes?: Record<string, unknown> }> }>;
  };
  try {
    parsed = JSON.parse(loaded.content);
  } catch (error) {
    errors.push({
      code: 'malformed',
      path: loaded.relativePath,
      message: `Failed to parse local Terraform state: ${error instanceof Error ? error.message : String(error)}`
    });
    return [];
  }

  const artifactClass = await classifyIacArtifact(repoRoot, loaded.relativePath);
  const candidates: IacSpecCandidate[] = [];

  for (const [name, output] of Object.entries(parsed.outputs ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const sensitive = Boolean(output.sensitive) || /secret|password|token|key/i.test(name);
    const value = output.value;
    if (sensitive) {
      candidates.push({
        id: `${loaded.relativePath}#state-output:${name}:redacted`,
        source: 'terraform',
        kind: 'unresolved-evidence',
        artifactClass,
        sourcePath: loaded.relativePath,
        logicalId: name,
        evidence: [`Sensitive local state output ${name} redacted`],
        unresolvedExpression: '[redacted]'
      });
      continue;
    }
    if (typeof value === 'string' && isExactApiGatewayId(value)) {
      candidates.push({
        id: `${loaded.relativePath}#state-output:${name}`,
        source: 'terraform',
        kind: 'physical-api-id',
        artifactClass,
        sourcePath: loaded.relativePath,
        logicalId: name,
        physicalApiId: value,
        gatewayType: 'REST',
        evidence: [`Literal local Terraform state output ${name}=${value}`]
      });
    } else if (typeof value !== 'string' || isDynamicExpression(value)) {
      candidates.push({
        id: `${loaded.relativePath}#state-output:${name}:unresolved`,
        source: 'terraform',
        kind: 'unresolved-evidence',
        artifactClass,
        sourcePath: loaded.relativePath,
        logicalId: name,
        evidence: [`Non-literal local state output ${name}`],
        unresolvedExpression: typeof value === 'string' ? value : describeUnresolved(value)
      });
    }
  }

  for (const resource of parsed.resources ?? []) {
    if (resource.type !== 'aws_api_gateway_rest_api' && resource.type !== 'aws_apigatewayv2_api') {
      continue;
    }
    const gatewayType = resource.type === 'aws_apigatewayv2_api' ? 'HTTP' : 'REST';
    for (const instance of resource.instances ?? []) {
      const id = instance.attributes?.id;
      if (typeof id === 'string' && isExactApiGatewayId(id)) {
        candidates.push({
          id: `${loaded.relativePath}#state:${resource.name}:${id}`,
          source: 'terraform',
          kind: 'physical-api-id',
          artifactClass,
          sourcePath: loaded.relativePath,
          logicalId: resource.name,
          gatewayType,
          physicalApiId: id,
          evidence: [`Exact physical API ID ${id} from local Terraform state resource ${resource.name}`]
        });
      }
    }
  }

  return candidates;
}

async function collectTfPaths(repoRoot: string): Promise<string[]> {
  const found: string[] = [];
  const root = path.resolve(repoRoot);

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 4 || found.length >= 40) return;
    let entries: string[];
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) return;
      entries = (await readdir(current)).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === '.git' || entry === 'node_modules' || entry === '.terraform' || entry === 'cdk.out') {
        continue;
      }
      const full = path.join(current, entry);
      let info;
      try {
        info = await lstat(full);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      // Automatic scanning includes only authored Terraform sources; .tfstate is explicit-only.
      if (info.isFile() && (entry.endsWith('.tf') || entry.endsWith('.tf.json'))) {
        found.push(toPosix(path.relative(root, full)));
      }
    }
  }

  await walk(root, 0);
  return found.sort((a, b) => a.localeCompare(b));
}

/**
 * Parse safe literal Terraform/OpenTofu bodies, file() references, API IDs,
 * and explicitly listed local state artifacts. Never evaluates HCL or downloads remote state.
 * `.tfstate` is read only from `options.statePaths` (never auto-discovered).
 */
export async function resolveTerraformStatic(
  repoRoot: string,
  budget: IacReadBudget,
  errors: IacResolutionError[],
  options: { statePaths?: string[] } = {}
): Promise<IacSpecCandidate[]> {
  const paths = await collectTfPaths(repoRoot);
  const candidates: IacSpecCandidate[] = [];
  for (const relative of paths) {
    candidates.push(...await resolveTfFile(repoRoot, relative, budget, errors));
  }

  const explicitStatePaths = [
    ...new Set(
      (options.statePaths ?? [])
        .map((entry) => toPosix(entry.trim()))
        .filter((entry) => entry.length > 0 && (entry.endsWith('.tfstate') || entry.endsWith('terraform.tfstate')))
    )
  ].sort((a, b) => a.localeCompare(b));
  for (const relative of explicitStatePaths) {
    candidates.push(...await resolveLocalStateArtifact(repoRoot, relative, budget, errors));
  }
  return candidates;
}

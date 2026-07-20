import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

import {
  extractInlineEmbeddedSpec,
  parseCfnTemplateBody,
  type TemplateResource
} from '../providers/cloudformation.js';
import { resolveCloudFormationTemplate } from './cloudformation.js';
import { classifyIacArtifact } from './freshness.js';
import {
  detectOpenApiContent,
  isExactApiGatewayId,
  isUnresolvedIntrinsic,
  openApiFormatForContent,
  describeUnresolved
} from './openapi.js';
import { createIacTraversal, dirnamePosix, readIacFile, toPosix, type IacReadBudget } from './read.js';
import type { IacResolutionError, IacSpecCandidate } from './types.js';

const STATIC_CONFIG_NAMES = ['serverless.yml', 'serverless.yaml', 'serverless.json'];

function isJsTsConfig(filename: string): boolean {
  return /\.serverless\.(ts|js|mjs|cjs)$/i.test(filename)
    || /^serverless\.(ts|js|mjs|cjs)$/i.test(filename);
}

async function loadStaticServerlessConfig(
  repoRoot: string,
  budget: IacReadBudget,
  errors: IacResolutionError[]
): Promise<Array<{ relativePath: string; content: string; parsed: Record<string, unknown> }>> {
  const results: Array<{ relativePath: string; content: string; parsed: Record<string, unknown> }> = [];

  for (const name of STATIC_CONFIG_NAMES) {
    try {
      const info = await lstat(path.resolve(repoRoot, name));
      if (info.isSymbolicLink() || !info.isFile()) continue;
    } catch {
      continue;
    }
    const loaded = await readIacFile(repoRoot, name, budget, errors, {
      fieldName: 'serverless-config',
      countAsReference: false
    });
    if (!loaded) continue;
    try {
      const parsed = loaded.content.trim().startsWith('{')
        ? JSON.parse(loaded.content) as Record<string, unknown>
        : parse(loaded.content) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        results.push({ relativePath: loaded.relativePath, content: loaded.content, parsed });
      }
    } catch (error) {
      errors.push({
        code: 'malformed',
        path: loaded.relativePath,
        message: `Failed to parse Serverless config: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  return results;
}

async function extractFromServerlessResources(
  repoRoot: string,
  configRelative: string,
  parsed: Record<string, unknown>,
  budget: IacReadBudget,
  errors: IacResolutionError[]
): Promise<IacSpecCandidate[]> {
  const candidates: IacSpecCandidate[] = [];
  const artifactClass = await classifyIacArtifact(repoRoot, configRelative);
  const resources = (parsed.resources as { Resources?: Record<string, TemplateResource> } | undefined)?.Resources;
  if (!resources || typeof resources !== 'object') {
    // Also support top-level provider.apiGateway / custom openapi paths as local refs only.
    const custom = parsed.custom as Record<string, unknown> | undefined;
    const documentation = custom?.documentation ?? custom?.openapi ?? custom?.apiSpec;
    if (typeof documentation === 'string' && !isUnresolvedIntrinsic(documentation) && !documentation.includes('${')) {
      const base = dirnamePosix(configRelative);
      const traversal = createIacTraversal();
      const local = await readIacFile(repoRoot, documentation, budget, errors, {
        fieldName: 'serverless-openapi-ref',
        basePath: base || undefined,
        traversal
      });
      if (local && detectOpenApiContent(local.content)) {
        const fmt = openApiFormatForContent(local.content);
        candidates.push({
          id: `${configRelative}#custom-openapi`,
          source: 'serverless',
          kind: 'openapi-local-ref',
          artifactClass,
          sourcePath: configRelative,
          content: local.content,
          format: fmt.format,
          filename: fmt.filename,
          evidence: [`Serverless custom OpenAPI reference ${local.relativePath}`]
        });
      }
    } else if (documentation !== undefined && (typeof documentation !== 'string' || documentation.includes('${'))) {
      candidates.push({
        id: `${configRelative}#custom-openapi:unresolved`,
        source: 'serverless',
        kind: 'unresolved-evidence',
        artifactClass,
        sourcePath: configRelative,
        evidence: ['Dynamic Serverless custom OpenAPI reference left unresolved'],
        unresolvedExpression: describeUnresolved(documentation)
      });
    }
    return candidates;
  }

  // Reuse CFN extraction by serializing the Resources block into a synthetic template.
  const synthetic = JSON.stringify({ Resources: resources });
  let template;
  try {
    template = parseCfnTemplateBody(synthetic);
  } catch {
    return candidates;
  }

  for (const logicalId of Object.keys(template.Resources ?? {}).sort()) {
    const resource = template.Resources?.[logicalId];
    if (!resource) continue;
    const inline = extractInlineEmbeddedSpec(resource);
    if (inline) {
      candidates.push({
        id: `${configRelative}#${logicalId}`,
        source: 'serverless',
        kind: 'openapi-inline',
        artifactClass,
        sourcePath: configRelative,
        logicalId,
        content: inline.content,
        format: inline.format,
        filename: inline.filename,
        evidence: [`Inline OpenAPI in Serverless resources ${configRelative}#${logicalId}`]
      });
      continue;
    }
    const props = resource.Properties ?? {};
    const ref = props.DefinitionUri ?? props.BodyS3Location;
    if (typeof ref === 'string' && !ref.startsWith('s3://') && !/^https?:/i.test(ref) && !isUnresolvedIntrinsic(ref)) {
      const base = dirnamePosix(configRelative);
      const traversal = createIacTraversal();
      const local = await readIacFile(repoRoot, ref, budget, errors, {
        fieldName: 'serverless-definition-uri',
        basePath: base || undefined,
        traversal
      });
      if (local && detectOpenApiContent(local.content)) {
        const fmt = openApiFormatForContent(local.content);
        candidates.push({
          id: `${configRelative}#${logicalId}`,
          source: 'serverless',
          kind: 'openapi-local-ref',
          artifactClass,
          sourcePath: configRelative,
          logicalId,
          content: local.content,
          format: fmt.format,
          filename: fmt.filename,
          evidence: [`Serverless DefinitionUri ${local.relativePath}`]
        });
      }
    } else if (ref !== undefined && isUnresolvedIntrinsic(ref)) {
      candidates.push({
        id: `${configRelative}#${logicalId}:unresolved`,
        source: 'serverless',
        kind: 'unresolved-evidence',
        artifactClass,
        sourcePath: configRelative,
        logicalId,
        evidence: [`Unresolved Serverless DefinitionUri in ${configRelative}#${logicalId}`],
        unresolvedExpression: describeUnresolved(ref)
      });
    }
  }

  return candidates;
}

async function resolvePackageArtifacts(
  repoRoot: string,
  budget: IacReadBudget,
  errors: IacResolutionError[]
): Promise<IacSpecCandidate[]> {
  const packageDir = path.resolve(repoRoot, '.serverless');
  try {
    const info = await lstat(packageDir);
    if (info.isSymbolicLink() || !info.isDirectory()) return [];
  } catch {
    return [];
  }

  const candidates: IacSpecCandidate[] = [];
  const entries = (await readdir(packageDir).catch(() => [] as string[])).sort();
  for (const entry of entries) {
    if (isJsTsConfig(entry)) continue;
    const relative = toPosix(path.posix.join('.serverless', entry));
    if (entry.endsWith('.json') || entry.endsWith('.yml') || entry.endsWith('.yaml') || entry.endsWith('.template')) {
      // cloudformation-template-update-stack.json etc.
      if (/cloudformation|template/i.test(entry)) {
        const stackCandidates = await resolveCloudFormationTemplate(
          repoRoot,
          relative,
          budget,
          errors,
          { forceSource: 'serverless', sourceHints: STATIC_CONFIG_NAMES }
        );
        for (const candidate of stackCandidates) {
          candidate.evidence = [
            ...candidate.evidence,
            `From existing Serverless package artifact ${relative}`
          ];
          candidates.push(candidate);
        }
      }
    }
  }
  return candidates;
}

function extractDeployedOutputIds(
  deployedStackOutputs: Record<string, Record<string, string>> | undefined,
  configRelative: string
): IacSpecCandidate[] {
  if (!deployedStackOutputs) return [];
  const candidates: IacSpecCandidate[] = [];
  for (const [stackName, outputs] of Object.entries(deployedStackOutputs).sort(([a], [b]) => a.localeCompare(b))) {
    for (const [name, value] of Object.entries(outputs).sort(([a], [b]) => a.localeCompare(b))) {
      if (/secret|password|token|key/i.test(name)) {
        candidates.push({
          id: `deployed:${stackName}:${name}:redacted`,
          source: 'serverless',
          kind: 'unresolved-evidence',
          artifactClass: 'freshness-unknown',
          sourcePath: configRelative,
          logicalId: name,
          evidence: [`Sensitive deployed CFN output ${stackName}.${name} redacted`],
          unresolvedExpression: '[redacted]'
        });
        continue;
      }
      if (isExactApiGatewayId(value)) {
        candidates.push({
          id: `deployed:${stackName}:${name}`,
          source: 'serverless',
          kind: 'physical-api-id',
          artifactClass: 'freshness-unknown',
          sourcePath: configRelative,
          logicalId: name,
          physicalApiId: value,
          gatewayType: 'REST',
          evidence: [`Deployed CloudFormation output ${stackName}.${name}=${value} correlated with Serverless`]
        });
      }
    }
  }
  return candidates;
}

/**
 * Inspect static Serverless YAML/JSON plus existing package artifacts and
 * optionally injected deployed CFN outputs. Never loads plugins or executes JS/TS.
 */
export async function resolveServerlessStatic(
  repoRoot: string,
  budget: IacReadBudget,
  errors: IacResolutionError[],
  options: {
    deployedStackOutputs?: Record<string, Record<string, string>>;
  } = {}
): Promise<IacSpecCandidate[]> {
  // Record refusal for JS/TS configs without executing them.
  for (const name of ['serverless.ts', 'serverless.js', 'serverless.mjs', 'serverless.cjs']) {
    try {
      const info = await lstat(path.resolve(repoRoot, name));
      if (info.isFile() && !info.isSymbolicLink()) {
        errors.push({
          code: 'unresolved-expression',
          path: name,
          message: 'Refusing to load or execute Serverless JavaScript/TypeScript configuration'
        });
      }
    } catch {
      // absent
    }
  }

  const configs = await loadStaticServerlessConfig(repoRoot, budget, errors);
  const candidates: IacSpecCandidate[] = [];

  for (const config of configs) {
    candidates.push(
      ...await extractFromServerlessResources(
        repoRoot,
        config.relativePath,
        config.parsed,
        budget,
        errors
      )
    );
    candidates.push(
      ...extractDeployedOutputIds(options.deployedStackOutputs, config.relativePath)
    );
  }

  // Package artifacts are useful even without a static config present.
  candidates.push(...await resolvePackageArtifacts(repoRoot, budget, errors));

  // If only deployed outputs were supplied and no config, still surface IDs.
  if (configs.length === 0 && options.deployedStackOutputs) {
    candidates.push(...extractDeployedOutputIds(options.deployedStackOutputs, 'serverless.yml'));
  }

  return candidates;
}

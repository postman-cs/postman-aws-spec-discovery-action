import { parse } from 'yaml';

import type { CloudFormationSpecClient } from '../aws/cloudformation-client.js';
import type { ExportOptions, SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

interface TemplateResource {
  Type: string;
  Properties?: Record<string, unknown>;
}

interface ParsedTemplate {
  Resources?: Record<string, TemplateResource>;
}

const CFN_CUSTOM_TAGS = [
  '!Ref', '!Sub', '!GetAtt', '!Join', '!Select', '!Split',
  '!If', '!Equals', '!Not', '!And', '!Or', '!FindInMap',
  '!Base64', '!Cidr', '!ImportValue', '!GetAZs', '!Transform',
  '!Condition'
].map((tag) => ({ tag, identify: () => false, resolve: (_v: unknown) => _v }));

function extractEmbeddedSpec(resource: TemplateResource): string | undefined {
  const props = resource.Properties;
  if (!props) return undefined;

  // SAM resources use DefinitionBody, CloudFormation uses Body
  const body = props.DefinitionBody ?? props.Body;
  if (!body || typeof body !== 'object') return undefined;

  const doc = body as Record<string, unknown>;
  if (doc.openapi || doc.swagger) {
    // It's an inline OpenAPI/Swagger spec -- serialize it back
    return JSON.stringify(body, null, 2);
  }

  return undefined;
}

export class CloudFormationProvider implements SpecProvider {
  public readonly type = 'cloudformation' as const;

  public constructor(private readonly client: CloudFormationSpecClient) {}

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

    const spec = extractEmbeddedSpec(resource);
    if (!spec) {
      throw new Error(`No embedded OpenAPI spec found in ${candidate.meta.resourceType} resource ${logicalId} of stack ${stackName}`);
    }

    return {
      content: spec,
      format: 'openapi-json',
      filename: 'index.json',
      evidence: [`Extracted embedded spec from ${candidate.meta.resourceType} in CloudFormation stack ${stackName}`]
    };
  }
}

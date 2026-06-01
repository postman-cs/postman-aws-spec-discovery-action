import { parse as parseYaml } from 'yaml';

import type { BedrockActionGroupDetail, BedrockActionGroupsSpecClient } from '../aws/bedrock-agent-client.js';
import type { S3SpecClient } from '../aws/s3-client.js';
import type { ExportOptions, SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

export class BedrockActionGroupProvider implements SpecProvider {
  public readonly type = 'bedrock-action-group' as const;

  public constructor(
    private readonly client: BedrockActionGroupsSpecClient,
    private readonly s3?: S3SpecClient
  ) {}

  public async probe(): Promise<boolean> {
    return this.client.probe();
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const candidates: SpecCandidate[] = [];
    for (const agent of await this.client.listAgents()) {
      const version = agent.latestAgentVersion || 'DRAFT';
      const groups = await this.client.listActionGroups(agent.agentId, version);
      for (const group of groups) {
        candidates.push({
          id: `${group.agentId}/${group.agentVersion}/${group.actionGroupId}`,
          name: group.actionGroupName,
          providerType: 'bedrock-action-group',
          tags: {},
          evidence: [`Bedrock Agent action group discovered: ${group.actionGroupName}`],
          meta: {
            agentId: group.agentId,
            agentVersion: group.agentVersion,
            actionGroupId: group.actionGroupId,
            actionGroupState: group.actionGroupState ?? '',
            agentName: agent.agentName
          }
        });
      }
    }
    return candidates;
  }

  public async exportSpec(candidate: SpecCandidate, _options?: ExportOptions): Promise<SpecExportResult> {
    void _options;
    const detail = await this.client.getActionGroup(
      candidate.meta.agentId,
      candidate.meta.agentVersion || 'DRAFT',
      candidate.meta.actionGroupId
    );
    const schema = await this.readSchema(detail);
    const document = normalizeOpenApi(schema, detail);

    return {
      content: `${JSON.stringify(document, null, 2)}\n`,
      format: 'openapi-json',
      filename: 'index.json',
      derivedOpenApiCompleteness: 'partial',
      evidence: [`Exported Bedrock Agent action group OpenAPI schema for ${detail.actionGroupName}`]
    };
  }

  private async readSchema(detail: BedrockActionGroupDetail): Promise<string> {
    if (detail.apiSchema?.payload) {
      return detail.apiSchema.payload;
    }
    const s3 = detail.apiSchema?.s3;
    if (s3?.s3BucketName && s3.s3ObjectKey && this.s3) {
      return await this.s3.getObject(s3.s3BucketName, s3.s3ObjectKey);
    }
    return JSON.stringify({
      openapi: '3.0.3',
      info: { title: detail.actionGroupName, version: '1.0.0' },
      paths: {}
    });
  }
}

function normalizeOpenApi(content: string, detail: BedrockActionGroupDetail): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = content.trim().startsWith('{') ? JSON.parse(content) : parseYaml(content);
  } catch {
    parsed = {};
  }
  const document = parsed && typeof parsed === 'object' ? parsed : {};
  if (!document.openapi) {
    document.openapi = '3.0.3';
  }
  if (!document.info || typeof document.info !== 'object') {
    document.info = { title: detail.actionGroupName, version: '1.0.0' };
  }
  if (!document.paths || typeof document.paths !== 'object') {
    document.paths = {};
  }
  document['x-aws-bedrock-agent-action-group'] = {
    agentId: detail.agentId,
    agentVersion: detail.agentVersion,
    actionGroupId: detail.actionGroupId,
    actionGroupName: detail.actionGroupName,
    actionGroupState: detail.actionGroupState,
    executorLambdaArn: detail.executorLambdaArn
  };
  return document;
}

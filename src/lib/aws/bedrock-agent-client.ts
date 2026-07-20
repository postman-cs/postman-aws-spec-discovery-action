import {
  BedrockAgentClient,
  GetAgentActionGroupCommand,
  ListAgentActionGroupsCommand,
  ListAgentsCommand,
  type AgentActionGroup,
  type AgentSummary
} from '@aws-sdk/client-bedrock-agent';
import { NodeHttpHandler } from '@smithy/node-http-handler';

import { createAwsPaginationGuard } from './pagination.js';

export interface BedrockAgentSummary {
  agentId: string;
  agentName: string;
  latestAgentVersion?: string;
}

export interface BedrockActionGroupSummary {
  agentId: string;
  agentVersion: string;
  actionGroupId: string;
  actionGroupName: string;
  description?: string;
  actionGroupState?: string;
}

export interface BedrockActionGroupSchema {
  payload?: string;
  s3?: {
    s3BucketName?: string;
    s3ObjectKey?: string;
  };
}

export interface BedrockActionGroupDetail extends BedrockActionGroupSummary {
  apiSchema?: BedrockActionGroupSchema;
  executorLambdaArn?: string;
}

export interface BedrockActionGroupsSpecClient {
  listAgents(): Promise<BedrockAgentSummary[]>;
  listActionGroups(agentId: string, agentVersion: string): Promise<BedrockActionGroupSummary[]>;
  getActionGroup(agentId: string, agentVersion: string, actionGroupId: string): Promise<BedrockActionGroupDetail>;
  probe(): Promise<boolean>;
}

export class BedrockActionGroupsSdkClient implements BedrockActionGroupsSpecClient {
  private readonly client: BedrockAgentClient;

  public constructor(region: string, options: { requestTimeoutMs?: number; maxAttempts?: number } = {}) {
    const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.client = new BedrockAgentClient({
      region,
      maxAttempts: options.maxAttempts ?? 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: requestTimeoutMs,
        socketTimeout: requestTimeoutMs
      })
    });
  }

  public async listAgents(): Promise<BedrockAgentSummary[]> {
    const agents: BedrockAgentSummary[] = [];
    const guard = createAwsPaginationGuard('Bedrock ListAgents');
    let nextToken: string | undefined;
    do {
      guard.beginPage();
      const response = await this.client.send(new ListAgentsCommand({ nextToken, maxResults: 100 }));
      for (const agent of response.agentSummaries ?? []) {
        const mapped = mapAgent(agent);
        if (mapped) agents.push(mapped);
      }
      nextToken = guard.takeNextToken(response.nextToken);
    } while (nextToken);
    return agents;
  }

  public async listActionGroups(agentId: string, agentVersion: string): Promise<BedrockActionGroupSummary[]> {
    const groups: BedrockActionGroupSummary[] = [];
    const guard = createAwsPaginationGuard('Bedrock ListAgentActionGroups');
    let nextToken: string | undefined;
    do {
      guard.beginPage();
      const response = await this.client.send(
        new ListAgentActionGroupsCommand({
          agentId,
          agentVersion,
          nextToken,
          maxResults: 100
        })
      );
      for (const group of response.actionGroupSummaries ?? []) {
        if (!group.actionGroupId || !group.actionGroupName) continue;
        groups.push({
          agentId,
          agentVersion,
          actionGroupId: group.actionGroupId,
          actionGroupName: group.actionGroupName,
          description: group.description,
          actionGroupState: group.actionGroupState
        });
      }
      nextToken = guard.takeNextToken(response.nextToken);
    } while (nextToken);
    return groups;
  }

  public async getActionGroup(agentId: string, agentVersion: string, actionGroupId: string): Promise<BedrockActionGroupDetail> {
    const response = await this.client.send(new GetAgentActionGroupCommand({ agentId, agentVersion, actionGroupId }));
    return mapActionGroup(response.agentActionGroup, { agentId, agentVersion, actionGroupId });
  }

  public async probe(): Promise<boolean> {
    try {
      await this.client.send(new ListAgentsCommand({ maxResults: 1 }));
      return true;
    } catch {
      return false;
    }
  }
}

function mapAgent(agent: AgentSummary): BedrockAgentSummary | undefined {
  if (!agent.agentId || !agent.agentName) return undefined;
  return {
    agentId: agent.agentId,
    agentName: agent.agentName,
    latestAgentVersion: agent.latestAgentVersion
  };
}

function mapActionGroup(
  group: AgentActionGroup | undefined,
  fallback: { agentId: string; agentVersion: string; actionGroupId: string }
): BedrockActionGroupDetail {
  return {
    agentId: group?.agentId ?? fallback.agentId,
    agentVersion: group?.agentVersion ?? fallback.agentVersion,
    actionGroupId: group?.actionGroupId ?? fallback.actionGroupId,
    actionGroupName: group?.actionGroupName ?? fallback.actionGroupId,
    description: group?.description,
    actionGroupState: group?.actionGroupState,
    apiSchema: group?.apiSchema
      ? {
          payload: group.apiSchema.payload,
          s3: group.apiSchema.s3
            ? {
                s3BucketName: group.apiSchema.s3.s3BucketName,
                s3ObjectKey: group.apiSchema.s3.s3ObjectKey
              }
            : undefined
        }
      : undefined,
    executorLambdaArn: group?.actionGroupExecutor?.lambda
  };
}

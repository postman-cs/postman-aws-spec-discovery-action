import {
  CloudFormationClient,
  ListStacksCommand,
  ListStackResourcesCommand,
  GetTemplateCommand,
  DescribeStacksCommand
} from '@aws-sdk/client-cloudformation';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export interface CfnStackSummary {
  name: string;
  id: string;
  status: string;
}

export interface CfnResourceSummary {
  logicalId: string;
  physicalId: string;
  type: string;
}

export interface CloudFormationSpecClient {
  listActiveStacks(): Promise<CfnStackSummary[]>;
  listApiResources(stackName: string): Promise<CfnResourceSummary[]>;
  getTemplate(stackName: string): Promise<string>;
  getStackTags(stackName: string): Promise<Record<string, string>>;
  probe(): Promise<boolean>;
}

const API_RESOURCE_TYPES = new Set([
  'AWS::ApiGateway::RestApi',
  'AWS::ApiGatewayV2::Api',
  'AWS::Serverless::Api',
  'AWS::Serverless::HttpApi',
  'AWS::AppSync::GraphQLApi'
]);

export class CloudFormationSdkClient implements CloudFormationSpecClient {
  private readonly client: CloudFormationClient;

  public constructor(region: string, options: { requestTimeoutMs?: number; maxAttempts?: number } = {}) {
    const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.client = new CloudFormationClient({
      region,
      maxAttempts: options.maxAttempts ?? 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: requestTimeoutMs,
        socketTimeout: requestTimeoutMs
      })
    });
  }

  public async listActiveStacks(): Promise<CfnStackSummary[]> {
    const items: CfnStackSummary[] = [];
    let nextToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListStacksCommand({
          StackStatusFilter: ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'],
          NextToken: nextToken
        })
      );
      for (const stack of response.StackSummaries ?? []) {
        if (!stack.StackName) continue;
        items.push({
          name: stack.StackName,
          id: stack.StackId ?? stack.StackName,
          status: stack.StackStatus ?? ''
        });
      }
      nextToken = response.NextToken;
    } while (nextToken);
    return items;
  }

  public async listApiResources(stackName: string): Promise<CfnResourceSummary[]> {
    const items: CfnResourceSummary[] = [];
    let nextToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListStackResourcesCommand({ StackName: stackName, NextToken: nextToken })
      );
      for (const resource of response.StackResourceSummaries ?? []) {
        if (!resource.ResourceType || !API_RESOURCE_TYPES.has(resource.ResourceType)) continue;
        items.push({
          logicalId: resource.LogicalResourceId ?? '',
          physicalId: resource.PhysicalResourceId ?? '',
          type: resource.ResourceType
        });
      }
      nextToken = response.NextToken;
    } while (nextToken);
    return items;
  }

  public async getTemplate(stackName: string): Promise<string> {
    const response = await this.client.send(
      new GetTemplateCommand({ StackName: stackName, TemplateStage: 'Processed' })
    );
    return response.TemplateBody ?? '';
  }

  public async getStackTags(stackName: string): Promise<Record<string, string>> {
    const response = await this.client.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = response.Stacks?.[0];
    if (!stack) return {};
    const tags: Record<string, string> = {};
    for (const tag of stack.Tags ?? []) {
      if (tag.Key) tags[tag.Key] = tag.Value ?? '';
    }
    return tags;
  }

  public async probe(): Promise<boolean> {
    try {
      await this.client.send(new ListStacksCommand({ StackStatusFilter: ['CREATE_COMPLETE'] }));
      return true;
    } catch {
      return false;
    }
  }
}

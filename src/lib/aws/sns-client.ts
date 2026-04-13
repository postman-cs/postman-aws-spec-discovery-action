import {
  SNSClient,
  GetSubscriptionAttributesCommand,
  GetTopicAttributesCommand,
  ListSubscriptionsByTopicCommand,
  ListTagsForResourceCommand,
  ListTopicsCommand
} from '@aws-sdk/client-sns';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export interface SnsTopicSummary {
  topicArn: string;
  name: string;
}

export interface SnsSpecClient {
  probe(): Promise<boolean>;
  listTopics(): Promise<SnsTopicSummary[]>;
  getTopicAttributes(topicArn: string): Promise<Record<string, string>>;
  listTagsForResource(topicArn: string): Promise<Record<string, string>>;
  listSubscriptionsByTopic(topicArn: string): Promise<SnsSubscriptionSummary[]>;
  getSubscriptionAttributes(subscriptionArn: string): Promise<Record<string, string>>;
}

export interface SnsSubscriptionSummary {
  subscriptionArn: string;
  protocol?: string;
  endpoint?: string;
  topicArn?: string;
  owner?: string;
}

function topicNameFromArn(topicArn: string): string {
  const lastColonIndex = topicArn.lastIndexOf(':');
  return lastColonIndex >= 0 ? topicArn.slice(lastColonIndex + 1) : topicArn;
}

export class SnsSdkClient implements SnsSpecClient {
  private readonly client: SNSClient;

  public constructor(region: string, options: { requestTimeoutMs?: number; maxAttempts?: number } = {}) {
    const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.client = new SNSClient({
      region,
      maxAttempts: options.maxAttempts ?? 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: requestTimeoutMs,
        socketTimeout: requestTimeoutMs
      })
    });
  }

  public async probe(): Promise<boolean> {
    try {
      await this.client.send(new ListTopicsCommand({}));
      return true;
    } catch {
      return false;
    }
  }

  public async listTopics(): Promise<SnsTopicSummary[]> {
    const topics: SnsTopicSummary[] = [];
    let nextToken: string | undefined;
    do {
      const response = await this.client.send(new ListTopicsCommand({ NextToken: nextToken }));
      for (const topic of response.Topics ?? []) {
        const topicArn = topic.TopicArn;
        if (!topicArn) continue;
        topics.push({
          topicArn,
          name: topicNameFromArn(topicArn)
        });
      }
      nextToken = response.NextToken;
    } while (nextToken);
    return topics;
  }

  public async getTopicAttributes(topicArn: string): Promise<Record<string, string>> {
    const response = await this.client.send(new GetTopicAttributesCommand({ TopicArn: topicArn }));
    return response.Attributes ?? {};
  }

  public async listTagsForResource(topicArn: string): Promise<Record<string, string>> {
    const response = await this.client.send(new ListTagsForResourceCommand({ ResourceArn: topicArn }));
    const tags: Record<string, string> = {};
    for (const tag of response.Tags ?? []) {
      if (!tag.Key || typeof tag.Value !== 'string') continue;
      tags[tag.Key] = tag.Value;
    }
    return tags;
  }

  public async listSubscriptionsByTopic(topicArn: string): Promise<SnsSubscriptionSummary[]> {
    const subscriptions: SnsSubscriptionSummary[] = [];
    let nextToken: string | undefined;
    try {
      do {
        const response = await this.client.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn, NextToken: nextToken }));
        for (const subscription of response.Subscriptions ?? []) {
          const subscriptionArn = subscription.SubscriptionArn;
          if (!subscriptionArn) continue;
          subscriptions.push({
            subscriptionArn,
            protocol: subscription.Protocol,
            endpoint: subscription.Endpoint,
            topicArn: subscription.TopicArn,
            owner: subscription.Owner
          });
        }
        nextToken = response.NextToken;
      } while (nextToken);
      return subscriptions;
    } catch (error) {
      if (error instanceof Error && error.message.includes('AccessDeniedException')) {
        return [];
      }
      throw error;
    }
  }

  public async getSubscriptionAttributes(subscriptionArn: string): Promise<Record<string, string>> {
    try {
      const response = await this.client.send(new GetSubscriptionAttributesCommand({ SubscriptionArn: subscriptionArn }));
      return response.Attributes ?? {};
    } catch (error) {
      if (error instanceof Error && error.message.includes('AccessDeniedException')) {
        return {};
      }
      throw error;
    }
  }
}

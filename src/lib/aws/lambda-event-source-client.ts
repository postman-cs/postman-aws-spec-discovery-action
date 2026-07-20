import {
  GetEventSourceMappingCommand,
  LambdaClient,
  ListEventSourceMappingsCommand,
  type EventSourceMappingConfiguration
} from '@aws-sdk/client-lambda';
import { NodeHttpHandler } from '@smithy/node-http-handler';

import { createAwsPaginationGuard } from './pagination.js';

export interface LambdaEventSourceFilterCriteria {
  filters?: Array<{ pattern?: string }>;
}

export interface LambdaEventSourceMappingSummary {
  uuid: string;
  eventSourceArn?: string;
  functionArn?: string;
  state?: string;
  batchSize?: number;
  maximumBatchingWindowInSeconds?: number;
  filterCriteria?: LambdaEventSourceFilterCriteria;
  topics?: string[];
  queues?: string[];
}

export interface LambdaEventSourceSpecClient {
  listEventSourceMappings(): Promise<LambdaEventSourceMappingSummary[]>;
  getEventSourceMapping(uuid: string): Promise<LambdaEventSourceMappingSummary>;
  probe(): Promise<boolean>;
}

export class LambdaEventSourceSdkClient implements LambdaEventSourceSpecClient {
  private readonly client: LambdaClient;

  public constructor(region: string, options: { requestTimeoutMs?: number; maxAttempts?: number } = {}) {
    const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.client = new LambdaClient({
      region,
      maxAttempts: options.maxAttempts ?? 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: requestTimeoutMs,
        socketTimeout: requestTimeoutMs
      })
    });
  }

  public async listEventSourceMappings(): Promise<LambdaEventSourceMappingSummary[]> {
    const mappings: LambdaEventSourceMappingSummary[] = [];
    const guard = createAwsPaginationGuard('Lambda ListEventSourceMappings');
    let marker: string | undefined;
    do {
      guard.beginPage();
      const response = await this.client.send(new ListEventSourceMappingsCommand({ Marker: marker, MaxItems: 100 }));
      for (const mapping of response.EventSourceMappings ?? []) {
        const mapped = mapMapping(mapping);
        if (mapped) mappings.push(mapped);
      }
      marker = guard.takeNextToken(response.NextMarker);
    } while (marker);
    return mappings;
  }

  public async getEventSourceMapping(uuid: string): Promise<LambdaEventSourceMappingSummary> {
    const response = await this.client.send(new GetEventSourceMappingCommand({ UUID: uuid }));
    const mapped = mapMapping(response);
    return mapped ?? { uuid };
  }

  public async probe(): Promise<boolean> {
    try {
      await this.client.send(new ListEventSourceMappingsCommand({ MaxItems: 1 }));
      return true;
    } catch {
      return false;
    }
  }
}

function mapMapping(mapping: EventSourceMappingConfiguration): LambdaEventSourceMappingSummary | undefined {
  if (!mapping.UUID) return undefined;
  return {
    uuid: mapping.UUID,
    eventSourceArn: mapping.EventSourceArn,
    functionArn: mapping.FunctionArn,
    state: mapping.State,
    batchSize: mapping.BatchSize,
    maximumBatchingWindowInSeconds: mapping.MaximumBatchingWindowInSeconds,
    filterCriteria: mapping.FilterCriteria
      ? {
          filters: mapping.FilterCriteria.Filters?.map((filter) => ({ pattern: filter.Pattern }))
        }
      : undefined,
    topics: mapping.Topics,
    queues: mapping.Queues
  };
}

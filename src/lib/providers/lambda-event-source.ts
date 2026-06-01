import type { LambdaEventSourceMappingSummary, LambdaEventSourceSpecClient } from '../aws/lambda-event-source-client.js';
import type { ExportOptions, SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

export class LambdaEventSourceProvider implements SpecProvider {
  public readonly type = 'lambda-event-source' as const;

  public constructor(private readonly client: LambdaEventSourceSpecClient) {}

  public async probe(): Promise<boolean> {
    return this.client.probe();
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    return (await this.client.listEventSourceMappings()).map((mapping) => ({
      id: mapping.uuid,
      name: `lambda-event-source-${mapping.uuid}`,
      providerType: 'lambda-event-source',
      tags: {},
      evidence: [`Lambda event source mapping discovered: ${mapping.uuid}`],
      meta: mappingToMeta(mapping)
    }));
  }

  public async exportSpec(candidate: SpecCandidate, _options?: ExportOptions): Promise<SpecExportResult> {
    void _options;
    const detail = await this.client.getEventSourceMapping(candidate.id).catch(() => metaToMapping(candidate.meta));
    const document = {
      openapi: '3.1.0',
      info: {
        title: candidate.name,
        version: '1.0.0',
        description: 'Partial Lambda event source mapping surface derived from mapping filters and source metadata.'
      },
      paths: {},
      webhooks: {
        [`lambda-event-source.${detail.uuid}`]: {
          post: {
            operationId: `processLambdaEventSource${safeId(detail.uuid)}`,
            summary: `Lambda event source mapping ${detail.uuid}`,
            'x-aws-lambda-event-source-mapping': {
              uuid: detail.uuid,
              eventSourceArn: detail.eventSourceArn,
              functionArn: detail.functionArn,
              state: detail.state,
              batchSize: detail.batchSize,
              maximumBatchingWindowInSeconds: detail.maximumBatchingWindowInSeconds,
              topics: detail.topics,
              queues: detail.queues
            },
            ...(detail.filterCriteria ? { 'x-aws-lambda-filter-criteria': detail.filterCriteria } : {}),
            requestBody: {
              required: false,
              content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } }
            },
            responses: { '202': { description: 'Event batch accepted by Lambda mapping' } }
          }
        }
      }
    };
    return {
      content: `${JSON.stringify(document, null, 2)}\n`,
      format: 'openapi-json',
      filename: 'index.json',
      derivedOpenApiCompleteness: 'partial',
      evidence: [`Synthesized partial OpenAPI webhook for Lambda event source mapping ${detail.uuid}`]
    };
  }
}

function mappingToMeta(mapping: LambdaEventSourceMappingSummary): Record<string, string> {
  return {
    uuid: mapping.uuid,
    eventSourceArn: mapping.eventSourceArn ?? '',
    functionArn: mapping.functionArn ?? '',
    state: mapping.state ?? '',
    batchSize: mapping.batchSize?.toString() ?? '',
    maximumBatchingWindowInSeconds: mapping.maximumBatchingWindowInSeconds?.toString() ?? '',
    filterCriteriaJson: JSON.stringify(mapping.filterCriteria ?? {}),
    topicsJson: JSON.stringify(mapping.topics ?? []),
    queuesJson: JSON.stringify(mapping.queues ?? [])
  };
}

function metaToMapping(meta: Record<string, string>): LambdaEventSourceMappingSummary {
  return {
    uuid: meta.uuid,
    eventSourceArn: meta.eventSourceArn || undefined,
    functionArn: meta.functionArn || undefined,
    state: meta.state || undefined,
    batchSize: numberOrUndefined(meta.batchSize),
    maximumBatchingWindowInSeconds: numberOrUndefined(meta.maximumBatchingWindowInSeconds),
    filterCriteria: parseObject(meta.filterCriteriaJson),
    topics: parseArray(meta.topicsJson),
    queues: parseArray(meta.queuesJson)
  };
}

function parseObject(raw: string | undefined): LambdaEventSourceMappingSummary['filterCriteria'] {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseArray(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function numberOrUndefined(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '');
}

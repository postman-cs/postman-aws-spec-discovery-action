import type { EventBridgePipeDetail, EventBridgeSurfaceSpecClient, EventBridgeTargetSummary } from '../aws/eventbridge-client.js';
import type { ExportOptions, SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

type EventBridgeSurfaceKind = 'rule' | 'pipe' | 'api-destination';

export class EventBridgeSurfaceProvider implements SpecProvider {
  public readonly type = 'eventbridge' as const;

  public constructor(private readonly client: EventBridgeSurfaceSpecClient) {}

  public async probe(): Promise<boolean> {
    return this.client.probe();
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const candidates: SpecCandidate[] = [];

    for (const rule of await this.client.listRules()) {
      const targets = await this.client.listTargetsByRule(rule.name, rule.eventBusName).catch((): EventBridgeTargetSummary[] => []);
      candidates.push({
        id: rule.arn,
        name: rule.name,
        providerType: 'eventbridge',
        tags: {},
        evidence: [`EventBridge rule discovered: ${rule.name}`],
        meta: {
          surfaceKind: 'rule',
          arn: rule.arn,
          eventBusName: rule.eventBusName ?? '',
          eventPattern: rule.eventPattern ?? '',
          scheduleExpression: rule.scheduleExpression ?? '',
          state: rule.state ?? '',
          description: rule.description ?? '',
          targetsJson: JSON.stringify(targets)
        }
      });
    }

    for (const pipe of await this.client.listPipes()) {
      candidates.push({
        id: pipe.arn,
        name: pipe.name,
        providerType: 'eventbridge',
        tags: {},
        evidence: [`EventBridge pipe discovered: ${pipe.name}`],
        meta: {
          surfaceKind: 'pipe',
          arn: pipe.arn,
          source: pipe.source ?? '',
          target: pipe.target ?? '',
          enrichment: pipe.enrichment ?? '',
          currentState: pipe.currentState ?? '',
          desiredState: pipe.desiredState ?? ''
        }
      });
    }

    for (const destination of await this.client.listApiDestinations()) {
      candidates.push({
        id: destination.arn,
        name: destination.name,
        providerType: 'eventbridge',
        tags: {},
        evidence: [`EventBridge API destination discovered: ${destination.name}`],
        meta: {
          surfaceKind: 'api-destination',
          arn: destination.arn,
          invocationEndpoint: destination.invocationEndpoint,
          httpMethod: destination.httpMethod,
          connectionArn: destination.connectionArn ?? '',
          invocationRateLimitPerSecond: destination.invocationRateLimitPerSecond?.toString() ?? '',
          state: destination.state ?? ''
        }
      });
    }

    return candidates;
  }

  public async exportSpec(candidate: SpecCandidate, _options?: ExportOptions): Promise<SpecExportResult> {
    void _options;
    const kind = candidate.meta.surfaceKind as EventBridgeSurfaceKind;
    const document =
      kind === 'rule'
        ? ruleDocument(candidate)
        : kind === 'pipe'
          ? pipeDocument(candidate, await this.client.describePipe(candidate.name))
          : apiDestinationDocument(candidate);

    return {
      content: `${JSON.stringify(document, null, 2)}\n`,
      format: 'openapi-json',
      filename: 'index.json',
      derivedOpenApiCompleteness: 'partial',
      evidence: [`Synthesized partial OpenAPI evidence for EventBridge ${kind} ${candidate.name}`]
    };
  }
}

function baseDocument(title: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title,
      version: '1.0.0',
      description: 'Partial EventBridge-derived API surface. EventBridge metadata constrains event shape but does not define a complete business API contract.'
    },
    paths: {}
  };
}

function ruleDocument(candidate: SpecCandidate): Record<string, unknown> {
  const document = baseDocument(candidate.name);
  const eventPattern = parseJson(candidate.meta.eventPattern);
  const targets = parseJsonArray(candidate.meta.targetsJson);
  document.webhooks = {
    [safeKey(candidate.name)]: {
      post: {
        operationId: `${camel(candidate.name)}EventBridgeRule`,
        summary: `EventBridge rule ${candidate.name}`,
        'x-aws-eventbridge-rule': {
          arn: candidate.meta.arn,
          eventBusName: candidate.meta.eventBusName || undefined,
          state: candidate.meta.state || undefined,
          scheduleExpression: candidate.meta.scheduleExpression || undefined
        },
        ...(eventPattern ? { 'x-aws-eventbridge-event-pattern': eventPattern } : {}),
        ...(targets.length > 0 ? { 'x-aws-eventbridge-targets': targets } : {}),
        requestBody: eventEnvelopeRequestBody(),
        responses: { '202': { description: 'Event matched by EventBridge rule' } }
      }
    }
  };
  return document;
}

function pipeDocument(candidate: SpecCandidate, detail: EventBridgePipeDetail): Record<string, unknown> {
  const document = baseDocument(candidate.name);
  document.webhooks = {
    [safeKey(`pipe.${candidate.name}`)]: {
      post: {
        operationId: `${camel(candidate.name)}EventBridgePipe`,
        summary: `EventBridge pipe ${candidate.name}`,
        'x-aws-eventbridge-pipe': {
          arn: detail.arn,
          source: detail.source,
          target: detail.target,
          enrichment: detail.enrichment,
          currentState: detail.currentState,
          desiredState: detail.desiredState,
          roleArn: detail.roleArn
        },
        ...(detail.filterCriteria ? { 'x-aws-eventbridge-filter-criteria': detail.filterCriteria } : {}),
        requestBody: eventEnvelopeRequestBody(),
        responses: { '202': { description: 'Event accepted by EventBridge pipe source' } }
      }
    }
  };
  return document;
}

function apiDestinationDocument(candidate: SpecCandidate): Record<string, unknown> {
  const endpoint = parseUrl(candidate.meta.invocationEndpoint);
  const method = (candidate.meta.httpMethod || 'POST').toLowerCase();
  const path = endpoint?.pathname && endpoint.pathname !== '' ? endpoint.pathname : '/';
  const document = baseDocument(candidate.name);
  document.servers = endpoint ? [{ url: `${endpoint.protocol}//${endpoint.host}` }] : [];
  document.paths = {
    [path]: {
      [method]: {
        operationId: `${camel(candidate.name)}ApiDestination`,
        summary: `EventBridge API destination ${candidate.name}`,
        'x-aws-eventbridge-api-destination': {
          arn: candidate.meta.arn,
          connectionArn: candidate.meta.connectionArn || undefined,
          invocationRateLimitPerSecond: numberOrUndefined(candidate.meta.invocationRateLimitPerSecond),
          state: candidate.meta.state || undefined
        },
        requestBody: eventEnvelopeRequestBody(),
        responses: { '200': { description: 'API destination response' } }
      }
    }
  };
  return document;
}

function eventEnvelopeRequestBody(): Record<string, unknown> {
  return {
    required: false,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          additionalProperties: true
        }
      }
    }
  };
}

function parseJson(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseJsonArray(raw: string | undefined): unknown[] {
  const parsed = parseJson(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function parseUrl(raw: string | undefined): URL | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function numberOrUndefined(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function safeKey(value: string): string {
  return value.trim().replace(/\s+/g, '-');
}

function camel(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+(.)/g, (_match, chr: string) => chr.toUpperCase())
    .replace(/^[^a-zA-Z]+/, '')
    .replace(/^([A-Z])/, (match) => match.toLowerCase()) || 'eventBridge';
}

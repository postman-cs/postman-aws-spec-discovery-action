import {
  EventBridgeClient,
  ListApiDestinationsCommand,
  ListRulesCommand,
  ListTargetsByRuleCommand,
  type ApiDestination,
  type Rule,
  type Target
} from '@aws-sdk/client-eventbridge';
import {
  DescribePipeCommand,
  ListPipesCommand,
  PipesClient,
  type DescribePipeResponse,
  type Pipe
} from '@aws-sdk/client-pipes';
import { NodeHttpHandler } from '@smithy/node-http-handler';

import { createAwsPaginationGuard } from './pagination.js';

export interface EventBridgeHttpParameters {
  headerParameters?: Record<string, string>;
  pathParameterValues?: string[];
  queryStringParameters?: Record<string, string>;
}

export interface EventBridgeTargetSummary {
  id: string;
  arn: string;
  input?: string;
  inputPath?: string;
  inputTransformerJson?: string;
  httpParameters?: EventBridgeHttpParameters;
}

export interface EventBridgeRuleSummary {
  name: string;
  arn: string;
  eventBusName?: string;
  eventPattern?: string;
  scheduleExpression?: string;
  state?: string;
  description?: string;
  targets?: EventBridgeTargetSummary[];
}

export interface EventBridgeFilter {
  pattern?: string;
}

export interface EventBridgeFilterCriteria {
  filters?: EventBridgeFilter[];
}

export interface EventBridgePipeSummary {
  name: string;
  arn: string;
  source?: string;
  target?: string;
  enrichment?: string;
  desiredState?: string;
  currentState?: string;
}

export interface EventBridgePipeDetail extends EventBridgePipeSummary {
  filterCriteria?: EventBridgeFilterCriteria;
  sourceParametersJson?: string;
  targetParametersJson?: string;
  enrichmentParametersJson?: string;
  roleArn?: string;
  tags?: Record<string, string>;
}

export interface EventBridgeApiDestinationSummary {
  name: string;
  arn: string;
  invocationEndpoint: string;
  httpMethod: string;
  connectionArn?: string;
  invocationRateLimitPerSecond?: number;
  state?: string;
}

export interface EventBridgeSurfaceSpecClient {
  listRules(): Promise<EventBridgeRuleSummary[]>;
  listTargetsByRule(ruleName: string, eventBusName?: string): Promise<EventBridgeTargetSummary[]>;
  listPipes(): Promise<EventBridgePipeSummary[]>;
  describePipe(name: string): Promise<EventBridgePipeDetail>;
  listApiDestinations(): Promise<EventBridgeApiDestinationSummary[]>;
  probe(): Promise<boolean>;
}

export class EventBridgeSurfaceSdkClient implements EventBridgeSurfaceSpecClient {
  private readonly events: EventBridgeClient;
  private readonly pipes: PipesClient;

  public constructor(region: string, options: { requestTimeoutMs?: number; maxAttempts?: number } = {}) {
    const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    const requestHandler = new NodeHttpHandler({
      connectionTimeout: requestTimeoutMs,
      socketTimeout: requestTimeoutMs
    });
    this.events = new EventBridgeClient({
      region,
      maxAttempts: options.maxAttempts ?? 3,
      requestHandler
    });
    this.pipes = new PipesClient({
      region,
      maxAttempts: options.maxAttempts ?? 3,
      requestHandler
    });
  }

  public async listRules(): Promise<EventBridgeRuleSummary[]> {
    const rules: EventBridgeRuleSummary[] = [];
    const guard = createAwsPaginationGuard('EventBridge ListRules');
    let nextToken: string | undefined;
    do {
      guard.beginPage();
      const response = await this.events.send(new ListRulesCommand({ NextToken: nextToken, Limit: 100 }));
      for (const rule of response.Rules ?? []) {
        const mapped = mapRule(rule);
        if (mapped) rules.push(mapped);
      }
      nextToken = guard.takeNextToken(response.NextToken);
    } while (nextToken);
    return rules;
  }

  public async listTargetsByRule(ruleName: string, eventBusName?: string): Promise<EventBridgeTargetSummary[]> {
    const targets: EventBridgeTargetSummary[] = [];
    const guard = createAwsPaginationGuard('EventBridge ListTargetsByRule');
    let nextToken: string | undefined;
    do {
      guard.beginPage();
      const response = await this.events.send(
        new ListTargetsByRuleCommand({
          Rule: ruleName,
          EventBusName: eventBusName,
          NextToken: nextToken,
          Limit: 100
        })
      );
      for (const target of response.Targets ?? []) {
        const mapped = mapTarget(target);
        if (mapped) targets.push(mapped);
      }
      nextToken = guard.takeNextToken(response.NextToken);
    } while (nextToken);
    return targets;
  }

  public async listPipes(): Promise<EventBridgePipeSummary[]> {
    const pipes: EventBridgePipeSummary[] = [];
    const guard = createAwsPaginationGuard('EventBridge ListPipes');
    let nextToken: string | undefined;
    do {
      guard.beginPage();
      const response = await this.pipes.send(new ListPipesCommand({ NextToken: nextToken, Limit: 100 }));
      for (const pipe of response.Pipes ?? []) {
        const mapped = mapPipe(pipe);
        if (mapped) pipes.push(mapped);
      }
      nextToken = guard.takeNextToken(response.NextToken);
    } while (nextToken);
    return pipes;
  }

  public async describePipe(name: string): Promise<EventBridgePipeDetail> {
    const response = await this.pipes.send(new DescribePipeCommand({ Name: name }));
    return mapPipeDetail(response, name);
  }

  public async listApiDestinations(): Promise<EventBridgeApiDestinationSummary[]> {
    const destinations: EventBridgeApiDestinationSummary[] = [];
    const guard = createAwsPaginationGuard('EventBridge ListApiDestinations');
    let nextToken: string | undefined;
    do {
      guard.beginPage();
      const response = await this.events.send(new ListApiDestinationsCommand({ NextToken: nextToken, Limit: 100 }));
      for (const destination of response.ApiDestinations ?? []) {
        const mapped = mapApiDestination(destination);
        if (mapped) destinations.push(mapped);
      }
      nextToken = guard.takeNextToken(response.NextToken);
    } while (nextToken);
    return destinations;
  }

  public async probe(): Promise<boolean> {
    const checks = [
      this.events.send(new ListRulesCommand({ Limit: 1 })).then(() => true, () => false),
      this.pipes.send(new ListPipesCommand({ Limit: 1 })).then(() => true, () => false),
      this.events.send(new ListApiDestinationsCommand({ Limit: 1 })).then(() => true, () => false)
    ];
    return (await Promise.all(checks)).some(Boolean);
  }
}

function mapRule(rule: Rule): EventBridgeRuleSummary | undefined {
  if (!rule.Name || !rule.Arn) return undefined;
  return {
    name: rule.Name,
    arn: rule.Arn,
    eventBusName: rule.EventBusName,
    eventPattern: rule.EventPattern,
    scheduleExpression: rule.ScheduleExpression,
    state: rule.State,
    description: rule.Description
  };
}

function mapTarget(target: Target): EventBridgeTargetSummary | undefined {
  if (!target.Id || !target.Arn) return undefined;
  return {
    id: target.Id,
    arn: target.Arn,
    input: target.Input,
    inputPath: target.InputPath,
    inputTransformerJson: target.InputTransformer ? JSON.stringify(target.InputTransformer) : undefined,
    httpParameters: target.HttpParameters
      ? {
          headerParameters: target.HttpParameters.HeaderParameters,
          pathParameterValues: target.HttpParameters.PathParameterValues,
          queryStringParameters: target.HttpParameters.QueryStringParameters
        }
      : undefined
  };
}

function mapPipe(pipe: Pipe): EventBridgePipeSummary | undefined {
  if (!pipe.Name || !pipe.Arn) return undefined;
  return {
    name: pipe.Name,
    arn: pipe.Arn,
    source: pipe.Source,
    target: pipe.Target,
    enrichment: pipe.Enrichment,
    desiredState: pipe.DesiredState,
    currentState: pipe.CurrentState
  };
}

function mapPipeDetail(pipe: DescribePipeResponse, name: string): EventBridgePipeDetail {
  return {
    name: pipe.Name ?? name,
    arn: pipe.Arn ?? name,
    source: pipe.Source,
    target: pipe.Target,
    enrichment: pipe.Enrichment,
    desiredState: pipe.DesiredState,
    currentState: pipe.CurrentState,
    filterCriteria: pipe.SourceParameters?.FilterCriteria
      ? {
          filters: pipe.SourceParameters.FilterCriteria.Filters?.map((filter) => ({ pattern: filter.Pattern }))
        }
      : undefined,
    sourceParametersJson: pipe.SourceParameters ? JSON.stringify(pipe.SourceParameters) : undefined,
    targetParametersJson: pipe.TargetParameters ? JSON.stringify(pipe.TargetParameters) : undefined,
    enrichmentParametersJson: pipe.EnrichmentParameters ? JSON.stringify(pipe.EnrichmentParameters) : undefined,
    roleArn: pipe.RoleArn,
    tags: pipe.Tags
  };
}

function mapApiDestination(destination: ApiDestination): EventBridgeApiDestinationSummary | undefined {
  if (!destination.Name || !destination.ApiDestinationArn || !destination.InvocationEndpoint || !destination.HttpMethod) {
    return undefined;
  }
  return {
    name: destination.Name,
    arn: destination.ApiDestinationArn,
    invocationEndpoint: destination.InvocationEndpoint,
    httpMethod: destination.HttpMethod,
    connectionArn: destination.ConnectionArn,
    invocationRateLimitPerSecond: destination.InvocationRateLimitPerSecond,
    state: destination.ApiDestinationState
  };
}

import {
  APIGatewayClient,
  GetExportCommand,
  GetBasePathMappingsCommand,
  GetDomainNamesCommand as GetRestDomainNamesCommand,
  GetModelsCommand,
  GetResourcesCommand,
  GetRestApiCommand,
  GetRestApisCommand,
  GetRequestValidatorsCommand,
  GetStagesCommand as GetRestStagesCommand,
  GetTagsCommand as GetRestTagsCommand,
  paginateGetRestApis,
  type Model,
  type RequestValidator,
  type Resource
} from '@aws-sdk/client-api-gateway';
import {
  ApiGatewayV2Client,
  ExportApiCommand,
  GetApiMappingsCommand,
  GetApiCommand,
  GetApisCommand,
  GetAuthorizersCommand,
  GetDomainNamesCommand as GetHttpDomainNamesCommand,
  GetIntegrationsCommand,
  GetModelsCommand as GetWebSocketModelsCommand,
  GetRouteResponsesCommand,
  GetRoutesCommand,
  GetStagesCommand as GetHttpStagesCommand,
  GetTagsCommand as GetHttpTagsCommand,
  type Authorizer,
  type Integration,
  type Model as WebSocketModel,
  type Route,
  type RouteResponse
} from '@aws-sdk/client-apigatewayv2';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
  synthesizeWebSocketOpenApi,
  type WebSocketAuthorizerSummary,
  type WebSocketIntegrationSummary,
  type WebSocketModelSummary,
  type WebSocketRouteResponseSummary
} from '../spec/websocket-openapi.js';
import { mergeRestApiModelsAndValidators, synthesizeRestApiFallbackOpenApi } from '../spec/rest-api-fallback-openapi.js';

export interface RestApiSummary {
  id: string;
  name: string;
}

export interface HttpApiSummary {
  id: string;
  name: string;
  protocolType: string;
  routeSelectionExpression?: string;
}

export interface GatewayDomainMapping {
  domainName: string;
  apiId: string;
  basePath?: string;
  stage?: string;
  gatewayType: 'REST' | 'HTTP' | 'WEBSOCKET';
}

/** Stage listing evidence from API Gateway; fields are omitted when AWS does not return them. */
export interface GatewayStageSummary {
  stageName: string;
  deploymentId?: string;
  /** HTTP/WebSocket auto-deploy flag when AWS returns it; never fabricated for REST. */
  autoDeploy?: boolean;
  /** HTTP/WebSocket API Gateway managed stage flag when AWS returns it. */
  apiGatewayManaged?: boolean;
}

export interface AwsCallerIdentity {
  accountId?: string;
  arn?: string;
  /** Partition derived from the caller ARN (`aws`, `aws-us-gov`, `aws-cn`, …). */
  partition?: string;
}

export interface AwsGatewayClient {
  listRestApis(): Promise<RestApiSummary[]>;
  listHttpApis(): Promise<HttpApiSummary[]>;
  getRestApi(apiId: string): Promise<RestApiSummary | undefined>;
  getHttpApi(apiId: string): Promise<HttpApiSummary | undefined>;
  listRestStages(apiId: string): Promise<GatewayStageSummary[]>;
  listHttpStages(apiId: string): Promise<GatewayStageSummary[]>;
  getRestTags(apiId: string): Promise<Record<string, string>>;
  getHttpTags(apiId: string): Promise<Record<string, string>>;
  exportRestApi(apiId: string, stage: string): Promise<string>;
  exportRestApiFallback?(apiId: string, stage?: string): Promise<string>;
  exportHttpApi(apiId: string, stage?: string): Promise<string>;
  exportWebSocketApi(apiId: string, stage?: string): Promise<string>;
  getCallerIdentity(): Promise<AwsCallerIdentity>;
  probeApiGatewayReadAccess(): Promise<void>;
  probeHttpApiGatewayReadAccess?(): Promise<void>;
  listRestDomainMappings?(): Promise<GatewayDomainMapping[]>;
  listHttpDomainMappings?(): Promise<GatewayDomainMapping[]>;
}

export function partitionFromArn(arn: string | undefined): string | undefined {
  if (!arn) return undefined;
  const match = /^arn:([^:]+):/.exec(arn.trim());
  return match?.[1] || undefined;
}

export function accountIndicatorFromAccountId(accountId: string | undefined): string | undefined {
  const trimmed = (accountId ?? '').trim();
  if (!/^\d{12}$/.test(trimmed)) return undefined;
  return `***${trimmed.slice(-4)}`;
}

export interface AwsClientOptions {
  requestTimeoutMs?: number;
  maxAttempts?: number;
}

export interface AwsErrorInfo {
  name?: string;
  message: string;
  httpStatusCode?: number;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseAwsError(error: unknown): AwsErrorInfo {
  if (error && typeof error === 'object') {
    const maybe = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
    return {
      name: maybe.name,
      message: maybe.message ?? toErrorMessage(error),
      httpStatusCode: maybe.$metadata?.httpStatusCode
    };
  }
  return {
    message: toErrorMessage(error)
  };
}

async function readExportBody(body: unknown): Promise<string> {
  if (!body) {
    return '';
  }

  if (typeof body === 'string') {
    return body;
  }

  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }

  if (typeof body === 'object') {
    const maybeTransformable = body as {
      transformToString?: () => Promise<string>;
      transformToByteArray?: () => Promise<Uint8Array>;
    };
    if (typeof maybeTransformable.transformToString === 'function') {
      return await maybeTransformable.transformToString();
    }
    if (typeof maybeTransformable.transformToByteArray === 'function') {
      const bytes = await maybeTransformable.transformToByteArray();
      return new TextDecoder().decode(bytes);
    }
  }

  throw new Error('Unsupported AWS SDK export body type');
}

function isAwsNotFoundError(message: string): boolean {
  const lowered = message.toLowerCase();
  return lowered.includes('notfoundexception') || lowered.includes('not found');
}

function integrationIdFromTarget(target: string | undefined): string | undefined {
  const match = /^integrations\/([^/]+)$/.exec(target ?? '');
  return match?.[1];
}

function mapWebSocketIntegration(integration: Integration | undefined): WebSocketIntegrationSummary | undefined {
  if (!integration) {
    return undefined;
  }
  return {
    integrationId: integration.IntegrationId,
    integrationType: integration.IntegrationType,
    integrationUri: integration.IntegrationUri,
    integrationMethod: integration.IntegrationMethod,
    requestParameters: integration.RequestParameters,
    requestTemplates: integration.RequestTemplates,
    templateSelectionExpression: integration.TemplateSelectionExpression,
    timeoutInMillis: integration.TimeoutInMillis
  };
}

function mapWebSocketAuthorizer(authorizer: Authorizer | undefined): WebSocketAuthorizerSummary | undefined {
  if (!authorizer) {
    return undefined;
  }
  return {
    authorizerId: authorizer.AuthorizerId,
    authorizerType: authorizer.AuthorizerType,
    authorizerUri: authorizer.AuthorizerUri,
    identitySource: authorizer.IdentitySource
  };
}

function mapWebSocketRouteResponses(routeResponses: RouteResponse[]): WebSocketRouteResponseSummary[] {
  return routeResponses.map((routeResponse) => ({
    routeResponseId: routeResponse.RouteResponseId,
    routeResponseKey: routeResponse.RouteResponseKey,
    modelSelectionExpression: routeResponse.ModelSelectionExpression,
    responseModels: routeResponse.ResponseModels,
    responseParameters: routeResponse.ResponseParameters
  }));
}

function mapWebSocketModels(models: WebSocketModel[]): WebSocketModelSummary[] {
  return models
    .filter((model): model is WebSocketModel & { Name: string } => Boolean(model.Name))
    .map((model) => ({
      name: model.Name,
      contentType: model.ContentType,
      schema: model.Schema
    }));
}

export class AwsApiGatewaySdkClient implements AwsGatewayClient {
  private readonly restClient: APIGatewayClient;
  private readonly httpClient: ApiGatewayV2Client;
  private readonly stsClient: STSClient;

  public constructor(private readonly region: string, options: AwsClientOptions = {}) {
    const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    const maxAttempts = options.maxAttempts ?? 3;
    const requestHandler = new NodeHttpHandler({
      connectionTimeout: requestTimeoutMs,
      socketTimeout: requestTimeoutMs
    });
    const shared = { region, maxAttempts, requestHandler };
    this.restClient = new APIGatewayClient(shared);
    this.httpClient = new ApiGatewayV2Client(shared);
    this.stsClient = new STSClient(shared);
  }

  public async listRestApis(): Promise<RestApiSummary[]> {
    const items: RestApiSummary[] = [];
    for await (const page of paginateGetRestApis({ client: this.restClient }, {})) {
      for (const item of page.items ?? []) {
        if (!item.id) {
          continue;
        }
        items.push({
          id: item.id,
          name: (item.name ?? '').trim() || item.id
        });
      }
    }
    return items;
  }

  public async listHttpApis(): Promise<HttpApiSummary[]> {
    const items: HttpApiSummary[] = [];
    let nextToken: string | undefined;
    do {
      const response = await this.httpClient.send(
        new GetApisCommand({
          NextToken: nextToken
        })
      );
      for (const item of response.Items ?? []) {
        if (!item.ApiId) {
          continue;
        }
        items.push({
          id: item.ApiId,
          name: (item.Name ?? '').trim() || item.ApiId,
          protocolType: (item.ProtocolType ?? '').trim().toUpperCase(),
          routeSelectionExpression: item.RouteSelectionExpression
        });
      }
      nextToken = response.NextToken;
    } while (nextToken);
    return items;
  }

  public async listRestDomainMappings(): Promise<GatewayDomainMapping[]> {
    const mappings: GatewayDomainMapping[] = [];
    let position: string | undefined;
    do {
      const domains = await this.restClient.send(new GetRestDomainNamesCommand({ position }));
      for (const domain of domains.items ?? []) {
        const domainName = domain.domainName;
        if (!domainName) continue;
        let basePathPosition: string | undefined;
        do {
          const response = await this.restClient.send(
            new GetBasePathMappingsCommand({
              domainName,
              position: basePathPosition
            })
          );
          for (const mapping of response.items ?? []) {
            if (!mapping.restApiId) continue;
            mappings.push({
              domainName,
              apiId: mapping.restApiId,
              basePath: mapping.basePath,
              stage: mapping.stage,
              gatewayType: 'REST'
            });
          }
          basePathPosition = response.position;
        } while (basePathPosition);
      }
      position = domains.position;
    } while (position);
    return mappings;
  }

  public async listHttpDomainMappings(): Promise<GatewayDomainMapping[]> {
    const mappings: GatewayDomainMapping[] = [];
    let nextToken: string | undefined;
    do {
      const domains = await this.httpClient.send(new GetHttpDomainNamesCommand({ NextToken: nextToken }));
      for (const domain of domains.Items ?? []) {
        const domainName = domain.DomainName;
        if (!domainName) continue;
        let mappingToken: string | undefined;
        do {
          const response = await this.httpClient.send(
            new GetApiMappingsCommand({
              DomainName: domainName,
              NextToken: mappingToken
            })
          );
          for (const mapping of response.Items ?? []) {
            if (!mapping.ApiId) continue;
            const api = await this.getHttpApi(mapping.ApiId).catch(() => undefined);
            mappings.push({
              domainName,
              apiId: mapping.ApiId,
              basePath: mapping.ApiMappingKey,
              stage: mapping.Stage,
              gatewayType: api?.protocolType === 'WEBSOCKET' ? 'WEBSOCKET' : 'HTTP'
            });
          }
          mappingToken = response.NextToken;
        } while (mappingToken);
      }
      nextToken = domains.NextToken;
    } while (nextToken);
    return mappings;
  }

  public async getRestApi(apiId: string): Promise<RestApiSummary | undefined> {
    try {
      const response = await this.restClient.send(
        new GetRestApiCommand({
          restApiId: apiId
        })
      );
      if (!response.id) {
        return undefined;
      }
      return {
        id: response.id,
        name: (response.name ?? '').trim() || response.id
      };
    } catch (error) {
      const message = parseAwsError(error).message;
      if (isAwsNotFoundError(message)) {
        return undefined;
      }
      throw error;
    }
  }

  public async getHttpApi(apiId: string): Promise<HttpApiSummary | undefined> {
    try {
      const response = await this.httpClient.send(
        new GetApiCommand({
          ApiId: apiId
        })
      );
      if (!response.ApiId) {
        return undefined;
      }
      return {
        id: response.ApiId,
        name: (response.Name ?? '').trim() || response.ApiId,
        protocolType: (response.ProtocolType ?? '').trim().toUpperCase(),
        routeSelectionExpression: response.RouteSelectionExpression
      };
    } catch (error) {
      const message = parseAwsError(error).message;
      if (isAwsNotFoundError(message)) {
        return undefined;
      }
      throw error;
    }
  }

  public async listRestStages(apiId: string): Promise<GatewayStageSummary[]> {
    const response = await this.restClient.send(
      new GetRestStagesCommand({
        restApiId: apiId
      })
    );
    return (response.item ?? [])
      .map((stage) => {
        const stageName = (stage.stageName ?? '').trim();
        if (!stageName) return undefined;
        const summary: GatewayStageSummary = { stageName };
        const deploymentId = (stage.deploymentId ?? '').trim();
        if (deploymentId) summary.deploymentId = deploymentId;
        return summary;
      })
      .filter((stage): stage is GatewayStageSummary => Boolean(stage));
  }

  public async listHttpStages(apiId: string): Promise<GatewayStageSummary[]> {
    const response = await this.httpClient.send(
      new GetHttpStagesCommand({
        ApiId: apiId
      })
    );
    return (response.Items ?? [])
      .map((stage) => {
        const stageName = (stage.StageName ?? '').trim();
        if (!stageName) return undefined;
        const summary: GatewayStageSummary = { stageName };
        const deploymentId = (stage.DeploymentId ?? '').trim();
        if (deploymentId) summary.deploymentId = deploymentId;
        if (typeof stage.AutoDeploy === 'boolean') summary.autoDeploy = stage.AutoDeploy;
        if (typeof stage.ApiGatewayManaged === 'boolean') summary.apiGatewayManaged = stage.ApiGatewayManaged;
        return summary;
      })
      .filter((stage): stage is GatewayStageSummary => Boolean(stage));
  }

  public async getRestTags(apiId: string): Promise<Record<string, string>> {
    const resourceArn = `arn:aws:apigateway:${this.region}::/restapis/${apiId}`;
    const response = await this.restClient.send(
      new GetRestTagsCommand({
        resourceArn
      })
    );
    return response.tags ?? {};
  }

  public async getHttpTags(apiId: string): Promise<Record<string, string>> {
    const resourceArn = `arn:aws:apigateway:${this.region}::/apis/${apiId}`;
    const response = await this.httpClient.send(
      new GetHttpTagsCommand({
        ResourceArn: resourceArn
      })
    );
    return response.Tags ?? {};
  }

  public async exportRestApi(apiId: string, stage: string): Promise<string> {
    const response = await this.restClient.send(
      new GetExportCommand({
        restApiId: apiId,
        stageName: stage,
        exportType: 'oas30',
        accepts: 'application/yaml',
        parameters: {
          extensions: 'apigateway'
        }
      })
    );
    const nativeExport = await readExportBody(response.body);
    // W6: additively enrich the native export with Models and RequestValidators.
    // Fail-soft -- any enrichment error returns the exact native body.
    try {
      const [resources, models, validators] = await Promise.all([
        this.listRestResourcesWithMethods(apiId),
        this.listRestModels(apiId),
        this.listRestRequestValidators(apiId)
      ]);
      return mergeRestApiModelsAndValidators({
        nativeExport,
        resources: resources.map((resource) => ({
          path: resource.path,
          resourceMethods: resource.resourceMethods as never
        })),
        models: models.map((model) => ({ name: model.name, schema: model.schema, contentType: model.contentType })),
        validators: validators.map((validator) => ({
          id: validator.id,
          name: validator.name,
          validateRequestBody: validator.validateRequestBody,
          validateRequestParameters: validator.validateRequestParameters
        }))
      });
    } catch {
      return nativeExport;
    }
  }

  private async listRestRequestValidators(apiId: string): Promise<RequestValidator[]> {
    const validators: RequestValidator[] = [];
    let position: string | undefined;
    const seenPositions = new Set<string>();
    do {
      const response = await this.restClient.send(
        new GetRequestValidatorsCommand({
          restApiId: apiId,
          position,
          limit: 500
        })
      );
      validators.push(...(response.items ?? []));
      const next = response.position;
      if (next !== undefined && seenPositions.has(next)) break;
      if (next !== undefined) seenPositions.add(next);
      position = next;
    } while (position);
    return validators;
  }

  public async exportRestApiFallback(apiId: string, stage?: string): Promise<string> {
    const [api, resources, models] = await Promise.all([
      this.getRestApi(apiId),
      this.listRestResourcesWithMethods(apiId),
      this.listRestModels(apiId)
    ]);
    return synthesizeRestApiFallbackOpenApi({
      apiId,
      apiName: api?.name ?? apiId,
      region: this.region,
      stage,
      resources,
      models
    });
  }

  private async listRestResourcesWithMethods(apiId: string): Promise<Resource[]> {
    const resources: Resource[] = [];
    let position: string | undefined;
    const seenPositions = new Set<string>();
    do {
      const response = await this.restClient.send(
        new GetResourcesCommand({
          restApiId: apiId,
          position,
          limit: 500,
          embed: ['methods']
        })
      );
      resources.push(...(response.items ?? []));
      const next = response.position;
      if (next !== undefined && seenPositions.has(next)) break;
      if (next !== undefined) seenPositions.add(next);
      position = next;
    } while (position);
    return resources;
  }

  private async listRestModels(apiId: string): Promise<Model[]> {
    const models: Model[] = [];
    let position: string | undefined;
    const seenPositions = new Set<string>();
    do {
      const response = await this.restClient.send(
        new GetModelsCommand({
          restApiId: apiId,
          position,
          limit: 500
        })
      );
      models.push(...(response.items ?? []));
      const next = response.position;
      if (next !== undefined && seenPositions.has(next)) break;
      if (next !== undefined) seenPositions.add(next);
      position = next;
    } while (position);
    return models;
  }

  public async exportHttpApi(apiId: string, stage?: string): Promise<string> {
    const response = await this.httpClient.send(
      new ExportApiCommand({
        ApiId: apiId,
        Specification: 'OAS30',
        OutputType: 'YAML',
        IncludeExtensions: stage ? true : false,
        StageName: stage
      })
    );
    return await readExportBody(response.body);
  }

  public async exportWebSocketApi(apiId: string, stage?: string): Promise<string> {
    const [api, routeItems, integrations, authorizers, models] = await Promise.all([
      this.getHttpApi(apiId),
      this.listWebSocketRoutes(apiId),
      this.listWebSocketIntegrations(apiId),
      this.listWebSocketAuthorizers(apiId),
      this.listWebSocketModels(apiId)
    ]);
    const integrationById = new Map(
      integrations
        .filter((integration): integration is Integration & { IntegrationId: string } => Boolean(integration.IntegrationId))
        .map((integration) => [integration.IntegrationId, integration])
    );
    const authorizerById = new Map(
      authorizers
        .filter((authorizer): authorizer is Authorizer & { AuthorizerId: string } => Boolean(authorizer.AuthorizerId))
        .map((authorizer) => [authorizer.AuthorizerId, authorizer])
    );
    const routes = await Promise.all(
      routeItems
        .filter((route): route is Route & { RouteKey: string } => Boolean(route.RouteKey))
        .map(async (route) => {
          const integrationId = integrationIdFromTarget(route.Target);
          return {
            routeKey: route.RouteKey,
            routeId: route.RouteId,
            apiKeyRequired: route.ApiKeyRequired,
            authorizationType: route.AuthorizationType,
            authorizationScopes: route.AuthorizationScopes,
            authorizerId: route.AuthorizerId,
            operationName: route.OperationName,
            modelSelectionExpression: route.ModelSelectionExpression,
            requestModels: route.RequestModels,
            requestParameters: route.RequestParameters,
            routeResponseSelectionExpression: route.RouteResponseSelectionExpression,
            target: route.Target,
            integration: mapWebSocketIntegration(integrationId ? integrationById.get(integrationId) : undefined),
            authorizer: mapWebSocketAuthorizer(route.AuthorizerId ? authorizerById.get(route.AuthorizerId) : undefined),
            routeResponses: route.RouteId ? mapWebSocketRouteResponses(await this.listWebSocketRouteResponses(apiId, route.RouteId)) : []
          };
        })
    );

    return synthesizeWebSocketOpenApi({
      apiId,
      apiName: api?.name ?? apiId,
      region: this.region,
      stage,
      routeSelectionExpression: api?.routeSelectionExpression,
      routes,
      models: mapWebSocketModels(models)
    });
  }

  private async listWebSocketRoutes(apiId: string): Promise<Route[]> {
    const routes: Route[] = [];
    let nextToken: string | undefined;
    do {
      const response = await this.httpClient.send(
        new GetRoutesCommand({
          ApiId: apiId,
          NextToken: nextToken
        })
      );
      routes.push(...(response.Items ?? []));
      nextToken = response.NextToken;
    } while (nextToken);
    return routes;
  }

  private async listWebSocketIntegrations(apiId: string): Promise<Integration[]> {
    const integrations: Integration[] = [];
    let nextToken: string | undefined;
    do {
      const response = await this.httpClient.send(
        new GetIntegrationsCommand({
          ApiId: apiId,
          MaxResults: '500',
          NextToken: nextToken
        })
      );
      integrations.push(...(response.Items ?? []));
      nextToken = response.NextToken;
    } while (nextToken);
    return integrations;
  }

  private async listWebSocketAuthorizers(apiId: string): Promise<Authorizer[]> {
    const authorizers: Authorizer[] = [];
    let nextToken: string | undefined;
    do {
      const response = await this.httpClient.send(
        new GetAuthorizersCommand({
          ApiId: apiId,
          MaxResults: '500',
          NextToken: nextToken
        })
      );
      authorizers.push(...(response.Items ?? []));
      nextToken = response.NextToken;
    } while (nextToken);
    return authorizers;
  }

  private async listWebSocketModels(apiId: string): Promise<WebSocketModel[]> {
    const models: WebSocketModel[] = [];
    let nextToken: string | undefined;
    do {
      const response = await this.httpClient.send(
        new GetWebSocketModelsCommand({
          ApiId: apiId,
          MaxResults: '500',
          NextToken: nextToken
        })
      );
      models.push(...(response.Items ?? []));
      nextToken = response.NextToken;
    } while (nextToken);
    return models;
  }

  private async listWebSocketRouteResponses(apiId: string, routeId: string): Promise<RouteResponse[]> {
    const routeResponses: RouteResponse[] = [];
    let nextToken: string | undefined;
    do {
      const response = await this.httpClient.send(
        new GetRouteResponsesCommand({
          ApiId: apiId,
          RouteId: routeId,
          MaxResults: '500',
          NextToken: nextToken
        })
      );
      routeResponses.push(...(response.Items ?? []));
      nextToken = response.NextToken;
    } while (nextToken);
    return routeResponses;
  }

  public async getCallerIdentity(): Promise<AwsCallerIdentity> {
    const response = await this.stsClient.send(new GetCallerIdentityCommand({}));
    return {
      accountId: response.Account,
      arn: response.Arn,
      partition: partitionFromArn(response.Arn)
    };
  }

  public async probeApiGatewayReadAccess(): Promise<void> {
    await this.restClient.send(
      new GetRestApisCommand({
        limit: 1
      })
    );
  }

  public async probeHttpApiGatewayReadAccess(): Promise<void> {
    await this.httpClient.send(
      new GetApisCommand({
        MaxResults: '1'
      })
    );
  }
}

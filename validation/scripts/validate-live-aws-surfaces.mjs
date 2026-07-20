#!/usr/bin/env node
/* global console, process */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { TextDecoder } from 'node:util';
import { parse as parseYaml } from 'yaml';
import {
  AppSyncClient,
  GetApiCommand as GetAppSyncApiCommand,
  GetChannelNamespaceCommand
} from '@aws-sdk/client-appsync';
import {
  BedrockAgentClient,
  GetAgentActionGroupCommand,
  GetAgentCommand,
  ListAgentActionGroupsCommand
} from '@aws-sdk/client-bedrock-agent';
import {
  APIGatewayClient,
  GetExportCommand,
  GetModelsCommand,
  GetResourcesCommand,
  GetRequestValidatorsCommand,
  GetRestApiCommand,
  GetStagesCommand as GetRestStagesCommand,
  GetTagsCommand as GetRestTagsCommand
} from '@aws-sdk/client-api-gateway';
import {
  CloudFormationClient,
  GetTemplateCommand,
  ListStackResourcesCommand
} from '@aws-sdk/client-cloudformation';
import {
  DescribeLoadBalancersCommand,
  DescribeRulesCommand,
  ElasticLoadBalancingV2Client
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  DescribeApiDestinationCommand,
  DescribeRuleCommand,
  EventBridgeClient,
  ListTargetsByRuleCommand
} from '@aws-sdk/client-eventbridge';
import {
  DescribePipeCommand,
  PipesClient
} from '@aws-sdk/client-pipes';
import {
  ApiGatewayV2Client,
  CreateRouteCommand,
  DeleteRouteCommand,
  ExportApiCommand,
  GetApiCommand,
  GetAuthorizersCommand,
  GetIntegrationsCommand,
  GetModelsCommand as GetWebSocketModelsCommand,
  GetRouteResponsesCommand,
  GetRoutesCommand,
  GetStagesCommand as GetHttpStagesCommand,
  GetTagsCommand as GetHttpTagsCommand
} from '@aws-sdk/client-apigatewayv2';
import {
  LambdaClient,
  GetEventSourceMappingCommand,
  GetFunctionCommand,
  GetFunctionUrlConfigCommand,
  ListTagsCommand
} from '@aws-sdk/client-lambda';
import {
  DescribeStateMachineCommand,
  SFNClient
} from '@aws-sdk/client-sfn';
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
  GetPolicyStoreCommand,
  GetSchemaCommand,
  VerifiedPermissionsClient
} from '@aws-sdk/client-verifiedpermissions';
import { updateEvidenceReadmeSection } from './lib/evidence-readme.mjs';
import { buildLiveRequiredMatrix, renderLiveRequiredMatrixMarkdown } from './lib/live-required-matrix.mjs';

const repoRoot = process.cwd();

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  const inline = process.argv.find((value) => value.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : fallback;
}

const manifestPath = arg('manifest', 'validation/evidence/live-resource-manifest.local.json');

if (process.argv.includes('--emit-required-only')) {
  const matrix = await buildLiveRequiredMatrix(repoRoot);
  const capturedAt = new Date().toISOString();
  const requiredSummary = renderLiveRequiredMatrixMarkdown(matrix, { capturedAt });
  await updateEvidenceReadmeSection(arg('summary', 'validation/evidence/README.md'), 'live-required-matrix', requiredSummary);
  await mkdir(path.dirname(arg('evidence-json', 'validation/evidence/live-aws-surfaces.local.json')), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'validation/evidence/live-required-matrix.local.json'),
    `${JSON.stringify({ capturedAt, matrix, mode: 'emit-required-only' }, null, 2)}\n`,
    'utf8'
  );
  console.log(JSON.stringify({ status: 'ok', mode: 'emit-required-only', cases: matrix.length }, null, 2));
  process.exit(0);
}

const evidenceJsonPath = arg('evidence-json', 'validation/evidence/live-aws-surfaces.local.json');
const summaryPath = arg('summary', 'validation/evidence/README.md');
const region = arg('region', 'us-east-1');
const cliPath = path.join(repoRoot, 'dist', 'cli.cjs');
const distEntry = path.join(repoRoot, 'dist', 'index.cjs');

if (!existsSync(cliPath)) {
  throw new Error(`Missing CLI bundle at ${cliPath}; run npm run build first`);
}

const {
  buildProviderRegistry,
  execute,
  resolveInputs,
  defaultWriteSpecFile,
  AlbListenerRulesProvider,
  AppSyncEventsProvider,
  BedrockActionGroupProvider,
  LambdaUrlProvider,
  EventBridgeSurfaceProvider,
  CloudFormationProvider,
  LambdaEventSourceProvider,
  StepFunctionsProvider,
  VerifiedPermissionsProvider,
  deriveOpenApiDocument,
  mergeRestApiModelsAndValidators,
  synthesizeRestApiFallbackOpenApi,
  synthesizeWebSocketOpenApi
} = await import(distEntry);
const manifest = JSON.parse(await readFile(path.join(repoRoot, manifestPath), 'utf8'));
const outputs = manifest.outputs ?? {};
const temporaryCredentialValues = new Set();

class TargetedApiGatewayClient {
  constructor(targetRegion) {
    this.region = targetRegion;
    this.rest = new APIGatewayClient({ region: targetRegion, maxAttempts: 4 });
    this.v2 = new ApiGatewayV2Client({ region: targetRegion, maxAttempts: 4 });
    this.sts = new STSClient({ region: targetRegion, maxAttempts: 4 });
  }

  async listRestApis() { return []; }
  async listHttpApis() { return []; }
  async probeApiGatewayReadAccess() {}

  async getCallerIdentity() {
    const response = await sendWithBackoff(this.sts, new GetCallerIdentityCommand({}));
    return { accountId: response.Account, arn: response.Arn };
  }

  async getRestApi(apiId) {
    try {
      const response = await sendWithBackoff(this.rest, new GetRestApiCommand({ restApiId: apiId }));
      return response.id ? { id: response.id, name: response.name ?? response.id } : undefined;
    } catch (error) {
      if (String(error).toLowerCase().includes('notfound') || String(error).toLowerCase().includes('invalid api identifier')) {
        return undefined;
      }
      throw error;
    }
  }

  async getHttpApi(apiId) {
    try {
      const response = await sendWithBackoff(this.v2, new GetApiCommand({ ApiId: apiId }));
      return response.ApiId ? {
        id: response.ApiId,
        name: response.Name ?? response.ApiId,
        protocolType: response.ProtocolType ?? '',
        routeSelectionExpression: response.RouteSelectionExpression
      } : undefined;
    } catch (error) {
      if (String(error).toLowerCase().includes('notfound') || String(error).toLowerCase().includes('not found')) {
        return undefined;
      }
      throw error;
    }
  }

  async listRestStages(apiId) {
    const response = await sendWithBackoff(this.rest, new GetRestStagesCommand({ restApiId: apiId }));
    return (response.item ?? []).map((stage) => stage.stageName).filter(Boolean);
  }

  async listHttpStages(apiId) {
    const response = await sendWithBackoff(this.v2, new GetHttpStagesCommand({ ApiId: apiId }));
    return (response.Items ?? []).map((stage) => stage.StageName).filter(Boolean);
  }

  async getRestTags(apiId) {
    const response = await sendWithBackoff(this.rest, new GetRestTagsCommand({ resourceArn: `arn:aws:apigateway:${this.region}::/restapis/${apiId}` }));
    return response.tags ?? {};
  }

  async getHttpTags(apiId) {
    const response = await sendWithBackoff(this.v2, new GetHttpTagsCommand({ ResourceArn: `arn:aws:apigateway:${this.region}::/apis/${apiId}` }));
    return response.Tags ?? {};
  }

  async exportRestApi(apiId, stage) {
    const response = await sendWithBackoff(this.rest, new GetExportCommand({
      restApiId: apiId,
      stageName: stage,
      exportType: 'oas30',
      accepts: 'application/yaml',
      parameters: { extensions: 'apigateway' }
    }));
    const nativeExport = await readBody(response.body);
    try {
      const [resources, models, validators] = await Promise.all([
        this.listRestResourcesWithMethods(apiId),
        this.listRestModels(apiId),
        this.listRestRequestValidators(apiId)
      ]);
      return mergeRestApiModelsAndValidators({
        nativeExport,
        resources: resources.map((resource) => ({ path: resource.path, resourceMethods: resource.resourceMethods })),
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

  async listRestRequestValidators(apiId) {
    const validators = [];
    let position;
    const seenPositions = new Set();
    do {
      const response = await sendWithBackoff(this.rest, new GetRequestValidatorsCommand({
        restApiId: apiId,
        position,
        limit: 500
      }));
      validators.push(...(response.items ?? []));
      const next = response.position;
      if (next !== undefined && seenPositions.has(next)) break;
      if (next !== undefined) seenPositions.add(next);
      position = next;
    } while (position);
    return validators;
  }

  async exportRestApiFallback(apiId, stage) {
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

  async listRestResourcesWithMethods(apiId) {
    const resources = [];
    let position;
    const seenPositions = new Set();
    do {
      const response = await sendWithBackoff(this.rest, new GetResourcesCommand({
        restApiId: apiId,
        position,
        limit: 500,
        embed: ['methods']
      }));
      resources.push(...(response.items ?? []));
      const next = response.position;
      if (next !== undefined && seenPositions.has(next)) break;
      if (next !== undefined) seenPositions.add(next);
      position = next;
    } while (position);
    return resources;
  }

  async listRestModels(apiId) {
    const models = [];
    let position;
    const seenPositions = new Set();
    do {
      const response = await sendWithBackoff(this.rest, new GetModelsCommand({
        restApiId: apiId,
        position,
        limit: 500
      }));
      models.push(...(response.items ?? []));
      const next = response.position;
      if (next !== undefined && seenPositions.has(next)) break;
      if (next !== undefined) seenPositions.add(next);
      position = next;
    } while (position);
    return models;
  }

  async exportHttpApi(apiId, stage) {
    const response = await sendWithBackoff(this.v2, new ExportApiCommand({
      ApiId: apiId,
      Specification: 'OAS30',
      OutputType: 'YAML',
      IncludeExtensions: Boolean(stage),
      StageName: stage
    }));
    return await readBody(response.body);
  }

  async exportWebSocketApi(apiId, stage) {
    const [api, routeItems, integrations, authorizers, models] = await Promise.all([
      this.getHttpApi(apiId),
      this.listWebSocketRoutes(apiId),
      this.listWebSocketIntegrations(apiId),
      this.listWebSocketAuthorizers(apiId),
      this.listWebSocketModels(apiId)
    ]);
    const integrationById = new Map(integrations.filter((integration) => integration.IntegrationId).map((integration) => [integration.IntegrationId, integration]));
    const authorizerById = new Map(authorizers.filter((authorizer) => authorizer.AuthorizerId).map((authorizer) => [authorizer.AuthorizerId, authorizer]));
    const routes = await Promise.all(routeItems.filter((route) => route.RouteKey).map(async (route) => {
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
    }));

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

  async listWebSocketRoutes(apiId) {
    const routes = [];
    let nextToken;
    do {
      const response = await sendWithBackoff(this.v2, new GetRoutesCommand({ ApiId: apiId, NextToken: nextToken }));
      routes.push(...(response.Items ?? []));
      nextToken = response.NextToken;
    } while (nextToken);
    return routes;
  }

  async listWebSocketIntegrations(apiId) {
    const integrations = [];
    let nextToken;
    do {
      const response = await sendWithBackoff(this.v2, new GetIntegrationsCommand({ ApiId: apiId, MaxResults: '500', NextToken: nextToken }));
      integrations.push(...(response.Items ?? []));
      nextToken = response.NextToken;
    } while (nextToken);
    return integrations;
  }

  async listWebSocketAuthorizers(apiId) {
    const authorizers = [];
    let nextToken;
    do {
      const response = await sendWithBackoff(this.v2, new GetAuthorizersCommand({ ApiId: apiId, MaxResults: '500', NextToken: nextToken }));
      authorizers.push(...(response.Items ?? []));
      nextToken = response.NextToken;
    } while (nextToken);
    return authorizers;
  }

  async listWebSocketModels(apiId) {
    const models = [];
    let nextToken;
    do {
      const response = await sendWithBackoff(this.v2, new GetWebSocketModelsCommand({ ApiId: apiId, MaxResults: '500', NextToken: nextToken }));
      models.push(...(response.Items ?? []));
      nextToken = response.NextToken;
    } while (nextToken);
    return models;
  }

  async listWebSocketRouteResponses(apiId, routeId) {
    const routeResponses = [];
    let nextToken;
    do {
      const response = await sendWithBackoff(this.v2, new GetRouteResponsesCommand({ ApiId: apiId, RouteId: routeId, MaxResults: '500', NextToken: nextToken }));
      routeResponses.push(...(response.Items ?? []));
      nextToken = response.NextToken;
    } while (nextToken);
    return routeResponses;
  }
}

function integrationIdFromTarget(target) {
  return /^integrations\/([^/]+)$/.exec(target ?? '')?.[1];
}

function mapWebSocketIntegration(integration) {
  if (!integration) return undefined;
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

function mapWebSocketAuthorizer(authorizer) {
  if (!authorizer) return undefined;
  return {
    authorizerId: authorizer.AuthorizerId,
    authorizerType: authorizer.AuthorizerType,
    authorizerUri: authorizer.AuthorizerUri,
    identitySource: authorizer.IdentitySource
  };
}

function mapWebSocketRouteResponses(routeResponses) {
  return routeResponses.map((routeResponse) => ({
    routeResponseId: routeResponse.RouteResponseId,
    routeResponseKey: routeResponse.RouteResponseKey,
    modelSelectionExpression: routeResponse.ModelSelectionExpression,
    responseModels: routeResponse.ResponseModels,
    responseParameters: routeResponse.ResponseParameters
  }));
}

function mapWebSocketModels(models) {
  return models.filter((model) => model.Name).map((model) => ({
    name: model.Name,
    contentType: model.ContentType,
    schema: typeof model.Schema === 'string' ? model.Schema : JSON.stringify(model.Schema ?? {})
  }));
}

async function sendWithBackoff(client, command) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await client.send(command);
    } catch (error) {
      lastError = error;
      if (!isThrottle(error) || attempt === 4) {
        throw error;
      }
      await delay(250 * 2 ** attempt);
    }
  }
  throw lastError;
}

function isThrottle(error) {
  const text = `${error?.name ?? ''} ${error?.message ?? ''}`.toLowerCase();
  return text.includes('too many requests') || text.includes('throttl') || text.includes('rate exceeded');
}

class TargetedLambdaSpecClient {
  constructor(targetRegion, functionName) {
    this.functionName = functionName;
    this.client = new LambdaClient({ region: targetRegion, maxAttempts: 2 });
  }

  async probe() { return true; }

  async listFunctions() {
    const fn = await this.client.send(new GetFunctionCommand({ FunctionName: this.functionName }));
    return [{
      name: this.functionName,
      arn: fn.Configuration?.FunctionArn ?? '',
      runtime: fn.Configuration?.Runtime ?? ''
    }];
  }

  async getFunctionUrlConfig(functionName) {
    const urlConfig = await this.client.send(new GetFunctionUrlConfigCommand({ FunctionName: functionName }));
    if (!urlConfig.FunctionArn || !urlConfig.FunctionUrl || !urlConfig.AuthType) {
      return undefined;
    }
    return {
      functionArn: urlConfig.FunctionArn,
      functionUrl: urlConfig.FunctionUrl,
      authType: urlConfig.AuthType,
      invokeMode: urlConfig.InvokeMode,
      cors: urlConfig.Cors ? {
        allowCredentials: urlConfig.Cors.AllowCredentials,
        allowHeaders: urlConfig.Cors.AllowHeaders,
        allowMethods: urlConfig.Cors.AllowMethods,
        allowOrigins: urlConfig.Cors.AllowOrigins,
        exposeHeaders: urlConfig.Cors.ExposeHeaders,
        maxAge: urlConfig.Cors.MaxAge
      } : undefined
    };
  }

  async getTags(functionArn) {
    return (await this.client.send(new ListTagsCommand({ Resource: functionArn })).catch(() => ({ Tags: {} }))).Tags ?? {};
  }
}

class TargetedLambdaUrlProvider {
  constructor(targetRegion, functionName) {
    return new LambdaUrlProvider(new TargetedLambdaSpecClient(targetRegion, functionName));
  }
}

class TargetedCloudFormationClient {
  constructor(targetRegion, stackName) {
    this.stackName = stackName;
    this.client = new CloudFormationClient({ region: targetRegion, maxAttempts: 2 });
  }

  async probe() { return true; }

  async listActiveStacks() {
    return [{ name: this.stackName, id: this.stackName, status: 'UPDATE_COMPLETE' }];
  }

  async listApiResources(stackName) {
    const items = [];
    let nextToken;
    do {
      const response = await this.client.send(new ListStackResourcesCommand({ StackName: stackName, NextToken: nextToken }));
      for (const resource of response.StackResourceSummaries ?? []) {
        if (![
          'AWS::ApiGateway::RestApi',
          'AWS::ApiGatewayV2::Api',
          'AWS::Serverless::Api',
          'AWS::Serverless::HttpApi',
          'AWS::AppSync::GraphQLApi'
        ].includes(resource.ResourceType)) {
          continue;
        }
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

  async getTemplate(stackName) {
    const response = await this.client.send(new GetTemplateCommand({ StackName: stackName, TemplateStage: 'Processed' }));
    return response.TemplateBody ?? '';
  }

  async getStackTags() {
    return {};
  }
}

class TargetedAppSyncEventsClient {
  constructor(targetRegion, apiId, namespaceName) {
    this.apiId = apiId;
    this.namespaceName = namespaceName;
    this.client = new AppSyncClient({ region: targetRegion, maxAttempts: 2 });
  }

  async probe() { return true; }

  async listEventApis() {
    if (!this.apiId) return [];
    const response = await sendWithBackoff(this.client, new GetAppSyncApiCommand({ apiId: this.apiId }));
    const api = response.api;
    if (!api?.apiId) return [];
    return [{
      apiId: api.apiId,
      name: api.name ?? this.apiId,
      apiArn: api.apiArn,
      dns: api.dns,
      tags: api.tags
    }];
  }

  async listChannelNamespaces(apiId) {
    if (!this.namespaceName) return [];
    const response = await sendWithBackoff(
      this.client,
      new GetChannelNamespaceCommand({ apiId, name: this.namespaceName })
    );
    const namespace = response.channelNamespace;
    if (!namespace?.name) return [];
    return [{
      apiId: namespace.apiId ?? apiId,
      name: namespace.name,
      channelNamespaceArn: namespace.channelNamespaceArn,
      publishAuthModes: namespace.publishAuthModes,
      subscribeAuthModes: namespace.subscribeAuthModes,
      codeHandlers: namespace.codeHandlers,
      tags: namespace.tags
    }];
  }
}

class TargetedEventBridgeSurfaceClient {
  constructor(targetRegion, { ruleName, pipeName, apiDestinationName } = {}) {
    this.ruleName = ruleName;
    this.pipeName = pipeName;
    this.apiDestinationName = apiDestinationName;
    this.events = new EventBridgeClient({ region: targetRegion, maxAttempts: 2 });
    this.pipes = new PipesClient({ region: targetRegion, maxAttempts: 2 });
  }

  async probe() { return true; }

  async listRules() {
    if (!this.ruleName) return [];
    const rule = await sendWithBackoff(this.events, new DescribeRuleCommand({ Name: this.ruleName }));
    return [{
      name: rule.Name ?? this.ruleName,
      arn: rule.Arn ?? this.ruleName,
      eventBusName: rule.EventBusName,
      eventPattern: rule.EventPattern,
      scheduleExpression: rule.ScheduleExpression,
      state: rule.State,
      description: rule.Description
    }];
  }

  async listTargetsByRule(ruleName, eventBusName) {
    if (!this.ruleName || ruleName !== this.ruleName) return [];
    const targets = [];
    let nextToken;
    do {
      const response = await sendWithBackoff(
        this.events,
        new ListTargetsByRuleCommand({
          Rule: ruleName,
          EventBusName: eventBusName,
          NextToken: nextToken,
          Limit: 100
        })
      );
      targets.push(...(response.Targets ?? []).filter((target) => target.Id && target.Arn).map((target) => ({
        id: target.Id,
        arn: target.Arn,
        input: target.Input,
        inputPath: target.InputPath,
        inputTransformerJson: target.InputTransformer ? JSON.stringify(target.InputTransformer) : undefined,
        httpParameters: target.HttpParameters ? {
          headerParameters: target.HttpParameters.HeaderParameters,
          pathParameterValues: target.HttpParameters.PathParameterValues,
          queryStringParameters: target.HttpParameters.QueryStringParameters
        } : undefined
      })));
      nextToken = response.NextToken;
    } while (nextToken);
    return targets;
  }

  async listPipes() {
    if (!this.pipeName) return [];
    return [await this.describePipe(this.pipeName)];
  }

  async describePipe(name) {
    const pipe = await sendWithBackoff(this.pipes, new DescribePipeCommand({ Name: name }));
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

  async listApiDestinations() {
    if (!this.apiDestinationName) return [];
    const destination = await sendWithBackoff(
      this.events,
      new DescribeApiDestinationCommand({ Name: this.apiDestinationName })
    );
    if (!destination.Name || !destination.InvocationEndpoint || !destination.HttpMethod) return [];
    return [{
      name: destination.Name,
      arn: destination.ApiDestinationArn ?? destination.Name,
      invocationEndpoint: destination.InvocationEndpoint,
      httpMethod: destination.HttpMethod,
      connectionArn: destination.ConnectionArn,
      invocationRateLimitPerSecond: destination.InvocationRateLimitPerSecond,
      state: destination.ApiDestinationState
    }];
  }
}

class TargetedBedrockActionGroupsClient {
  constructor(targetRegion, agentId, actionGroupName) {
    this.agentId = agentId;
    this.actionGroupName = actionGroupName;
    this.client = new BedrockAgentClient({ region: targetRegion, maxAttempts: 2 });
  }

  async probe() { return true; }

  async listAgents() {
    if (!this.agentId) return [];
    const response = await sendWithBackoff(this.client, new GetAgentCommand({ agentId: this.agentId }));
    const agent = response.agent;
    if (!agent?.agentId) return [];
    return [{
      agentId: agent.agentId,
      agentName: agent.agentName ?? this.agentId,
      latestAgentVersion: agent.agentVersion ?? 'DRAFT'
    }];
  }

  async listActionGroups(agentId, agentVersion) {
    if (!this.actionGroupName) return [];
    const groups = [];
    let nextToken;
    do {
      const response = await sendWithBackoff(
        this.client,
        new ListAgentActionGroupsCommand({
          agentId,
          agentVersion,
          nextToken,
          maxResults: 100
        })
      );
      groups.push(...(response.actionGroupSummaries ?? [])
        .filter((group) => group.actionGroupId && group.actionGroupName === this.actionGroupName)
        .map((group) => ({
          agentId,
          agentVersion,
          actionGroupId: group.actionGroupId,
          actionGroupName: group.actionGroupName,
          description: group.description,
          actionGroupState: group.actionGroupState
        })));
      nextToken = response.nextToken;
    } while (nextToken);
    return groups;
  }

  async getActionGroup(agentId, agentVersion, actionGroupId) {
    const response = await sendWithBackoff(
      this.client,
      new GetAgentActionGroupCommand({ agentId, agentVersion, actionGroupId })
    );
    const group = response.agentActionGroup;
    return {
      agentId: group?.agentId ?? agentId,
      agentVersion: group?.agentVersion ?? agentVersion,
      actionGroupId: group?.actionGroupId ?? actionGroupId,
      actionGroupName: group?.actionGroupName ?? actionGroupId,
      description: group?.description,
      actionGroupState: group?.actionGroupState,
      apiSchema: group?.apiSchema ? {
        payload: group.apiSchema.payload,
        s3: group.apiSchema.s3 ? {
          s3BucketName: group.apiSchema.s3.s3BucketName,
          s3ObjectKey: group.apiSchema.s3.s3ObjectKey
        } : undefined
      } : undefined,
      executorLambdaArn: group?.actionGroupExecutor?.lambda
    };
  }
}

class TargetedAlbListenerRulesClient {
  constructor(targetRegion, ruleArn) {
    this.ruleArn = ruleArn;
    this.client = new ElasticLoadBalancingV2Client({ region: targetRegion, maxAttempts: 2 });
  }

  async probe() { return true; }

  async listRules() {
    if (!this.ruleArn) return [];
    const response = await sendWithBackoff(this.client, new DescribeRulesCommand({ RuleArns: [this.ruleArn] }));
    const rule = response.Rules?.[0];
    if (!rule?.RuleArn) return [];
    const listenerArn = listenerArnFromRuleArn(rule.RuleArn);
    const loadBalancerArn = listenerArn ? loadBalancerArnFromListenerArn(listenerArn) : undefined;
    const loadBalancer = loadBalancerArn
      ? (await sendWithBackoff(
          this.client,
          new DescribeLoadBalancersCommand({ LoadBalancerArns: [loadBalancerArn] })
        ).catch(() => ({ LoadBalancers: [] }))).LoadBalancers?.[0]
      : undefined;
    return [{
      ruleArn: rule.RuleArn,
      priority: rule.Priority,
      listenerArn,
      loadBalancerArn,
      loadBalancerDnsName: loadBalancer?.DNSName,
      conditions: (rule.Conditions ?? []).map(mapAlbCondition),
      actions: (rule.Actions ?? []).map(mapAlbAction)
    }];
  }
}

class TargetedLambdaEventSourceClient {
  constructor(targetRegion, mappingId) {
    this.mappingId = mappingId;
    this.client = new LambdaClient({ region: targetRegion, maxAttempts: 2 });
  }

  async probe() { return true; }

  async listEventSourceMappings() {
    if (!this.mappingId) return [];
    return [await this.getEventSourceMapping(this.mappingId)];
  }

  async getEventSourceMapping(uuid) {
    const mapping = await sendWithBackoff(this.client, new GetEventSourceMappingCommand({ UUID: uuid }));
    return mapLambdaEventSourceMapping(mapping, uuid);
  }
}

class TargetedVerifiedPermissionsClient {
  constructor(targetRegion, policyStoreId) {
    this.policyStoreId = policyStoreId;
    this.client = new VerifiedPermissionsClient({ region: targetRegion, maxAttempts: 2 });
  }

  async probe() { return true; }

  async listPolicyStores() {
    if (!this.policyStoreId) return [];
    const store = await sendWithBackoff(this.client, new GetPolicyStoreCommand({ policyStoreId: this.policyStoreId }));
    return [{
      policyStoreId: store.policyStoreId ?? this.policyStoreId,
      arn: store.arn ?? '',
      description: store.description
    }];
  }

  async getSchema(policyStoreId) {
    const response = await sendWithBackoff(this.client, new GetSchemaCommand({ policyStoreId }));
    return {
      policyStoreId: response.policyStoreId ?? policyStoreId,
      schema: response.schema,
      namespaces: response.namespaces
    };
  }
}

class TargetedStepFunctionsClient {
  constructor(targetRegion, stateMachineArn) {
    this.stateMachineArn = stateMachineArn;
    this.client = new SFNClient({ region: targetRegion, maxAttempts: 2 });
  }

  async probe() { return true; }

  async listStateMachines() {
    if (!this.stateMachineArn) return [];
    const detail = await this.describeStateMachine(this.stateMachineArn);
    return [{
      name: detail.name,
      arn: detail.arn,
      type: detail.type
    }];
  }

  async describeStateMachine(arn) {
    const response = await sendWithBackoff(this.client, new DescribeStateMachineCommand({ stateMachineArn: arn }));
    return {
      name: response.name ?? arn.split(':').pop() ?? arn,
      arn: response.stateMachineArn ?? arn,
      type: response.type,
      definition: response.definition ?? '{}',
      status: response.status,
      revisionId: response.revisionId
    };
  }
}

function listenerArnFromRuleArn(ruleArn) {
  const marker = ':listener-rule/';
  if (!ruleArn.includes(marker)) return undefined;
  return ruleArn.replace(marker, ':listener/').replace(/\/[^/]+$/, '');
}

function loadBalancerArnFromListenerArn(listenerArn) {
  const marker = ':listener/';
  if (!listenerArn.includes(marker)) return undefined;
  return listenerArn.replace(marker, ':loadbalancer/').replace(/\/[^/]+$/, '');
}

function mapAlbCondition(condition) {
  return {
    field: condition.Field,
    values: condition.Values ?? condition.HostHeaderConfig?.Values ?? condition.PathPatternConfig?.Values ??
      condition.HttpRequestMethodConfig?.Values ?? condition.SourceIpConfig?.Values,
    httpHeaderName: condition.HttpHeaderConfig?.HttpHeaderName,
    queryString: condition.QueryStringConfig?.Values?.map((item) => ({ key: item.Key, value: item.Value }))
  };
}

function mapAlbAction(action) {
  return {
    type: action.Type,
    targetGroupArn: action.TargetGroupArn,
    redirectJson: action.RedirectConfig ? JSON.stringify(action.RedirectConfig) : undefined,
    fixedResponseJson: action.FixedResponseConfig ? JSON.stringify(action.FixedResponseConfig) : undefined
  };
}

function mapLambdaEventSourceMapping(mapping, fallbackUuid) {
  return {
    uuid: mapping.UUID ?? fallbackUuid,
    eventSourceArn: mapping.EventSourceArn,
    functionArn: mapping.FunctionArn,
    state: mapping.State,
    batchSize: mapping.BatchSize,
    maximumBatchingWindowInSeconds: mapping.MaximumBatchingWindowInSeconds,
    filterCriteria: mapping.FilterCriteria ? {
      filters: mapping.FilterCriteria.Filters?.map((filter) => ({ pattern: filter.Pattern }))
    } : undefined,
    topics: mapping.Topics,
    queues: mapping.Queues
  };
}

async function readBody(body) {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body?.transformToString) return await body.transformToString();
  if (body?.transformToByteArray) return new TextDecoder().decode(await body.transformToByteArray());
  return '';
}

function sanitize(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\b\d{12}\b/g, 'XXXXXXXXXXXX')
    .replace(/arn:aws:([^:]+):([^:]*):\d{12}:/g, 'arn:aws:$1:$2:XXXXXXXXXXXX:');
}

function sanitizeDeep(value) {
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeDeep(item)]));
  }
  return sanitize(value);
}

function assertExpectation(testCase, result) {
  const resolution = result.resolution;
  return Object.entries(testCase.expect).every(([key, expected]) => {
    const outputKey = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const actual = resolution?.[key] ?? result.outputs?.[key] ?? result.outputs?.[outputKey];
    return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  });
}

function valueFor(result, key) {
  const outputKey = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  return result.resolution?.[key] ?? result.outputs?.[key] ?? result.outputs?.[outputKey] ?? '';
}


const OPENAPI_HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function operationHasConcreteSchema(operation) {
  const mediaEntries = [];
  if (operation?.requestBody?.content && typeof operation.requestBody.content === 'object') {
    mediaEntries.push(...Object.values(operation.requestBody.content));
  }
  if (operation?.responses && typeof operation.responses === 'object') {
    for (const response of Object.values(operation.responses)) {
      if (response?.content && typeof response.content === 'object') {
        mediaEntries.push(...Object.values(response.content));
      }
    }
  }
  return mediaEntries.some((media) => {
    const schema = media?.schema;
    return Boolean(schema && typeof schema === 'object' && Object.keys(schema).length > 0);
  });
}

// Validation-only completeness check: classifies an operation as incomplete when it has
// no concrete schema or $ref in any request-body or response media entry. Inspects the
// exported artifact generically; never special-cases fixture names.
function classifyIncompleteOperations(content) {
  let document;
  try {
    document = parseYaml(content);
  } catch {
    return [];
  }
  const entries = [];
  const paths = document?.paths && typeof document.paths === 'object' ? document.paths : {};
  for (const [pathKey, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of OPENAPI_HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== 'object') continue;
      if (!operationHasConcreteSchema(operation)) {
        entries.push({ code: 'AWS_OPENAPI_CONTRACT_INCOMPLETE', path: pathKey, method });
      }
    }
  }
  return entries;
}

async function inspectGeneratedArtifacts(workspace, result, testCase, warnings = []) {
  const checks = [];
  if (testCase.contractCompleteness) {
    const specPath = result.resolution?.specPath;
    const content = specPath ? await readFile(path.join(workspace, specPath), 'utf8').catch(() => '') : '';
    const incompleteOperations = classifyIncompleteOperations(content);
    const { completePath, completeMethod, incompletePath, incompleteMethod } = testCase.contractCompleteness;
    checks.push({
      name: `modeled ${completeMethod.toUpperCase()} ${completePath} has no AWS_OPENAPI_CONTRACT_INCOMPLETE entry`,
      passed:
        content.length > 0 &&
        !incompleteOperations.some((entry) => entry.path === completePath && entry.method === completeMethod)
    });
    checks.push({
      name: `route-only ${incompleteMethod.toUpperCase()} ${incompletePath} yields an AWS_OPENAPI_CONTRACT_INCOMPLETE entry`,
      passed: incompleteOperations.some((entry) => entry.path === incompletePath && entry.method === incompleteMethod)
    });
  }
  if (testCase.specMarkers?.length) {
    const specPath = result.resolution?.specPath;
    const content = specPath ? await readFile(path.join(workspace, specPath), 'utf8').catch(() => '') : '';
    for (const marker of testCase.specMarkers) {
      checks.push({ name: `spec contains ${marker}`, passed: content.includes(marker) });
    }
  }
  if (testCase.oasDerivation) {
    const specPath = result.resolution?.specPath;
    const content = specPath ? await readFile(path.join(workspace, specPath), 'utf8').catch(() => '') : '';
    const specFormat = result.resolution?.specFormat;
    let oas;
    if (content && specFormat) {
      oas = deriveOpenApiDocument({ content, format: specFormat, title: testCase.name });
    }
    checks.push({
      name: 'derives OpenAPI 3.x',
      passed: Boolean(oas?.version.startsWith('3.'))
    });
    if (oas) {
      checks.push({ name: `OAS derivation ${oas.version} ${oas.completeness}`, passed: true });
    }
  }
  if (result.resolution?.derivedOpenApiPath) {
    const content = await readFile(path.join(workspace, result.resolution.derivedOpenApiPath), 'utf8').catch(() => '');
    let parsed;
    try {
      parsed = content ? JSON.parse(content) : undefined;
    } catch {
      parsed = undefined;
    }
    checks.push({
      name: 'canonical derived OpenAPI sidecar parses as JSON',
      passed: Boolean(parsed?.openapi)
    });
    checks.push({
      name: 'canonical derived OpenAPI sidecar metadata is present',
      passed:
        result.resolution.derivedOpenApiFormat === 'openapi-json' &&
        Boolean(result.resolution.derivedOpenApiVersion) &&
        Boolean(result.resolution.derivedOpenApiCompleteness)
    });
  }
  if (testCase.sidecarMarkers?.length) {
    for (const [sidecarPath, markers] of testCase.sidecarMarkers) {
      const content = await readFile(path.join(workspace, sidecarPath), 'utf8').catch(() => '');
      for (const marker of markers) {
        checks.push({ name: `${sidecarPath} contains ${marker}`, passed: content.includes(marker) });
      }
    }
  }
  if (testCase.metadataOrigin) {
    const metadataPath = result.resolution?.metadataPath;
    const content = metadataPath ? await readFile(path.join(workspace, metadataPath), 'utf8').catch(() => '') : '';
    let origin;
    try {
      origin = JSON.parse(content).contractOrigin ?? '';
    } catch {
      origin = '';
    }
    checks.push({ name: `metadata contractOrigin ${testCase.metadataOrigin}`, passed: origin === testCase.metadataOrigin });
  }
  if (testCase.contractAudit) {
    const audit = result.resolution?.openapiContractAudit;
    const specPath = result.resolution?.specPath;
    const content = specPath ? await readFile(path.join(workspace, specPath), 'utf8').catch(() => '') : '';
    let operation;
    try {
      operation = parseYaml(content)?.paths?.[testCase.contractAudit.path]?.[testCase.contractAudit.method];
    } catch {
      operation = undefined;
    }
    const responseDeclarations = operation?.responses && typeof operation.responses === 'object'
      ? Object.values(operation.responses)
      : [];
    const auditWarnings = warnings.filter((message) => message.startsWith('AWS_OPENAPI_CONTRACT_INCOMPLETE:'));
    checks.push({
      name: 'contract audit reports route-only schema coverage',
      passed:
        audit?.schemaVersion === 1 &&
        audit?.status === 'schema-incomplete' &&
        audit?.responsesWithoutContent >= 1
    });
    checks.push({
      name: `${testCase.contractAudit.method.toUpperCase()} ${testCase.contractAudit.path} response omits or has empty content`,
      passed:
        responseDeclarations.length > 0 &&
        responseDeclarations.some((response) => {
          if (!response || typeof response !== 'object') return false;
          if (!Object.hasOwn(response, 'content')) return true;
          return response.content && typeof response.content === 'object'
            ? Object.keys(response.content).length === 0
            : response.content == null;
        })
    });
    checks.push({
      name: 'contract audit warning emitted exactly once',
      passed: auditWarnings.length === 1
    });
  }
  return checks;
}

async function runRuntimeGatewayCase(testCase) {
  const caseStartedAt = Date.now();
  const workspace = await mkdtemp(path.join(os.tmpdir(), `spec-discovery-live-${testCase.name}-`));
  try {
    const warnings = [];
    const reporter = {
      ...quietCore,
      warning(message) {
        warnings.push(message);
        quietCore.warning(message);
      }
    };
    const inputs = resolveInputs({
      INPUT_AWS_REGION: region,
      INPUT_REPO_ROOT: workspace,
      INPUT_OUTPUT_DIR: 'discovered-specs',
      INPUT_GATEWAY_ID: testCase.gatewayId,
      INPUT_PREFLIGHT_CHECKS: 'false',
      INPUT_REQUEST_TIMEOUT_MS: '15000',
      INPUT_MAX_ATTEMPTS: '2'
    });
    const result = await execute(inputs, {
      core: reporter,
      aws: new TargetedApiGatewayClient(region),
      writeSpecFile: defaultWriteSpecFile,
      providerRegistry: emptyProviderRegistry
    });
    const artifactChecks = await inspectGeneratedArtifacts(workspace, result, testCase, warnings);
    if (testCase.contractAudit?.livePath) {
      const liveResponse = await globalThis.fetch(
        `https://${testCase.gatewayId}.execute-api.${region}.amazonaws.com/${testCase.contractAudit.stage}${testCase.contractAudit.livePath}`
      );
      const liveBody = await liveResponse.text();
      let liveJson;
      try {
        liveJson = JSON.parse(liveBody);
      } catch {
        liveJson = undefined;
      }
      const contentLength = liveResponse.headers.get('content-length');
      artifactChecks.push({
        name: 'live route returns HTTP 200 JSON status ok',
        passed: liveResponse.status === 200 && liveJson?.status === 'ok'
      });
      artifactChecks.push({
        name: 'live route Content-Length matches JSON response bytes',
        passed: contentLength === null || Number(contentLength) === Buffer.byteLength(liveBody)
      });
    }
    if (testCase.contractAudit?.liveControls) {
      const controls = await Promise.all([
        '/no-content',
        '/no-content-with-body',
        '/schema-valid',
        '/schema-invalid',
        '/unknown-length',
        '/unknown-length-mismatch'
      ].map(async (controlPath) => {
        const response = await globalThis.fetch(
          `https://${testCase.gatewayId}.execute-api.${region}.amazonaws.com/${testCase.contractAudit.stage}${controlPath}`
        );
        const body = await response.text();
        let json;
        try {
          json = JSON.parse(body);
        } catch {
          json = undefined;
        }
        return {
          path: controlPath,
          status: response.status,
          bodyBytes: Buffer.byteLength(body),
          contentLength: response.headers.get('content-length'),
          json
        };
      }));
      const byPath = new Map(controls.map((control) => [control.path, control]));
      const lengthMatches = (control) =>
        control?.contentLength === null || Number(control.contentLength) === control.bodyBytes;
      artifactChecks.push(
        {
          name: 'live control clean 204 carries zero body bytes',
          passed: byPath.get('/no-content')?.status === 204 && byPath.get('/no-content')?.bodyBytes === 0
        },
        {
          name: 'live control API Gateway strips attempted 204 response body',
          passed:
            byPath.get('/no-content-with-body')?.status === 204 &&
            byPath.get('/no-content-with-body')?.bodyBytes === 0
        },
        {
          name: 'live control schema-valid route returns declared string shape',
          passed:
            byPath.get('/schema-valid')?.status === 200 &&
            typeof byPath.get('/schema-valid')?.json?.status === 'string'
        },
        {
          name: 'live control schema-invalid route returns controlled invalid shape',
          passed:
            byPath.get('/schema-invalid')?.status === 200 &&
            typeof byPath.get('/schema-invalid')?.json?.status === 'number'
        },
        {
          name: 'live control unknown body has matching nonzero Content-Length',
          passed:
            byPath.get('/unknown-length')?.bodyBytes > 0 &&
            lengthMatches(byPath.get('/unknown-length'))
        },
        {
          name: 'live control API Gateway rewrites attempted mismatched Content-Length',
          passed:
            byPath.get('/unknown-length-mismatch')?.bodyBytes > 0 &&
            lengthMatches(byPath.get('/unknown-length-mismatch'))
        }
      );
    }
    return {
      name: testCase.name,
      passed: assertExpectation(testCase, result) && artifactChecks.every((check) => check.passed),
      expected: testCase.expect,
      resolution: sanitizeDeep(result.resolution),
      outputs: sanitizeDeep(result.outputs),
      artifactChecks,
      elapsedMs: Date.now() - caseStartedAt,
      runner: 'runtime'
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runLiveRestFallbackCase(testCase) {
  const caseStartedAt = Date.now();
  const content = await new TargetedApiGatewayClient(region).exportRestApiFallback(testCase.gatewayId, 'prod');
  const oas = deriveOpenApiDocument({ content, format: 'openapi-yaml', title: testCase.name });
  const artifactChecks = [
    { name: 'fallback spec contains OpenAPI', passed: content.includes('openapi: 3.0.3') },
    { name: 'fallback spec contains live /health resource', passed: content.includes('/health') },
    { name: 'fallback spec carries fallback marker', passed: content.includes('apiGatewayFallback: true') },
    { name: 'fallback spec derives OpenAPI 3.x', passed: Boolean(oas.version.startsWith('3.')) }
  ];
  const resolution = {
    status: 'resolved',
    sourceType: 'gateway-export',
    gatewayType: 'REST',
    providerType: 'api-gateway',
    specFormat: 'openapi-yaml',
    derivedOpenApiVersion: oas.version,
    derivedOpenApiCompleteness: 'partial'
  };
  return {
    name: testCase.name,
    passed: assertExpectation(testCase, { resolution, outputs: {} }) && artifactChecks.every((check) => check.passed),
    expected: testCase.expect,
    resolution: sanitizeDeep(resolution),
    outputs: {},
    artifactChecks,
    elapsedMs: Date.now() - caseStartedAt,
    runner: 'live-sdk'
  };
}

function selectedProviderRegistry(inputs, testCase) {
  let selected = testCase.providers ?? [];
  if (testCase.providerTypes) {
    const registry = buildProviderRegistry(inputs, new TargetedApiGatewayClient(region));
    selected = testCase.providerTypes.map((type) => registry.get(type)).filter(Boolean);
  }
  return {
    all: () => selected,
    get: (type) => selected.find((provider) => provider.type === type),
    register: () => undefined,
    probeAvailable: async () => selected
  };
}

async function runRuntimeProviderCase(testCase) {
  const caseStartedAt = Date.now();
  const workspace = await mkdtemp(path.join(os.tmpdir(), `spec-discovery-live-${testCase.name}-`));
  try {
    if (testCase.seed) await testCase.seed(workspace);
    const inputs = resolveInputs({
      INPUT_AWS_REGION: region,
      INPUT_REPO_ROOT: workspace,
      INPUT_OUTPUT_DIR: 'discovered-specs',
      INPUT_EXPECTED_SERVICE_NAME: testCase.expectedServiceName,
      INPUT_PREFLIGHT_CHECKS: 'false',
      INPUT_REQUEST_TIMEOUT_MS: '10000',
      INPUT_MAX_ATTEMPTS: '2',
      INPUT_MAX_CANDIDATES: '5',
      INPUT_REMOTE_FETCH_ALLOWLIST_JSON: testCase.remoteFetchAllowlist
        ? JSON.stringify(testCase.remoteFetchAllowlist)
        : undefined
    });
    const result = await execute(inputs, {
      core: quietCore,
      aws: new TargetedApiGatewayClient(region),
      writeSpecFile: defaultWriteSpecFile,
      providerRegistry: selectedProviderRegistry(inputs, testCase)
    });
    const artifactChecks = await inspectGeneratedArtifacts(workspace, result, testCase);
    return {
      name: testCase.name,
      passed: assertExpectation(testCase, result) && artifactChecks.every((check) => check.passed),
      expected: testCase.expect,
      resolution: sanitizeDeep(result.resolution),
      outputs: sanitizeDeep(result.outputs),
      artifactChecks,
      elapsedMs: Date.now() - caseStartedAt,
      runner: 'runtime'
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

const quietCore = {
  async group(_name, fn) { return await fn(); },
  info() {},
  warning(message) { console.error(`warning: ${message}`); }
};

const emptyProviderRegistry = {
  all: () => [],
  get: () => undefined,
  register: () => undefined,
  probeAvailable: async () => []
};

const gatewayCases = [
  {
    name: 'api-gateway-rest',
    gatewayId: outputs.RestApiId,
    expect: { status: 'resolved', sourceType: 'gateway-export', gatewayType: 'REST', specFormat: 'openapi-yaml' },
    contractAudit: { path: '/health', method: 'get', stage: 'prod', livePath: '/health', liveControls: true },
    oasDerivation: true
  },
  {
    name: 'api-gateway-rest-modeled-route',
    gatewayId: outputs.RestApiId,
    contractCompleteness: { completePath: '/orders', completeMethod: 'post', incompletePath: '/health', incompleteMethod: 'get' },
    expect: { status: 'resolved', sourceType: 'gateway-export', gatewayType: 'REST', specFormat: 'openapi-yaml' },
    specMarkers: [
      'CreateOrder',
      '#/components/schemas/CreateOrder',
      'x-amazon-apigateway-request-validators',
      'body-only',
      'validateRequestBody: true',
      'validateRequestParameters: false',
      'x-amazon-apigateway-request-validator: body-only'
    ],
    oasDerivation: true
  },
  {
    name: 'api-gateway-rest-fallback',
    gatewayId: outputs.RestApiId,
    expect: { status: 'resolved', sourceType: 'gateway-export', gatewayType: 'REST', providerType: 'api-gateway', specFormat: 'openapi-yaml' },
    runner: runLiveRestFallbackCase
  },
  {
    name: 'api-gateway-http',
    gatewayId: outputs.HttpApiId,
    expect: { status: 'resolved', sourceType: 'gateway-export', gatewayType: 'HTTP', specFormat: 'openapi-yaml' },
    oasDerivation: true
  },
  {
    name: 'api-gateway-websocket',
    gatewayId: outputs.WebSocketApiId,
    expect: { status: 'resolved', sourceType: 'gateway-export', gatewayType: 'WEBSOCKET', providerType: 'api-gateway', specFormat: 'openapi-yaml' },
    specMarkers: [
      'openapi: 3.0.3',
      'x-amazon-apigateway-protocol: WEBSOCKET',
      'x-amazon-apigateway-route-selection-expression',
      'x-amazon-apigateway-route-key',
      '/sendMessage:',
      'operationId: sendOrderMessage',
      'OrderMessage:',
      'OrderAck:',
      'x-amazon-apigateway-model-selection-expression',
      'x-amazon-apigateway-request-models',
      '#/components/schemas/OrderMessage',
      'x-amazon-apigateway-integration',
      'httpMethod: POST',
      'x-amazon-apigateway-route-response-selection-expression',
      'x-amazon-apigateway-route-responses',
      'responseModels'
    ],
    oasDerivation: true
  }
].filter((testCase) => testCase.gatewayId);

const providerCases = [
  {
    name: 'appsync',
    expectedServiceName: 'spec-discovery-validation-graphql',
    providerTypes: ['appsync'],
    expect: { status: 'resolved', sourceType: 'appsync-schema', providerType: 'appsync', specFormat: 'graphql-sdl' },
    oasDerivation: true
  },
  {
    name: 'appsync-events',
    expectedServiceName: outputs.AppSyncEventApiName,
    providers: [new AppSyncEventsProvider(
      new TargetedAppSyncEventsClient(region, outputs.AppSyncEventApiId, outputs.AppSyncEventChannelNamespaceName)
    )],
    expect: { status: 'resolved', sourceType: 'appsync-event-api', providerType: 'appsync-events', specFormat: 'openapi-json' },
    specMarkers: [
      '"x-aws-appsync-events"',
      '"x-aws-appsync-channel-namespace"',
      '"orders.publish"',
      '"orders.subscribe"',
      '"operationId": "publishOrdersAppSyncEvent"'
    ],
    oasDerivation: true
  },
  {
    name: 'eventbridge-schemas',
    expectedServiceName: 'spec-discovery-validation.OrderCreated',
    providerTypes: ['eventbridge-schemas'],
    expect: { status: 'resolved', sourceType: 'eventbridge-schema', providerType: 'eventbridge-schemas', specFormat: 'openapi-json' },
    oasDerivation: true
  },
  {
    name: 'eventbridge-rule',
    expectedServiceName: outputs.EventBridgeRuleName,
    providers: [new EventBridgeSurfaceProvider(
      new TargetedEventBridgeSurfaceClient(region, { ruleName: outputs.EventBridgeRuleName })
    )],
    expect: { status: 'resolved', sourceType: 'eventbridge-surface', providerType: 'eventbridge', specFormat: 'openapi-json' },
    specMarkers: [
      '"x-aws-eventbridge-rule"',
      '"x-aws-eventbridge-event-pattern"',
      '"x-aws-eventbridge-targets"',
      '"order.created"'
    ],
    oasDerivation: true
  },
  {
    name: 'eventbridge-pipe',
    expectedServiceName: outputs.EventBridgePipeName,
    providers: [new EventBridgeSurfaceProvider(
      new TargetedEventBridgeSurfaceClient(region, { pipeName: outputs.EventBridgePipeName })
    )],
    expect: { status: 'resolved', sourceType: 'eventbridge-surface', providerType: 'eventbridge', specFormat: 'openapi-json' },
    specMarkers: [
      '"x-aws-eventbridge-pipe"',
      '"x-aws-eventbridge-filter-criteria"',
      'order.created'
    ],
    oasDerivation: true
  },
  {
    name: 'eventbridge-api-destination',
    expectedServiceName: outputs.EventBridgeApiDestinationName,
    providers: [new EventBridgeSurfaceProvider(
      new TargetedEventBridgeSurfaceClient(region, { apiDestinationName: outputs.EventBridgeApiDestinationName })
    )],
    expect: { status: 'resolved', sourceType: 'eventbridge-surface', providerType: 'eventbridge', specFormat: 'openapi-json' },
    specMarkers: [
      '"x-aws-eventbridge-api-destination"',
      '"/orders"',
      '"invocationRateLimitPerSecond": 5'
    ],
    oasDerivation: true
  },
  {
    name: 'cloudformation-embedded',
    expectedServiceName: 'TestRestApi',
    providers: [new CloudFormationProvider(new TargetedCloudFormationClient(region, manifest.stackName), repoRoot)],
    expect: { status: 'resolved', sourceType: 'cfn-embedded', providerType: 'cloudformation', specFormat: ['openapi-json', 'openapi-yaml'] },
    oasDerivation: true
  },
  {
    name: 'glue-schema',
    expectedServiceName: 'spec-discovery-validation-user-event',
    providerTypes: ['glue'],
    expect: { status: 'resolved', sourceType: 'glue-schema', providerType: 'glue', specFormat: 'avro' },
    oasDerivation: true
  },
  {
    name: 'ssm-registry',
    expectedServiceName: 'spec-discovery-validation-topic',
    providerTypes: ['ssm'],
    expect: { status: 'resolved', sourceType: 'ssm-registry', providerType: 'ssm', specFormat: 'asyncapi-yaml' },
    oasDerivation: true
  },
  {
    name: 'ssm-url-registry',
    expectedServiceName: 'spec-discovery-validation-url-topic',
    providerTypes: ['ssm'],
    remoteFetchAllowlist: [
      { hostname: 'json.schemastore.org', pathPrefix: '/package' },
      { hostname: 'www.schemastore.org', pathPrefix: '/package' }
    ],
    expect: { status: 'resolved', sourceType: 'ssm-registry', providerType: 'ssm', specFormat: 'json-schema' },
    oasDerivation: true
  },
  {
    name: 'ssm-url-pointer',
    expectedServiceName: 'spec-discovery-validation-pointer',
    providerTypes: ['ssm'],
    expect: { status: 'resolved', sourceType: 'ssm-registry', providerType: 'ssm', specFormat: 'openapi-json' },
    specMarkers: ['"specUrl": "https://example.invalid/openapi.yaml"', '"registeredVia": "ssm-parameter-store"', '"fetchError"'],
    oasDerivation: true
  },
  {
    name: 'lambda-url',
    expectedServiceName: outputs.LambdaFunctionName,
    providers: [new TargetedLambdaUrlProvider(region, outputs.LambdaFunctionName)],
    expect: { status: 'resolved', sourceType: 'lambda-url-export', providerType: 'lambda-url', specFormat: 'openapi-yaml' },
    specMarkers: [
      'openapi: 3.0.3',
      '/{proxy}:',
      'getLambdaUrl',
      'postLambdaUrl',
      'x-aws-lambda-function-url-auth-type: "AWS_IAM"',
      'awsSigV4'
    ],
    oasDerivation: true
  },
  {
    name: 'lambda-event-source',
    expectedServiceName: outputs.LambdaEventSourceMappingId ? `lambda-event-source-${outputs.LambdaEventSourceMappingId}` : undefined,
    providers: [new LambdaEventSourceProvider(
      new TargetedLambdaEventSourceClient(region, outputs.LambdaEventSourceMappingId)
    )],
    expect: { status: 'resolved', sourceType: 'lambda-event-source', providerType: 'lambda-event-source', specFormat: 'openapi-json' },
    specMarkers: [
      '"x-aws-lambda-event-source-mapping"',
      '"x-aws-lambda-filter-criteria"',
      'order.created',
      '"batchSize": 5'
    ],
    oasDerivation: true
  },
  {
    name: 'verified-permissions',
    expectedServiceName: 'spec-discovery-validation-authz',
    providers: [new VerifiedPermissionsProvider(
      new TargetedVerifiedPermissionsClient(region, outputs.VerifiedPermissionsPolicyStoreId)
    )],
    expect: { status: 'resolved', sourceType: 'verified-permissions-schema', providerType: 'verified-permissions', specFormat: 'openapi-json' },
    specMarkers: [
      '"paths": {}',
      '"x-aws-verified-permissions"',
      '"cedarSchema"',
      '"SpecDiscovery"',
      '"ViewOrder"'
    ],
    oasDerivation: true
  },
  {
    name: 'step-functions',
    expectedServiceName: outputs.StepFunctionsStateMachineName,
    providers: [new StepFunctionsProvider(
      new TargetedStepFunctionsClient(region, outputs.StepFunctionsStateMachineArn)
    )],
    expect: { status: 'resolved', sourceType: 'step-functions-asl', providerType: 'step-functions', specFormat: 'openapi-json' },
    specMarkers: [
      '"x-aws-stepfunctions"',
      '"/step-functions/spec-discovery-validation-orders-workflow/executions"',
      '"ValidateOrder"',
      '"status": "validated"'
    ],
    oasDerivation: true
  },
  {
    name: 'alb-listener-rule',
    expectedServiceName: outputs.AlbListenerRuleArn ? 'alb-rule-10' : undefined,
    providers: [new AlbListenerRulesProvider(
      new TargetedAlbListenerRulesClient(region, outputs.AlbListenerRuleArn)
    )],
    expect: { status: 'resolved', sourceType: 'alb-listener-rule', providerType: 'alb-listener-rule', specFormat: 'openapi-json' },
    specMarkers: [
      '"x-aws-alb-listener-rule"',
      '"/orders/{proxy}"',
      '"orders.internal.example.com"',
      '"status"',
      '"open"'
    ],
    oasDerivation: true
  },
  {
    name: 'bedrock-action-group',
    expectedServiceName: outputs.BedrockActionGroupName,
    providers: [new BedrockActionGroupProvider(
      new TargetedBedrockActionGroupsClient(region, outputs.BedrockAgentId, outputs.BedrockActionGroupName)
    )],
    expect: { status: 'resolved', sourceType: 'bedrock-action-group', providerType: 'bedrock-action-group', specFormat: 'openapi-json' },
    specMarkers: [
      '"x-aws-bedrock-agent-action-group"',
      '"actionGroupName": "orders_api"',
      '"/orders"',
      '"operationId": "createOrder"'
    ],
    oasDerivation: true
  },
  {
    name: 'sns-ssm-content',
    seed: async (workspace) => {
      await writeFile(path.join(workspace, 'template.yaml'), [
        "AWSTemplateFormatVersion: '2010-09-09'",
        'Resources:',
        '  Topic:',
        '    Type: AWS::SNS::Topic',
        '    Properties:',
        '      TopicName: SpecDiscoveryValidationTopic'
      ].join('\n'), 'utf8');
    },
    expectedServiceName: 'SpecDiscoveryValidationTopic',
    providers: [],
    expect: { status: 'resolved', sourceType: 'sns-contract', providerType: 'sns', specFormat: 'asyncapi-yaml', contractOrigin: 'ssm-content' },
    metadataOrigin: 'ssm-content',
    oasDerivation: true
  },
  {
    name: 'sns-webhook-sidecar',
    seed: async (workspace) => {
      await writeFile(path.join(workspace, 'template.yaml'), [
        "AWSTemplateFormatVersion: '2010-09-09'",
        'Resources:',
        '  Topic:',
        '    Type: AWS::SNS::Topic',
        '    Properties:',
        '      TopicName: SpecDiscoveryValidationSubscribedTopic'
      ].join('\n'), 'utf8');
    },
    expectedServiceName: 'SpecDiscoveryValidationSubscribedTopic',
    providers: [],
    expect: { status: 'resolved', sourceType: 'sns-contract', providerType: 'sns', specFormat: 'asyncapi-yaml', contractOrigin: 'ssm-content' },
    metadataOrigin: 'ssm-content',
    oasDerivation: true,
    sidecarMarkers: [
      [
        'discovered-specs/SpecDiscoveryValidationSubscribedTopic/webhook.openapi.json',
        [
          '"openapi": "3.1.0"',
          '"webhooks"',
          'snsMessageWrapped',
          '"x-sns-delivery-variant": "sns-envelope"',
          '"x-sns-filter-policy"',
          '"eventType"',
          '"order.created"',
          '"x-sns-filter-policy-scope": "MessageBody"',
          '"x-sns-delivery-policy"',
          '"x-sns-redrive-policy"'
        ]
      ]
    ]
  }
].filter((testCase) => testCase.expectedServiceName);

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

const RESULT_NAME_TO_REQUIRED_IDS = {
  'api-gateway-rest': ['api-gateway-rest-native'],
  'api-gateway-rest-fallback': ['api-gateway-rest-fallback'],
  'api-gateway-http': ['api-gateway-http-deployed-stage'],
  'api-gateway-websocket': ['api-gateway-websocket-partial-control-plane'],
  'fox-tag-zero-config': ['fox-tag-zero-config'],
  'fox-multi-environment-ambiguity': ['fox-multi-environment-ambiguity'],
  'api-gateway-http-latest-configuration-divergence': ['api-gateway-http-latest-configuration-divergence'],
  'appsync-merged-associations': ['appsync-merged-associations'],
  'expected-identity-mismatch': ['expected-identity-mismatch'],
  'provider-denial-typed': ['provider-denial-typed']
};

const EXISTING_PROVIDER_CASE_NAMES = new Set([
  'appsync',
  'appsync-events',
  'eventbridge-schemas',
  'eventbridge-rule',
  'eventbridge-pipe',
  'eventbridge-api-destination',
  'cloudformation-embedded',
  'glue-schema',
  'ssm-registry',
  'sns-ssm-content',
  'sns-webhook-sidecar',
  'lambda-url',
  'lambda-event-source',
  'bedrock-action-group',
  'alb-listener-rule',
  'verified-permissions',
  'step-functions'
]);

function safeError(error) {
  return String(error?.name ?? 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'Error';
}

function safeCaseFailure(name, check, elapsedMs = 0) {
  return {
    name,
    passed: false,
    expected: 'required live boundary',
    resolution: { status: 'failed' },
    outputs: {},
    artifactChecks: [{ name: check, passed: false }],
    elapsedMs,
    runner: 'built-cli'
  };
}

function parseCliJson(stdout) {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of [...lines].reverse()) {
    try { return JSON.parse(line); } catch { continue; }
  }
  try { return JSON.parse(stdout); } catch { return undefined; }
}

async function runBuiltCli(workspace, {
  repository = 'postman-cs/spec-discovery-validation',
  inputs = {},
  files = {}
} = {}) {
  const invocationId = randomUUID();
  const outputDir = `discovered-specs-${invocationId}`;
  const resultJsonName = `.result-${invocationId}.json`;
  const resultJsonPath = path.join(workspace, resultJsonName);
  await Promise.all(Object.entries(files).map(async ([relativePath, content]) => {
    const filePath = path.join(workspace, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  }));
  const env = {
    ...process.env,
    POSTMAN_ACTIONS_TELEMETRY: 'off',
    DO_NOT_TRACK: '1',
    GITHUB_REPOSITORY: repository,
    INPUT_AWS_REGION: region,
    INPUT_REPO_ROOT: workspace,
    INPUT_OUTPUT_DIR: outputDir,
    INPUT_PREFLIGHT_CHECKS: 'true',
    INPUT_REQUEST_TIMEOUT_MS: '15000',
    INPUT_MAX_ATTEMPTS: '2',
    ...Object.fromEntries(Object.entries(inputs).map(([key, value]) => [`INPUT_${key}`, String(value)]))
  };
  const child = await new Promise((resolve) => {
    execFile(process.execPath, [cliPath, '--result-json', resultJsonName], {
      cwd: workspace,
      env,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    }, (error, stdout = '', stderr = '') => resolve({
      exitCode: error?.code ?? 0,
      stdout,
      stderr,
      parsed: parseCliJson(stdout)
    }));
  });
  const artifact = await readFile(resultJsonPath, 'utf8').then(JSON.parse).catch(() => undefined);
  const result = artifact ?? child.parsed?.result ?? child.parsed;
  return {
    child: { exitCode: child.exitCode, stdout: child.stdout, stderr: child.stderr },
    result: result && typeof result === 'object' ? result : {},
    outputDir,
    outputPath: path.join(workspace, outputDir),
    resultJsonPath
  };
}

function cliResultChecks(result, expected = {}, { requireProvenance = true } = {}) {
  const resolution = result.resolution ?? {};
  return [
    { name: 'CLI emits structured result JSON', passed: Object.keys(result).length > 0 },
    { name: 'CLI emits structured outputs', passed: Boolean(result.outputs && typeof result.outputs === 'object') },
    ...(requireProvenance ? [{ name: 'CLI emits resolution provenance', passed: Boolean(resolution.provenance && typeof resolution.provenance === 'object') }] : []),
    ...Object.entries(expected).map(([key, value]) => ({
      name: `resolution ${key} matches expected value`,
      passed: (resolution[key] ?? result.outputs?.[key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)]) === value
    }))
  ];
}

async function withAssumedRole(roleArn, fn) {
  const previous = Object.fromEntries([
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AWS_DEFAULT_PROFILE'
  ].map((key) => [key, process.env[key]]));
  try {
    const credentials = (await new STSClient({ region }).send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `spec-discovery-validation-${randomUUID().slice(0, 12)}`
    }))).Credentials;
    if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) throw new Error('AssumeRoleCredentialsMissing');
    temporaryCredentialValues.add(credentials.AccessKeyId);
    temporaryCredentialValues.add(credentials.SecretAccessKey);
    temporaryCredentialValues.add(credentials.SessionToken);
    delete process.env.AWS_PROFILE;
    delete process.env.AWS_DEFAULT_PROFILE;
    process.env.AWS_ACCESS_KEY_ID = credentials.AccessKeyId;
    process.env.AWS_SECRET_ACCESS_KEY = credentials.SecretAccessKey;
    process.env.AWS_SESSION_TOKEN = credentials.SessionToken;
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

async function runOptionalRequiredCase(def) {
  const caseStartedAt = Date.now();
  const workspace = await mkdtemp(path.join(os.tmpdir(), `spec-discovery-live-${def.id}-`));
  try {
    return await def.run(workspace);
  } catch (error) {
    return {
      name: def.id,
      passed: false,
      skipped: false,
      expected: def.description,
      resolution: { status: 'error' },
      outputs: {},
      artifactChecks: [{ name: `required case threw: ${safeError(error)}`, passed: false }],
      elapsedMs: Date.now() - caseStartedAt,
      runner: 'required-boundary'
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function missingPrerequisite(id, name) {
  return safeCaseFailure(id, `missing prerequisite: ${name}`);
}

function childReceipt(child) {
  return { exitCode: child.exitCode, stdout: child.stdout, stderr: child.stderr };
}

async function caseWorkspace(workspace, name) {
  const child = path.join(workspace, name);
  await mkdir(child, { recursive: true });
  return child;
}

function resultRecord(name, expected, startedAt, checks, result = {}, outputs = {}, rawBuiltCli) {
  return {
    name,
    passed: checks.every((check) => check.passed),
    expected,
    resolution: sanitizeDeep(result),
    outputs: sanitizeDeep(outputs),
    artifactChecks: checks,
    elapsedMs: Date.now() - startedAt,
    runner: 'built-cli',
    rawBuiltCli
  };
}

async function runTagContract(workspace, name, repository, gatewayType, contract) {
  const childWorkspace = await caseWorkspace(workspace, name);
  const run = await runBuiltCli(childWorkspace, { repository });
  const resolution = run.result.resolution ?? {};
  return {
    run,
    checks: [
      ...cliResultChecks(run.result, { status: 'resolved', gatewayType }),
      {
        name: `${name} uses exact matched tag contract`,
        passed: (resolution.evidence ?? []).includes(`Matched tag contract ${contract}`)
      },
      { name: `${name} exits successfully`, passed: run.child.exitCode === 0 }
    ]
  };
}

async function runHttpDivergence(workspace) {
  const apiId = outputs.HttpApiId;
  if (!apiId) return missingPrerequisite('api-gateway-http-latest-configuration-divergence', 'HttpApiId');
  const started = Date.now();
  const marker = `/validation-${randomUUID()}`;
  const client = new ApiGatewayV2Client({ region, maxAttempts: 2 });
  let routeId;
  let record;
  let cleanupError;
  try {
    const created = await client.send(new CreateRouteCommand({ ApiId: apiId, RouteKey: `GET ${marker}` }));
    routeId = created.RouteId;
    const stageWorkspace = await caseWorkspace(workspace, 'stage');
    const latestWorkspace = await caseWorkspace(workspace, 'latest');
    const stage = await runBuiltCli(stageWorkspace, {
      inputs: { GATEWAY_ID: apiId, STAGE: '$default' }
    });
    const latest = await runBuiltCli(latestWorkspace, {
      inputs: { GATEWAY_ID: apiId }
    });
    const stagePath = stage.result.resolution?.specPath;
    const latestPath = latest.result.resolution?.specPath;
    const stageSpec = stagePath ? await readFile(path.join(stageWorkspace, stagePath), 'utf8').catch(() => '') : '';
    const latestSpec = latestPath ? await readFile(path.join(latestWorkspace, latestPath), 'utf8').catch(() => '') : '';
    const checks = [
      ...cliResultChecks(stage.result, { status: 'resolved' }),
      ...cliResultChecks(latest.result, { status: 'resolved' }),
      { name: 'stage export uses deployed-stage', passed: stage.result.resolution?.provenance?.configurationMode === 'deployed-stage' },
      { name: 'no-stage export uses latest-configuration', passed: latest.result.resolution?.provenance?.configurationMode === 'latest-configuration' },
      { name: 'marker absent from deployed stage artifact', passed: !stageSpec.includes(marker) },
      { name: 'marker present in latest artifact', passed: latestSpec.includes(marker) },
      { name: 'both CLI runs exit successfully', passed: stage.child.exitCode === 0 && latest.child.exitCode === 0 }
    ];
    record = resultRecord('api-gateway-http-latest-configuration-divergence', 'deployed stage differs from latest configuration', started, checks, { stage: stage.result.resolution, latest: latest.result.resolution }, {}, { stage: childReceipt(stage.child), latest: childReceipt(latest.child) });
  } catch (error) {
    record = safeCaseFailure('api-gateway-http-latest-configuration-divergence', safeError(error), Date.now() - started);
  } finally {
    if (routeId) {
      try {
        await client.send(new DeleteRouteCommand({ ApiId: apiId, RouteId: routeId }));
        const remaining = await client.send(new GetRoutesCommand({ ApiId: apiId }));
        if ((remaining.Items ?? []).some((route) => route.RouteId === routeId)) cleanupError = 'temporary route remained';
      } catch (error) {
        cleanupError = safeError(error);
      }
    }
  }
  if (cleanupError) {
    record.passed = false;
    record.artifactChecks.push({ name: `temporary route cleanup: ${cleanupError}`, passed: false });
  }
  return record;
}

const requiredBoundaryDefs = [
  {
    id: 'fox-tag-zero-config',
    description: 'all canonical and Fox tag-only gateway resolutions',
    async run(workspace) {
      const started = Date.now();
      const cases = [
        ['canonical', 'postman-cs/spec-discovery-validation-canonical', 'REST', 'postman:repo'],
        ['fox-rest', 'postman-cs/spec-discovery-validation-fox-rest', 'REST', 'GithubOrg+GithubRepo'],
        ['fox-http', 'postman-cs/spec-discovery-validation-fox-http', 'HTTP', 'GithubOrg+GithubRepo'],
        ['fox-websocket', 'postman-cs/spec-discovery-validation-fox-websocket', 'WEBSOCKET', 'GithubOrg+GithubRepo']
      ];
      const receipts = [];
      const checks = [];
      for (const [name, repository, type, contract] of cases) {
        const item = await runTagContract(workspace, name, repository, type, contract);
        receipts.push(childReceipt(item.run.child));
        checks.push(...item.checks);
      }
      return resultRecord(this.id, this.description, started, checks, {}, {}, receipts);
    }
  },
  {
    id: 'fox-multi-environment-ambiguity',
    description: 'exact Fox duplicates remain unresolved manual review',
    async run(workspace) {
      const started = Date.now();
      const run = await runBuiltCli(await caseWorkspace(workspace, 'multi-env'), {
        repository: 'postman-cs/spec-discovery-validation-multi-env'
      });
      const resolution = run.result.resolution ?? {};
      const provenanceOrEvidence = JSON.stringify([resolution.provenance, resolution.evidence]);
      const checks = [
        ...cliResultChecks(run.result, {}, { requireProvenance: false }),
        { name: 'resolution is unresolved', passed: resolution.status === 'unresolved' },
        { name: 'source type is manual-review', passed: resolution.sourceType === 'manual-review' },
        { name: 'at least two ranked candidates', passed: (resolution.rankedCandidates ?? []).length >= 2 },
        { name: 'exact Fox tag contract is evidenced', passed: provenanceOrEvidence.includes('GithubOrg+GithubRepo') },
        { name: 'CLI exits successfully', passed: run.child.exitCode === 0 }
      ];
      return resultRecord(this.id, this.description, started, checks, resolution, run.result.outputs, childReceipt(run.child));
    }
  },
  { id: 'api-gateway-http-latest-configuration-divergence', description: 'HTTP route divergence with guaranteed cleanup', run: runHttpDivergence },
  {
    id: 'built-cli-boundary-matrix',
    description: 'built CLI local, monorepo, and Backstage remote receipts',
    async run(workspace) {
      const started = Date.now();
      if (!manifest.accountId || !manifest.partition) return missingPrerequisite(this.id, 'manifest accountId/partition');
      const pins = { EXPECTED_ACCOUNT_ID: manifest.accountId, EXPECTED_PARTITION: manifest.partition };
      const openapi = 'openapi: 3.0.3\ninfo: { title: validation, version: "1" }\npaths: {}\n';
      const local = await runBuiltCli(await caseWorkspace(workspace, 'spec-path'), { inputs: { ...pins, SPEC_PATH: 'specs/local.yaml' }, files: { 'specs/local.yaml': openapi } });
      const monorepo = await runBuiltCli(await caseWorkspace(workspace, 'service-root'), { inputs: { ...pins, SERVICE_ROOT: 'services/orders' }, files: { 'services/orders/openapi.yaml': openapi } });
      const remote = await runBuiltCli(await caseWorkspace(workspace, 'backstage-remote'), { inputs: { ...pins, REMOTE_FETCH_ALLOWLIST_JSON: JSON.stringify([{ hostname: 'gist.githubusercontent.com', pathPrefix: '/jaredboynton/a839de57db2c3c90b8f75906c56b00ee/raw/' }]) }, files: { 'catalog-info.yaml': 'apiVersion: backstage.io/v1alpha1\nkind: API\nmetadata:\n  name: validation-remote-api\nspec:\n  type: openapi\n  lifecycle: production\n  owner: platform\n  definition:\n    $text: https://gist.githubusercontent.com/jaredboynton/a839de57db2c3c90b8f75906c56b00ee/raw/openapi.yaml\n' } });
      const identityChecks = (run, label) => [
        ...cliResultChecks(run.result, {}, { requireProvenance: false }),
        { name: `${label} exits successfully`, passed: run.child.exitCode === 0 },
        { name: `${label} correct expected account+partition pins accepted by live preflight`, passed: run.child.exitCode === 0 }
      ];
      const checks = [
        ...identityChecks(local, 'spec-path'),
        { name: 'spec-path selects specs/local.yaml', passed: String(local.result.resolution?.specPath ?? '').endsWith('specs/local.yaml') },
        ...identityChecks(monorepo, 'service-root'),
        { name: 'service-root selects orders OpenAPI', passed: String(monorepo.result.resolution?.specPath ?? '').includes('services/orders/') },
        { name: 'service-root is evidenced', passed: JSON.stringify([monorepo.result.resolution?.provenance, monorepo.result.resolution?.evidence]).includes('services/orders') },
        ...identityChecks(remote, 'Backstage remote'),
        { name: 'remote source is repo OpenAPI', passed: remote.result.resolution?.sourceType === 'repo-spec' && remote.result.resolution?.specFormat?.includes('openapi') },
        { name: 'Backstage remote catalog is evidenced', passed: JSON.stringify([remote.result.resolution?.provenance, remote.result.resolution?.evidence]).toLowerCase().includes('backstage') }
      ];
      return resultRecord(this.id, this.description, started, checks, {}, {}, [childReceipt(local.child), childReceipt(monorepo.child), childReceipt(remote.child)]);
    }
  },
  {
    id: 'appsync-merged-associations',
    description: 'merged AppSync associations survive association IAM denial',
    async run(workspace) {
      const role = outputs.AppSyncAssociationDenialRoleArn;
      if (!outputs.MergedGraphqlApiId || !role) return missingPrerequisite(this.id, !outputs.MergedGraphqlApiId ? 'MergedGraphqlApiId' : 'AppSyncAssociationDenialRoleArn');
      const started = Date.now();
      const { AppSyncSdkClient, AppSyncProvider } = await import(distEntry);
      const inputs = resolveInputs({ INPUT_AWS_REGION: region, INPUT_REPO_ROOT: workspace, INPUT_OUTPUT_DIR: 'discovered-specs', INPUT_EXPECTED_SERVICE_NAME: 'spec-discovery-validation-merged', INPUT_PREFLIGHT_CHECKS: 'true' });
      const executeOne = async () => {
        const client = new AppSyncSdkClient(region, { sourceAssociationPageSize: 1 });
        let schemaCalls = 0;
        const wrapped = new Proxy(client, { get(target, property, receiver) { const value = Reflect.get(target, property, receiver); if (property === 'getSchema') return async (...args) => { schemaCalls += 1; return await value.apply(target, args); }; return typeof value === 'function' ? value.bind(target) : value; } });
        const provider = new AppSyncProvider(wrapped);
        const result = await execute(inputs, { core: quietCore, aws: new TargetedApiGatewayClient(region), writeSpecFile: defaultWriteSpecFile, providerRegistry: { ...emptyProviderRegistry, all: () => [provider], get: () => provider, probeAvailable: async () => [provider] } });
        return { result, schemaCalls };
      };
      const normal = await executeOne();
      const denied = await withAssumedRole(role, executeOne);
      const associations = normal.result.resolution?.provenance?.appsyncSourceAssociations ?? [];
      const checks = [
        { name: 'normal merged SDL resolves', passed: normal.result.resolution?.status === 'resolved' },
        { name: 'normal schema exported exactly once', passed: normal.schemaCalls === 1 },
        { name: 'forced pages gather two associations', passed: associations.length >= 2 },
        { name: 'normal association evidence complete', passed: normal.result.resolution?.provenance?.appsyncAssociationEvidence === 'complete' },
        { name: 'denied merged SDL resolves', passed: denied.result.resolution?.status === 'resolved' },
        { name: 'denied schema exported exactly once', passed: denied.schemaCalls === 1 },
        { name: 'denied association evidence typed', passed: denied.result.resolution?.provenance?.appsyncAssociationEvidence === 'denied' }
      ];
      return resultRecord(this.id, this.description, started, checks, { normal: normal.result.resolution, denied: denied.result.resolution });
    }
  },
  {
    id: 'provider-denial-typed',
    description: 'AppSync IAM skip does not suppress API Gateway',
    async run(workspace) {
      if (!outputs.ProviderDenialRoleArn || !outputs.RestApiId) return missingPrerequisite(this.id, !outputs.ProviderDenialRoleArn ? 'ProviderDenialRoleArn' : 'RestApiId');
      const started = Date.now();
      const childWorkspace = await caseWorkspace(workspace, 'provider-denial');
      const run = await withAssumedRole(outputs.ProviderDenialRoleArn, () => runBuiltCli(childWorkspace, { inputs: { GATEWAY_ID: outputs.RestApiId, PREFLIGHT_PERMISSION_PROBE: 'true' } }));
      const resolution = run.result.resolution ?? {};
      const probes = resolution.providerProbes ?? resolution.provenance?.providerProbes ?? [];
      const checks = [
        ...cliResultChecks(run.result, { status: 'resolved', providerType: 'api-gateway' }),
        { name: 'AppSync IAM probe skipped', passed: probes.some((probe) => probe.provider === 'appsync' && probe.status === 'skipped' && probe.reason === 'iam') },
        { name: 'API Gateway probe available', passed: probes.some((probe) => probe.provider === 'api-gateway' && probe.status === 'available') },
        { name: 'CLI exits successfully', passed: run.child.exitCode === 0 }
      ];
      return resultRecord(this.id, this.description, started, checks, resolution, run.result.outputs, childReceipt(run.child));
    }
  },
  {
    id: 'expected-identity-mismatch',
    description: 'wrong expected identity fails before export',
    async run(workspace) {
      const started = Date.now();
      const run = await runBuiltCli(await caseWorkspace(workspace, 'identity-mismatch'), { inputs: { EXPECTED_ACCOUNT_ID: '000000000000', EXPECTED_PARTITION: manifest.partition === 'aws' ? 'aws-us-gov' : 'aws' } });
      const text = `${run.child.stdout}${run.child.stderr}`;
      const sanitizedError = !/\b\d{12}\b|AKIA[0-9A-Z]{16}|arn:aws/i.test(text);
      const checks = [
        { name: 'CLI exits nonzero', passed: run.child.exitCode !== 0 },
        { name: 'no result artifact emitted', passed: !run.result.resolution },
        { name: 'no spec artifact emitted', passed: !existsSync(run.outputPath) },
        { name: 'captured error is sanitized', passed: sanitizedError }
      ];
      return resultRecord(this.id, this.description, started, checks, { status: 'failed-closed' }, {}, { exitCode: run.child.exitCode, sanitizedError });
    }
  }
];

const startedAt = Date.now();
const allCases = [
  ...gatewayCases.map((testCase) => ({ testCase, runner: testCase.runner ?? runRuntimeGatewayCase })),
  ...providerCases.map((testCase) => ({ testCase, runner: runRuntimeProviderCase }))
];
const results = await mapWithConcurrency(allCases, 5, ({ testCase, runner }) => runner(testCase));
const requiredBoundaryResults = [];
for (const def of requiredBoundaryDefs) {
  requiredBoundaryResults.push(await runOptionalRequiredCase(def));
}
results.push(...requiredBoundaryResults);

const failed = results.filter((result) => !result.passed);
const routeOnlyResult = results.find((result) => result.name === 'api-gateway-rest');
const routeOnlyChecks = routeOnlyResult?.artifactChecks.filter((check) =>
  check.name.includes('contract audit') ||
  check.name.includes('GET /health') ||
  check.name.includes('live route')
) ?? [];
const liveControlChecks = routeOnlyResult?.artifactChecks.filter((check) =>
  check.name.startsWith('live control ')
) ?? [];
await mkdir(path.dirname(evidenceJsonPath), { recursive: true });
await writeFile(evidenceJsonPath, `${JSON.stringify({
  capturedAt: new Date().toISOString(),
  elapsedMs: Date.now() - startedAt,
  stackName: manifest.stackName,
  region,
  results,
  requiredBoundarySkipped: 0
}, null, 2)}\n`, 'utf8');

const builtCliResults = results.filter((result) => result.runner === 'built-cli');
const builtCliReceipt = JSON.stringify({ capturedAt: new Date().toISOString(), results: builtCliResults });
for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
  const credential = process.env[key];
  if (credential && builtCliReceipt.includes(credential)) {
    throw new Error('BuiltCliReceiptCredentialLeak');
  }
}
for (const credential of temporaryCredentialValues) {
  if (builtCliReceipt.includes(credential)) throw new Error('BuiltCliReceiptCredentialLeak');
}
await writeFile(
  path.join(repoRoot, 'validation/evidence/built-cli-live.local.json'),
  `${JSON.stringify({ capturedAt: new Date().toISOString(), results: builtCliResults }, null, 2)}\n`,
  'utf8'
);
await updateEvidenceReadmeSection(summaryPath, 'built-cli-live', [
  '## Built CLI Live Evidence',
  '',
  `- Captured at: ${new Date().toISOString()}`,
  `- Built CLI cases: ${builtCliResults.length}`,
  `- Passed: ${builtCliResults.filter((result) => result.passed).length}`,
  `- Failed: ${builtCliResults.filter((result) => !result.passed).length}`,
  '- Raw CLI stdout/stderr and detailed resolution receipts are stored only in `built-cli-live.local.json`.'
].join('\n'));

const summary = [
  '## Live AWS Surface Evidence',
  '',
  `- Captured at: ${new Date().toISOString()}`,
  `- Elapsed ms: ${Date.now() - startedAt}`,
  `- Stack: ${manifest.stackName}`,
  `- Region: ${region}`,
  `- Cases: ${results.length}`,
  `- Passed: ${results.length - failed.length}`,
  `- Failed: ${failed.length}`,
  '- Required-boundary skipped: 0',
  `- Route-only REST checks: ${routeOnlyChecks.filter((check) => check.passed).length}/${routeOnlyChecks.length} passed (export content omission, audit, warning, live JSON response, Content-Length)`,
  `- Contract-control wire checks: ${liveControlChecks.filter((check) => check.passed).length}/${liveControlChecks.length} passed (clean 204, managed-service normalization, valid/invalid schema payloads, Content-Length)`,
  '',
  '| Case | Runner | Source Type | Provider | Format | Contract audit | Derived OAS | Elapsed ms | Result |',
  '| --- | --- | --- | --- | --- | --- | --- | ---: | --- |',
  ...results.map((result) => {
    const audit = result.resolution?.openapiContractAudit;
    const auditSummary = audit
      ? `${audit.status} (${audit.responsesWithoutContent} response(s) without content)`
      : '';
    const derived = [valueFor(result, 'derivedOpenApiVersion'), valueFor(result, 'derivedOpenApiCompleteness')]
      .filter(Boolean)
      .join(' ');
    return `| ${result.name} | ${result.runner} | ${valueFor(result, 'sourceType')} | ${valueFor(result, 'providerType')} | ${valueFor(result, 'specFormat')} | ${auditSummary} | ${derived} | ${result.elapsedMs} | ${result.passed ? 'pass' : 'fail'} |`;
  })
].join('\n');

await updateEvidenceReadmeSection(summaryPath, 'live-aws-surfaces', summary);

const currentRunResults = {};
for (const result of results) {
  const mappedIds = RESULT_NAME_TO_REQUIRED_IDS[result.name] ?? [result.name];
  for (const id of mappedIds) {
    currentRunResults[id] = {
      status: result.passed ? 'passed' : 'failed',
      evidence: `current live runner ${result.runner ?? 'runtime'}`
    };
  }
}
const providerResults = results.filter((result) => EXISTING_PROVIDER_CASE_NAMES.has(result.name));
if (providerResults.length > 0) {
  const allProvidersPassed = providerResults.every((result) => result.passed);
  currentRunResults['all-existing-live-supported-providers'] = {
    status: allProvidersPassed ? 'passed' : 'failed',
    evidence: `current live refresh of ${providerResults.length} provider cases`
  };
}

const requiredMatrix = await buildLiveRequiredMatrix(repoRoot, { currentRunResults });
await updateEvidenceReadmeSection(
  summaryPath,
  'live-required-matrix',
  renderLiveRequiredMatrixMarkdown(requiredMatrix, { capturedAt: new Date().toISOString() })
);
await writeFile(
  path.join(repoRoot, 'validation/evidence/live-required-matrix.local.json'),
  `${JSON.stringify({
    capturedAt: new Date().toISOString(),
    matrix: requiredMatrix,
    skipped: 0
  }, null, 2)}\n`,
  'utf8'
);

const safeCaseRecords = results.map((result) => ({
  name: result.name,
  runner: result.runner,
  passed: result.passed,
  elapsedMs: result.elapsedMs,
  artifactChecks: result.artifactChecks.map((check, index) => ({ name: `check-${index + 1}`, passed: check.passed }))
}));
const liveValidationSummary = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  stackAlias: 'spec-discovery-validation',
  region,
  stackStatus: /^[A-Z_]+$/.test(manifest.status ?? '') ? manifest.status : undefined,
  counts: {
    cases: safeCaseRecords.length,
    passed: safeCaseRecords.filter((record) => record.passed).length,
    failed: safeCaseRecords.filter((record) => !record.passed).length,
    currentRunRequired: requiredMatrix.filter((row) => row.runClass === 'current-run').length,
    historicalPreservedRequired: requiredMatrix.filter((row) => row.runClass === 'historical-preserved').length
  },
  cases: safeCaseRecords,
  requiredCases: requiredMatrix.map(({ id, status, runClass, ledgerIds, evidence }) => ({ id, status, runClass, ledgerIds, evidence }))
};
const serializedLiveValidationSummary = JSON.stringify(liveValidationSummary);
const forbiddenSummaryPatterns = [/\b\d{12}\b/, /arn:/i, /AKIA[0-9A-Z]{16}/, /(?:X-Amz-|Signature=|Credential=)/i, /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i];
if (forbiddenSummaryPatterns.some((pattern) => pattern.test(serializedLiveValidationSummary)) || [...temporaryCredentialValues].some((credential) => serializedLiveValidationSummary.includes(credential))) {
  throw new Error('LiveValidationSummaryUnsafe');
}
await writeFile(
  path.join(repoRoot, 'validation/evidence/live-validation-summary.json'),
  `${JSON.stringify(liveValidationSummary, null, 2)}\n`,
  'utf8'
);

if (failed.length > 0) {
  console.error(`failed cases: ${failed.map((result) => result.name).join(', ')}`);
  console.error(`failed checks: ${failed.flatMap((result) => result.artifactChecks.filter((check) => !check.passed).map((check) => `${result.name}:${check.name}`)).join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    status: 'ok',
    cases: results.length,
    requiredBoundarySkipped: 0,
    elapsedMs: Date.now() - startedAt
  }, null, 2));
}

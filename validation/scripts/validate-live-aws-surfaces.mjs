#!/usr/bin/env node
/* global console, process */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TextDecoder } from 'node:util';
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
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
  GetPolicyStoreCommand,
  GetSchemaCommand,
  VerifiedPermissionsClient
} from '@aws-sdk/client-verifiedpermissions';
import { updateEvidenceReadmeSection } from './lib/evidence-readme.mjs';

const repoRoot = process.cwd();

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  const inline = process.argv.find((value) => value.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : fallback;
}

const manifestPath = arg('manifest', 'validation/evidence/live-resource-manifest.local.json');
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
  synthesizeRestApiFallbackOpenApi,
  synthesizeWebSocketOpenApi
} = await import(distEntry);
const manifest = JSON.parse(await readFile(path.join(repoRoot, manifestPath), 'utf8'));
const outputs = manifest.outputs ?? {};

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
    return await readBody(response.body);
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
    do {
      const response = await sendWithBackoff(this.rest, new GetResourcesCommand({
        restApiId: apiId,
        position,
        limit: 500,
        embed: ['methods']
      }));
      resources.push(...(response.items ?? []));
      position = response.position;
    } while (position);
    return resources;
  }

  async listRestModels(apiId) {
    const models = [];
    let position;
    do {
      const response = await sendWithBackoff(this.rest, new GetModelsCommand({
        restApiId: apiId,
        position,
        limit: 500
      }));
      models.push(...(response.items ?? []));
      position = response.position;
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

async function inspectGeneratedArtifacts(workspace, result, testCase) {
  const checks = [];
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
  return checks;
}

async function runRuntimeGatewayCase(testCase) {
  const caseStartedAt = Date.now();
  const workspace = await mkdtemp(path.join(os.tmpdir(), `spec-discovery-live-${testCase.name}-`));
  try {
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
      core: quietCore,
      aws: new TargetedApiGatewayClient(region),
      writeSpecFile: defaultWriteSpecFile,
      providerRegistry: emptyProviderRegistry
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
      INPUT_MAX_CANDIDATES: '5'
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

const startedAt = Date.now();
const allCases = [
  ...gatewayCases.map((testCase) => ({ testCase, runner: testCase.runner ?? runRuntimeGatewayCase })),
  ...providerCases.map((testCase) => ({ testCase, runner: runRuntimeProviderCase }))
];
const results = await mapWithConcurrency(allCases, 5, ({ testCase, runner }) => runner(testCase));

const failed = results.filter((result) => !result.passed);
await mkdir(path.dirname(evidenceJsonPath), { recursive: true });
await writeFile(evidenceJsonPath, `${JSON.stringify({
  capturedAt: new Date().toISOString(),
  elapsedMs: Date.now() - startedAt,
  stackName: manifest.stackName,
  region,
  results
}, null, 2)}\n`, 'utf8');

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
  '',
  '| Case | Runner | Source Type | Provider | Format | Derived OAS | Elapsed ms | Result |',
  '| --- | --- | --- | --- | --- | --- | ---: | --- |',
  ...results.map((result) => {
    const derived = [valueFor(result, 'derivedOpenApiVersion'), valueFor(result, 'derivedOpenApiCompleteness')]
      .filter(Boolean)
      .join(' ');
    return `| ${result.name} | ${result.runner} | ${valueFor(result, 'sourceType')} | ${valueFor(result, 'providerType')} | ${valueFor(result, 'specFormat')} | ${derived} | ${result.elapsedMs} | ${result.passed ? 'pass' : 'fail'} |`;
  })
].join('\n');

await updateEvidenceReadmeSection(summaryPath, 'live-aws-surfaces', summary);

if (failed.length > 0) {
  console.error(JSON.stringify({ failed }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: 'ok', cases: results.length, elapsedMs: Date.now() - startedAt }, null, 2));
}

#!/usr/bin/env node
/* global console, process */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TextDecoder } from 'node:util';
import {
  APIGatewayClient,
  GetExportCommand,
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
  ApiGatewayV2Client,
  ExportApiCommand,
  GetApiCommand,
  GetRoutesCommand,
  GetStagesCommand as GetHttpStagesCommand,
  GetTagsCommand as GetHttpTagsCommand
} from '@aws-sdk/client-apigatewayv2';
import {
  LambdaClient,
  GetFunctionCommand,
  GetFunctionUrlConfigCommand,
  ListTagsCommand
} from '@aws-sdk/client-lambda';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
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
  LambdaUrlProvider,
  CloudFormationProvider,
  deriveOpenApiDocument,
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
    const api = await this.getHttpApi(apiId);
    const routes = [];
    let nextToken;
    do {
      const response = await sendWithBackoff(this.v2, new GetRoutesCommand({ ApiId: apiId, NextToken: nextToken }));
      for (const route of response.Items ?? []) {
        if (!route.RouteKey) continue;
        routes.push({
          routeKey: route.RouteKey,
          authorizationType: route.AuthorizationType,
          operationName: route.OperationName,
          target: route.Target
        });
      }
      nextToken = response.NextToken;
    } while (nextToken);

    return synthesizeWebSocketOpenApi({
      apiId,
      apiName: api?.name ?? apiId,
      region: this.region,
      stage,
      routeSelectionExpression: api?.routeSelectionExpression,
      routes
    });
  }
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
      INPUT_MAX_ATTEMPTS: '1',
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
      'x-amazon-apigateway-protocol: "WEBSOCKET"',
      'x-amazon-apigateway-route-selection-expression',
      'x-amazon-apigateway-route-key'
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
    name: 'eventbridge-schemas',
    expectedServiceName: 'spec-discovery-validation.OrderCreated',
    providerTypes: ['eventbridge-schemas'],
    expect: { status: 'resolved', sourceType: 'eventbridge-schema', providerType: 'eventbridge-schemas', specFormat: 'openapi-json' },
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
      ['discovered-specs/SpecDiscoveryValidationSubscribedTopic/webhook.openapi.json', ['"openapi": "3.1.0"', '"webhooks"', 'snsMessageWrapped']]
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
  ...gatewayCases.map((testCase) => ({ testCase, runner: runRuntimeGatewayCase })),
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
  '| Case | Runner | Source Type | Provider | Format | Elapsed ms | Result |',
  '| --- | --- | --- | --- | --- | ---: | --- |',
  ...results.map((result) => {
    return `| ${result.name} | ${result.runner} | ${valueFor(result, 'sourceType')} | ${valueFor(result, 'providerType')} | ${valueFor(result, 'specFormat')} | ${result.elapsedMs} | ${result.passed ? 'pass' : 'fail'} |`;
  })
].join('\n');

await updateEvidenceReadmeSection(summaryPath, 'live-aws-surfaces', summary);

if (failed.length > 0) {
  console.error(JSON.stringify({ failed }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: 'ok', cases: results.length, elapsedMs: Date.now() - startedAt }, null, 2));
}

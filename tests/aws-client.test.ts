import { parse } from 'yaml';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AwsApiGatewaySdkClient, MAX_API_GATEWAY_PAGES } from '../src/lib/aws/client.js';
import { CloudFormationSdkClient } from '../src/lib/aws/cloudformation-client.js';
import { EventBridgeSurfaceSdkClient } from '../src/lib/aws/eventbridge-client.js';
import { GlueSchemaSdkClient } from '../src/lib/aws/glue-client.js';
import { LambdaSdkClient } from '../src/lib/aws/lambda-client.js';
import { MAX_AWS_LIST_PAGES } from '../src/lib/aws/pagination.js';
import { MAX_S3_OBJECT_BYTES, S3SdkClient } from '../src/lib/aws/s3-client.js';
import { EventBridgeSchemasSdkClient } from '../src/lib/aws/schemas-client.js';
import { SsmSdkClient } from '../src/lib/aws/ssm-client.js';

const { apiGatewayV2SendMock, apiGatewayRestSendMock } = vi.hoisted(() => ({
  apiGatewayV2SendMock: vi.fn(),
  apiGatewayRestSendMock: vi.fn()
}));

vi.mock('@aws-sdk/client-apigatewayv2', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-apigatewayv2')>('@aws-sdk/client-apigatewayv2');
  return {
    ...actual,
    ApiGatewayV2Client: class {
      public send = apiGatewayV2SendMock;
    }
  };
});

vi.mock('@aws-sdk/client-api-gateway', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-api-gateway')>('@aws-sdk/client-api-gateway');
  return {
    ...actual,
    APIGatewayClient: class {
      public send = apiGatewayRestSendMock;
    }
  };
});

describe('AwsApiGatewaySdkClient', () => {
  beforeEach(() => {
    apiGatewayV2SendMock.mockReset();
    apiGatewayRestSendMock.mockReset();
  });

  it('enriches WebSocket exports with API Gateway v2 models, integrations, authorizers, and route responses', async () => {
    apiGatewayV2SendMock.mockImplementation(async (command: { constructor: { name: string }; input?: Record<string, unknown> }) => {
      switch (command.constructor.name) {
        case 'GetApiCommand':
          return {
            ApiId: 'ws-123',
            Name: 'orders-websocket',
            ProtocolType: 'WEBSOCKET',
            RouteSelectionExpression: '$request.body.action'
          };
        case 'GetRoutesCommand':
          return {
            Items: [
              {
                RouteId: 'route-1',
                RouteKey: 'sendMessage',
                ApiKeyRequired: true,
                AuthorizationType: 'CUSTOM',
                AuthorizationScopes: ['orders:write'],
                AuthorizerId: 'authorizer-1',
                OperationName: 'sendOrderMessage',
                ModelSelectionExpression: '$request.body.messageType',
                RequestModels: { 'application/json': 'OrderMessage' },
                RequestParameters: {
                  'route.request.header.Authorization': { Required: true }
                },
                RouteResponseSelectionExpression: '$default',
                Target: 'integrations/integration-1'
              }
            ]
          };
        case 'GetModelsCommand':
          return {
            Items: [
              {
                Name: 'OrderMessage',
                ContentType: 'application/json',
                Schema: '{"type":"object","required":["orderId"],"properties":{"orderId":{"type":"string"}}}'
              },
              {
                Name: 'OrderAck',
                ContentType: 'application/json',
                Schema: '{"type":"object","properties":{"accepted":{"type":"boolean"}}}'
              }
            ]
          };
        case 'GetIntegrationsCommand':
          return {
            Items: [
              {
                IntegrationId: 'integration-1',
                IntegrationType: 'AWS_PROXY',
                IntegrationUri: 'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/function-arn/invocations',
                IntegrationMethod: 'POST',
                RequestParameters: {
                  'integration.request.header.TraceId': 'route.request.header.TraceId'
                },
                RequestTemplates: {
                  'application/json': '{"action":"$input.path(\'$.action\')"}'
                },
                TemplateSelectionExpression: '$request.body.template',
                TimeoutInMillis: 29000
              }
            ]
          };
        case 'GetAuthorizersCommand':
          return {
            Items: [
              {
                AuthorizerId: 'authorizer-1',
                AuthorizerType: 'REQUEST',
                AuthorizerUri: 'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/authorizer-arn/invocations',
                IdentitySource: ['route.request.header.Authorization']
              }
            ]
          };
        case 'GetRouteResponsesCommand':
          expect(command.input).toMatchObject({ ApiId: 'ws-123', RouteId: 'route-1' });
          return {
            Items: [
              {
                RouteResponseId: 'response-1',
                RouteResponseKey: '$default',
                ModelSelectionExpression: '$default',
                ResponseModels: { 'application/json': 'OrderAck' },
                ResponseParameters: {
                  'route.response.header.RequestId': { Required: false }
                }
              }
            ]
          };
        default:
          throw new Error(`unexpected command ${command.constructor.name}`);
      }
    });

    const client = new AwsApiGatewaySdkClient('us-east-1');
    const content = await client.exportWebSocketApi('ws-123', 'prod');
    const document = parse(content);
    const operation = document.paths['/sendMessage'].post;

    expect(document.components.schemas.OrderMessage.required).toEqual(['orderId']);
    expect(document.components.schemas.OrderAck.properties.accepted.type).toBe('boolean');
    expect(operation['x-amazon-apigateway-route-id']).toBe('route-1');
    expect(operation['x-amazon-apigateway-integration']).toEqual(
      expect.objectContaining({
        integrationId: 'integration-1',
        type: 'AWS_PROXY',
        httpMethod: 'POST'
      })
    );
    expect(operation['x-amazon-apigateway-authorizer']).toEqual(
      expect.objectContaining({
        authorizerId: 'authorizer-1',
        type: 'REQUEST'
      })
    );
    expect(operation['x-amazon-apigateway-route-responses']).toEqual([
      expect.objectContaining({
        routeResponseId: 'response-1',
        routeResponseKey: '$default',
        responseModels: { 'application/json': 'OrderAck' }
      })
    ]);
  });

  it('U6.5 consumes two-page GetModels/GetResources/GetRequestValidators with limit 500 and position tokens', async () => {
    const commandInputs: Array<{ name: string; input: Record<string, unknown> }> = [];
    apiGatewayRestSendMock.mockImplementation(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      commandInputs.push({ name: command.constructor.name, input: command.input });
      switch (command.constructor.name) {
        case 'GetExportCommand':
          return { body: Buffer.from(['openapi: 3.0.1', 'info: { title: t, version: "1" }', 'paths:', '  /orders:', '    post:', '      responses:', '        "200": { description: OK }'].join('\n')) };
        case 'GetResourcesCommand':
          return command.input.position === undefined
            ? {
                items: [{
                  path: '/orders',
                  resourceMethods: {
                    POST: {
                      httpMethod: 'POST',
                      requestModels: { 'application/json': 'CreateOrder' },
                      requestValidatorId: 'val1',
                      methodResponses: {
                        '200': {
                          statusCode: '200',
                          responseModels: { 'application/json': 'OrderAck' }
                        }
                      }
                    }
                  }
                }],
                position: 'page2'
              }
            : { items: [] };
        case 'GetModelsCommand':
          return command.input.position === undefined
            ? {
                items: [
                  { name: 'CreateOrder', schema: JSON.stringify({ type: 'object' }), contentType: 'application/json' },
                  { name: 'OrderAck', schema: JSON.stringify({ type: 'object', properties: { accepted: { type: 'boolean' } } }), contentType: 'application/json' }
                ],
                position: 'page2'
              }
            : { items: [] };
        case 'GetRequestValidatorsCommand':
          return command.input.position === undefined
            ? { items: [{ id: 'val1', name: 'body-only', validateRequestBody: true, validateRequestParameters: false }], position: 'page2' }
            : { items: [] };
        default:
          throw new Error(`Unexpected command ${command.constructor.name}`);
      }
    });

    const client = new AwsApiGatewaySdkClient('us-east-1');
    const output = await client.exportRestApi('rest-1', 'prod');
    const parsed = parse(output) as Record<string, never>;
    expect(parsed.components?.['schemas']?.['CreateOrder']).toEqual({ type: 'object' });
    expect(parsed.components?.['schemas']?.['OrderAck']).toEqual({
      type: 'object',
      properties: { accepted: { type: 'boolean' } }
    });
    expect(parsed['x-amazon-apigateway-request-validators']).toEqual({
      'body-only': { validateRequestBody: true, validateRequestParameters: false }
    });
    expect(parsed.paths?.['/orders']?.['post']?.['x-amazon-apigateway-request-validator']).toBe('body-only');
    expect(
      parsed.paths?.['/orders']?.['post']?.['responses']?.['200']?.['content']?.['application/json']?.['schema']?.['$ref']
    ).toBe('#/components/schemas/OrderAck');

    for (const name of ['GetResourcesCommand', 'GetModelsCommand', 'GetRequestValidatorsCommand']) {
      const calls = commandInputs.filter((call) => call.name === name);
      expect(calls, name).toHaveLength(2);
      expect(calls[0]?.input.limit, name).toBe(500);
      expect(calls[0]?.input.position, name).toBeUndefined();
      expect(calls[1]?.input.position, name).toBe('page2');
    }
  });

  it('U6.6 returns the exact native export when any enrichment call fails', async () => {
    const nativeBody = ['openapi: 3.0.1', 'info: { title: t, version: "1" }', 'paths:', '  /orders:', '    post:', '      responses:', '        "200": { description: OK }'].join('\n');
    apiGatewayRestSendMock.mockImplementation(async (command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case 'GetExportCommand':
          return { body: Buffer.from(nativeBody) };
        case 'GetResourcesCommand':
          throw Object.assign(new Error('AccessDenied'), { name: 'AccessDeniedException' });
        case 'GetModelsCommand':
          return { items: [] };
        case 'GetRequestValidatorsCommand':
          return { items: [] };
        default:
          throw new Error(`Unexpected command ${command.constructor.name}`);
      }
    });

    const client = new AwsApiGatewaySdkClient('us-east-1');
    await expect(client.exportRestApi('rest-1', 'prod')).resolves.toBe(nativeBody);
  });

  it('fail-softs native REST export when enrichment pagination hits a repeated position token', async () => {
    const nativeBody = 'openapi: 3.0.1\ninfo: { title: t, version: "1" }\npaths: {}';
    const calls = new Map<string, number>();
    apiGatewayRestSendMock.mockImplementation(async (command: { constructor: { name: string } }) => {
      const name = command.constructor.name;
      if (name === 'GetExportCommand') {
        return { body: Buffer.from(nativeBody) };
      }
      if (!['GetResourcesCommand', 'GetModelsCommand', 'GetRequestValidatorsCommand'].includes(name)) {
        throw new Error(`Unexpected command ${name}`);
      }
      const count = (calls.get(name) ?? 0) + 1;
      calls.set(name, count);
      if (count > 3) throw new Error(`${name} pagination did not terminate`);
      return { items: [], position: count === 1 ? 'page-a' : count === 2 ? 'page-b' : 'page-a' };
    });

    const client = new AwsApiGatewaySdkClient('us-east-1');
    await expect(client.exportRestApi('rest-1', 'prod')).resolves.toBe(nativeBody);

    for (const name of ['GetResourcesCommand', 'GetModelsCommand', 'GetRequestValidatorsCommand']) {
      expect(calls.get(name), name).toBe(3);
    }
  });

  it('rejects REST enrichment pagination via exportRestApiFallback on repeated position token', async () => {
    const calls = new Map<string, number>();
    apiGatewayRestSendMock.mockImplementation(async (command: { constructor: { name: string } }) => {
      const name = command.constructor.name;
      if (name === 'GetRestApiCommand') {
        return { id: 'rest-1', name: 'orders' };
      }
      if (!['GetResourcesCommand', 'GetModelsCommand'].includes(name)) {
        throw new Error(`Unexpected command ${name}`);
      }
      const count = (calls.get(name) ?? 0) + 1;
      calls.set(name, count);
      if (count > 3) throw new Error(`${name} pagination did not terminate`);
      return { items: [], position: 'stuck' };
    });

    const client = new AwsApiGatewaySdkClient('us-east-1');
    await expect(client.exportRestApiFallback('rest-1', 'prod')).rejects.toThrow(
      /API Gateway Get(?:Resources|Models) pagination returned a repeated token; aborting/
    );
    expect(calls.get('GetResourcesCommand') ?? 0).toBeGreaterThanOrEqual(2);
    expect(calls.get('GetModelsCommand') ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('rejects REST enrichment pagination via exportRestApiFallback when the page cap is exceeded', async () => {
    let resourcePages = 0;
    apiGatewayRestSendMock.mockImplementation(async (command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case 'GetRestApiCommand':
          return { id: 'rest-1', name: 'orders' };
        case 'GetModelsCommand':
          return { items: [] };
        case 'GetResourcesCommand': {
          resourcePages += 1;
          return { items: [], position: `pos-${resourcePages + 1}` };
        }
        default:
          throw new Error(`Unexpected command ${command.constructor.name}`);
      }
    });

    const client = new AwsApiGatewaySdkClient('us-east-1');
    await expect(client.exportRestApiFallback('rest-1', 'prod')).rejects.toThrow(
      `API Gateway GetResources pagination exceeded ${MAX_API_GATEWAY_PAGES} pages; aborting`
    );
    expect(resourcePages).toBe(MAX_API_GATEWAY_PAGES);
  });

  it('aggregates two GetRestApis pages and rejects repeated position / page-cap', async () => {
    apiGatewayRestSendMock
      .mockResolvedValueOnce({
        items: [{ id: 'rest-a', name: 'alpha' }],
        position: 'page-2'
      })
      .mockResolvedValueOnce({
        items: [{ id: 'rest-b', name: 'beta' }]
      });

    const client = new AwsApiGatewaySdkClient('us-east-1');
    await expect(client.listRestApis()).resolves.toEqual([
      { id: 'rest-a', name: 'alpha' },
      { id: 'rest-b', name: 'beta' }
    ]);
    expect(apiGatewayRestSendMock).toHaveBeenCalledTimes(2);

    apiGatewayRestSendMock.mockReset();
    apiGatewayRestSendMock.mockResolvedValue({ items: [{ id: 'rest-x', name: 'x' }], position: 'stuck' });
    await expect(client.listRestApis()).rejects.toThrow(
      'API Gateway GetRestApis pagination returned a repeated token; aborting'
    );
    expect(apiGatewayRestSendMock).toHaveBeenCalledTimes(2);

    apiGatewayRestSendMock.mockReset();
    let page = 0;
    apiGatewayRestSendMock.mockImplementation(async () => {
      page += 1;
      return { items: [{ id: `rest-${page}`, name: `n-${page}` }], position: `tok-${page + 1}` };
    });
    await expect(client.listRestApis()).rejects.toThrow(
      `API Gateway GetRestApis pagination exceeded ${MAX_API_GATEWAY_PAGES} pages; aborting`
    );
    expect(apiGatewayRestSendMock).toHaveBeenCalledTimes(MAX_API_GATEWAY_PAGES);
  });

  it('aggregates two GetApis pages and rejects repeated token / page-cap', async () => {
    apiGatewayV2SendMock
      .mockResolvedValueOnce({
        Items: [{ ApiId: 'http-a', Name: 'alpha', ProtocolType: 'HTTP' }],
        NextToken: 'page-2'
      })
      .mockResolvedValueOnce({
        Items: [{ ApiId: 'http-b', Name: 'beta', ProtocolType: 'HTTP' }]
      });

    const client = new AwsApiGatewaySdkClient('us-east-1');
    await expect(client.listHttpApis()).resolves.toEqual([
      { id: 'http-a', name: 'alpha', protocolType: 'HTTP', routeSelectionExpression: undefined },
      { id: 'http-b', name: 'beta', protocolType: 'HTTP', routeSelectionExpression: undefined }
    ]);
    expect(apiGatewayV2SendMock).toHaveBeenCalledTimes(2);

    apiGatewayV2SendMock.mockReset();
    apiGatewayV2SendMock.mockResolvedValue({
      Items: [{ ApiId: 'http-x', Name: 'x', ProtocolType: 'HTTP' }],
      NextToken: 'stuck'
    });
    await expect(client.listHttpApis()).rejects.toThrow(
      'API Gateway GetApis pagination returned a repeated token; aborting'
    );
    expect(apiGatewayV2SendMock).toHaveBeenCalledTimes(2);

    apiGatewayV2SendMock.mockReset();
    let page = 0;
    apiGatewayV2SendMock.mockImplementation(async () => {
      page += 1;
      return {
        Items: [{ ApiId: `http-${page}`, Name: `n-${page}`, ProtocolType: 'HTTP' }],
        NextToken: `tok-${page + 1}`
      };
    });
    await expect(client.listHttpApis()).rejects.toThrow(
      `API Gateway GetApis pagination exceeded ${MAX_API_GATEWAY_PAGES} pages; aborting`
    );
    expect(apiGatewayV2SendMock).toHaveBeenCalledTimes(MAX_API_GATEWAY_PAGES);
  });

  it('aggregates two GetStages pages and rejects repeated token / page-cap', async () => {
    apiGatewayV2SendMock
      .mockResolvedValueOnce({
        Items: [{ StageName: '$default', DeploymentId: 'dep-1', AutoDeploy: true, ApiGatewayManaged: true }],
        NextToken: 'page-2'
      })
      .mockResolvedValueOnce({
        Items: [{ StageName: 'preview', DeploymentId: 'dep-2' }]
      });

    const client = new AwsApiGatewaySdkClient('us-east-1');
    await expect(client.listHttpStages('http-1')).resolves.toEqual([
      {
        stageName: '$default',
        deploymentId: 'dep-1',
        autoDeploy: true,
        apiGatewayManaged: true
      },
      { stageName: 'preview', deploymentId: 'dep-2' }
    ]);
    expect(apiGatewayV2SendMock).toHaveBeenCalledTimes(2);

    apiGatewayV2SendMock.mockReset();
    apiGatewayV2SendMock.mockResolvedValue({
      Items: [{ StageName: 'prod' }],
      NextToken: 'stuck'
    });
    await expect(client.listHttpStages('http-1')).rejects.toThrow(
      'API Gateway GetStages pagination returned a repeated token; aborting'
    );
    expect(apiGatewayV2SendMock).toHaveBeenCalledTimes(2);

    apiGatewayV2SendMock.mockReset();
    let page = 0;
    apiGatewayV2SendMock.mockImplementation(async () => {
      page += 1;
      return { Items: [{ StageName: `s-${page}` }], NextToken: `tok-${page + 1}` };
    });
    await expect(client.listHttpStages('http-1')).rejects.toThrow(
      `API Gateway GetStages pagination exceeded ${MAX_API_GATEWAY_PAGES} pages; aborting`
    );
    expect(apiGatewayV2SendMock).toHaveBeenCalledTimes(MAX_API_GATEWAY_PAGES);
  });

  it('aggregates two HTTP domain-mapping pages and rejects repeated token / page-cap', async () => {
    apiGatewayV2SendMock.mockImplementation(async (command: { constructor: { name: string }; input?: Record<string, unknown> }) => {
      switch (command.constructor.name) {
        case 'GetDomainNamesCommand':
          if (command.input?.NextToken === 'domains-2') {
            return { Items: [] };
          }
          return {
            Items: [{ DomainName: 'api.example.com' }],
            NextToken: 'domains-2'
          };
        case 'GetApiMappingsCommand':
          if (command.input?.NextToken === 'maps-2') {
            return {
              Items: [{ ApiId: 'http-b', ApiMappingKey: 'b', Stage: 'prod' }]
            };
          }
          return {
            Items: [{ ApiId: 'http-a', ApiMappingKey: 'a', Stage: 'prod' }],
            NextToken: 'maps-2'
          };
        case 'GetApiCommand':
          return { ApiId: command.input?.ApiId, Name: 'api', ProtocolType: 'HTTP' };
        default:
          throw new Error(`Unexpected command ${command.constructor.name}`);
      }
    });

    const client = new AwsApiGatewaySdkClient('us-east-1');
    await expect(client.listHttpDomainMappings()).resolves.toEqual([
      {
        domainName: 'api.example.com',
        apiId: 'http-a',
        basePath: 'a',
        stage: 'prod',
        gatewayType: 'HTTP'
      },
      {
        domainName: 'api.example.com',
        apiId: 'http-b',
        basePath: 'b',
        stage: 'prod',
        gatewayType: 'HTTP'
      }
    ]);
    const mappingCalls = apiGatewayV2SendMock.mock.calls.filter(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'GetApiMappingsCommand'
    );
    expect(mappingCalls).toHaveLength(2);

    apiGatewayV2SendMock.mockReset();
    apiGatewayV2SendMock.mockImplementation(async (command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case 'GetDomainNamesCommand':
          return { Items: [{ DomainName: 'api.example.com' }], NextToken: 'stuck-domain' };
        case 'GetApiMappingsCommand':
          return { Items: [] };
        default:
          throw new Error(`Unexpected command ${command.constructor.name}`);
      }
    });
    await expect(client.listHttpDomainMappings()).rejects.toThrow(
      'API Gateway GetDomainNames pagination returned a repeated token; aborting'
    );
    expect(
      apiGatewayV2SendMock.mock.calls.filter(
        (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'GetDomainNamesCommand'
      )
    ).toHaveLength(2);

    apiGatewayV2SendMock.mockReset();
    let domainPages = 0;
    apiGatewayV2SendMock.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name !== 'GetDomainNamesCommand') {
        throw new Error(`Unexpected command ${command.constructor.name}`);
      }
      domainPages += 1;
      return { Items: [], NextToken: `tok-${domainPages + 1}` };
    });
    await expect(client.listHttpDomainMappings()).rejects.toThrow(
      `API Gateway GetDomainNames pagination exceeded ${MAX_API_GATEWAY_PAGES} pages; aborting`
    );
    expect(domainPages).toBe(MAX_API_GATEWAY_PAGES);
  });

  it('aggregates two WebSocket list pages and rejects repeated token / page-cap on export', async () => {
    const emptyPage = { Items: [] as unknown[] };
    apiGatewayV2SendMock.mockImplementation(async (command: { constructor: { name: string }; input?: Record<string, unknown> }) => {
      switch (command.constructor.name) {
        case 'GetApiCommand':
          return {
            ApiId: 'ws-123',
            Name: 'orders-websocket',
            ProtocolType: 'WEBSOCKET',
            RouteSelectionExpression: '$request.body.action'
          };
        case 'GetRoutesCommand':
          if (command.input?.NextToken === 'routes-2') {
            return {
              Items: [{ RouteId: 'route-2', RouteKey: 'ping', Target: 'integrations/integration-1' }]
            };
          }
          return {
            Items: [{ RouteId: 'route-1', RouteKey: 'sendMessage', Target: 'integrations/integration-1' }],
            NextToken: 'routes-2'
          };
        case 'GetIntegrationsCommand':
          return {
            Items: [{ IntegrationId: 'integration-1', IntegrationType: 'MOCK' }]
          };
        case 'GetAuthorizersCommand':
        case 'GetModelsCommand':
        case 'GetRouteResponsesCommand':
          return emptyPage;
        default:
          throw new Error(`Unexpected command ${command.constructor.name}`);
      }
    });

    const client = new AwsApiGatewaySdkClient('us-east-1');
    const content = await client.exportWebSocketApi('ws-123', 'prod');
    const document = parse(content);
    expect(document.paths['/sendMessage']).toBeDefined();
    expect(document.paths['/ping']).toBeDefined();
    const routeCalls = apiGatewayV2SendMock.mock.calls.filter(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'GetRoutesCommand'
    );
    expect(routeCalls).toHaveLength(2);

    apiGatewayV2SendMock.mockReset();
    apiGatewayV2SendMock.mockImplementation(async (command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case 'GetApiCommand':
          return { ApiId: 'ws-123', Name: 'ws', ProtocolType: 'WEBSOCKET' };
        case 'GetRoutesCommand':
          return { Items: [{ RouteId: 'route-1', RouteKey: 'sendMessage' }], NextToken: 'stuck' };
        case 'GetIntegrationsCommand':
        case 'GetAuthorizersCommand':
        case 'GetModelsCommand':
          return emptyPage;
        default:
          throw new Error(`Unexpected command ${command.constructor.name}`);
      }
    });
    await expect(client.exportWebSocketApi('ws-123', 'prod')).rejects.toThrow(
      'API Gateway GetRoutes pagination returned a repeated token; aborting'
    );
    expect(
      apiGatewayV2SendMock.mock.calls.filter(
        (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'GetRoutesCommand'
      )
    ).toHaveLength(2);

    apiGatewayV2SendMock.mockReset();
    let routePages = 0;
    apiGatewayV2SendMock.mockImplementation(async (command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case 'GetApiCommand':
          return { ApiId: 'ws-123', Name: 'ws', ProtocolType: 'WEBSOCKET' };
        case 'GetRoutesCommand':
          routePages += 1;
          return {
            Items: [{ RouteId: `route-${routePages}`, RouteKey: `k-${routePages}` }],
            NextToken: `tok-${routePages + 1}`
          };
        case 'GetIntegrationsCommand':
        case 'GetAuthorizersCommand':
        case 'GetModelsCommand':
          return emptyPage;
        default:
          throw new Error(`Unexpected command ${command.constructor.name}`);
      }
    });
    await expect(client.exportWebSocketApi('ws-123', 'prod')).rejects.toThrow(
      `API Gateway GetRoutes pagination exceeded ${MAX_API_GATEWAY_PAGES} pages; aborting`
    );
    expect(routePages).toBe(MAX_API_GATEWAY_PAGES);
  });

  it('exposes REST deploymentId stage evidence without fabricating autoDeploy', async () => {
    apiGatewayRestSendMock.mockResolvedValue({
      item: [
        { stageName: 'prod', deploymentId: 'dep-rest-1' },
        { stageName: '  ', deploymentId: 'ignored' },
        { stageName: 'staging' }
      ]
    });

    const client = new AwsApiGatewaySdkClient('us-east-1');
    await expect(client.listRestStages('rest-1')).resolves.toEqual([
      { stageName: 'prod', deploymentId: 'dep-rest-1' },
      { stageName: 'staging' }
    ]);
  });

  it('exposes HTTP deploymentId/autoDeploy/apiGatewayManaged evidence without fabricating missing fields', async () => {
    apiGatewayV2SendMock.mockResolvedValue({
      Items: [
        { StageName: '$default', DeploymentId: 'dep-http-1', AutoDeploy: true, ApiGatewayManaged: true },
        { StageName: 'preview', DeploymentId: 'dep-http-2' },
        { StageName: '   ' }
      ]
    });

    const client = new AwsApiGatewaySdkClient('us-east-1');
    await expect(client.listHttpStages('http-1')).resolves.toEqual([
      {
        stageName: '$default',
        deploymentId: 'dep-http-1',
        autoDeploy: true,
        apiGatewayManaged: true
      },
      { stageName: 'preview', deploymentId: 'dep-http-2' }
    ]);
  });

});

describe('S3SdkClient bounded exact-object reads', () => {
  it('rejects oversized ContentLength before buffering the body', async () => {
    const client = new S3SdkClient('us-east-1', { maxObjectBytes: 16 });
    const send = vi.fn().mockResolvedValue({
      ContentLength: 64,
      Body: {
        transformToByteArray: vi.fn().mockResolvedValue(new Uint8Array(64))
      }
    });
    (client as unknown as { client: { send: typeof send } }).client = { send };

    await expect(client.getObject('bucket', 'key')).rejects.toThrow(/S3 object too large \(64 bytes\); limit is 16/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('streams async bodies and cancels once the deterministic byte limit is exceeded', async () => {
    const client = new S3SdkClient('us-east-1', { maxObjectBytes: 8 });
    const cancel = vi.fn().mockResolvedValue(undefined);
    let reads = 0;
    const send = vi.fn().mockResolvedValue({
      ContentLength: 4,
      Body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            if (reads === 1) return { done: false, value: new Uint8Array([1, 2, 3, 4]) };
            if (reads === 2) return { done: false, value: new Uint8Array([5, 6, 7, 8, 9]) };
            return { done: true, value: undefined };
          },
          cancel
        })
      }
    });
    (client as unknown as { client: { send: typeof send } }).client = { send };

    await expect(client.getObject('bucket', 'openapi.json')).rejects.toThrow(
      /S3 object body too large \(over 8 bytes\); limit is 8/
    );
    expect(cancel).toHaveBeenCalled();
  });

  it('accepts bounded exact-object bodies under the default limit', async () => {
    const client = new S3SdkClient('us-east-1');
    const payload = '{"openapi":"3.0.3","paths":{}}';
    const send = vi.fn().mockResolvedValue({
      ContentLength: Buffer.byteLength(payload),
      Body: payload
    });
    (client as unknown as { client: { send: typeof send } }).client = { send };

    await expect(client.getObject('specs', 'orders.json', 'v1')).resolves.toBe(payload);
    expect(MAX_S3_OBJECT_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('released AWS client finite pagination', () => {
  it('EventBridge listRules aggregates pages and rejects repeated token / page-cap', async () => {
    const client = new EventBridgeSurfaceSdkClient('us-east-1');
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Rules: [{ Name: 'rule-1', Arn: 'arn:aws:events:us-east-1:1:rule/rule-1' }],
        NextToken: 'page-2'
      })
      .mockResolvedValueOnce({
        Rules: [{ Name: 'rule-2', Arn: 'arn:aws:events:us-east-1:1:rule/rule-2' }]
      });
    (client as unknown as { events: { send: typeof send } }).events = { send };

    await expect(client.listRules()).resolves.toEqual([
      { name: 'rule-1', arn: 'arn:aws:events:us-east-1:1:rule/rule-1' },
      { name: 'rule-2', arn: 'arn:aws:events:us-east-1:1:rule/rule-2' }
    ]);
    expect(send).toHaveBeenCalledTimes(2);

    send.mockReset();
    send.mockResolvedValue({
      Rules: [{ Name: 'rule-x', Arn: 'arn:aws:events:us-east-1:1:rule/rule-x' }],
      NextToken: 'stuck'
    });
    await expect(client.listRules()).rejects.toThrow(
      'EventBridge ListRules pagination returned a repeated token; aborting'
    );
    expect(send).toHaveBeenCalledTimes(2);

    send.mockReset();
    let pages = 0;
    send.mockImplementation(async () => {
      pages += 1;
      return {
        Rules: [{ Name: `rule-${pages}`, Arn: `arn:aws:events:us-east-1:1:rule/rule-${pages}` }],
        NextToken: `tok-${pages + 1}`
      };
    });
    await expect(client.listRules()).rejects.toThrow(
      `EventBridge ListRules pagination exceeded ${MAX_AWS_LIST_PAGES} pages; aborting`
    );
    expect(pages).toBe(MAX_AWS_LIST_PAGES);
  });

  it('SSM listSpecParameters aggregates pages and rejects repeated token / page-cap', async () => {
    const client = new SsmSdkClient('us-east-1');
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Parameters: [{ Name: '/postman/specs/auth/url', Value: 'https://example.invalid/a' }],
        NextToken: 'page-2'
      })
      .mockResolvedValueOnce({
        Parameters: [{ Name: '/postman/specs/auth/content', Value: '{"openapi":"3.0.3"}' }]
      });
    (client as unknown as { client: { send: typeof send } }).client = { send };

    await expect(client.listSpecParameters()).resolves.toEqual([
      { serviceName: 'auth', key: 'url', value: 'https://example.invalid/a' },
      { serviceName: 'auth', key: 'content', value: '{"openapi":"3.0.3"}' }
    ]);

    send.mockReset();
    send.mockResolvedValue({
      Parameters: [{ Name: '/postman/specs/auth/url', Value: 'https://example.invalid/a' }],
      NextToken: 'stuck'
    });
    await expect(client.listSpecParameters()).rejects.toThrow(
      'SSM GetParametersByPath pagination returned a repeated token; aborting'
    );
    expect(send).toHaveBeenCalledTimes(2);

    send.mockReset();
    let pages = 0;
    send.mockImplementation(async () => {
      pages += 1;
      return {
        Parameters: [{ Name: `/postman/specs/svc/k-${pages}`, Value: `v-${pages}` }],
        NextToken: `tok-${pages + 1}`
      };
    });
    await expect(client.listSpecParameters()).rejects.toThrow(
      `SSM GetParametersByPath pagination exceeded ${MAX_AWS_LIST_PAGES} pages; aborting`
    );
    expect(pages).toBe(MAX_AWS_LIST_PAGES);
  });

  it('CloudFormation listActiveStacks aggregates pages and rejects repeated token / page-cap', async () => {
    const client = new CloudFormationSdkClient('us-east-1');
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        StackSummaries: [{ StackName: 'stack-1', StackId: 'id-1', StackStatus: 'CREATE_COMPLETE' }],
        NextToken: 'page-2'
      })
      .mockResolvedValueOnce({
        StackSummaries: [{ StackName: 'stack-2', StackId: 'id-2', StackStatus: 'UPDATE_COMPLETE' }]
      });
    (client as unknown as { client: { send: typeof send } }).client = { send };

    await expect(client.listActiveStacks()).resolves.toEqual([
      { name: 'stack-1', id: 'id-1', status: 'CREATE_COMPLETE' },
      { name: 'stack-2', id: 'id-2', status: 'UPDATE_COMPLETE' }
    ]);

    send.mockReset();
    send.mockResolvedValue({
      StackSummaries: [{ StackName: 'stack-x', StackId: 'id-x', StackStatus: 'CREATE_COMPLETE' }],
      NextToken: 'stuck'
    });
    await expect(client.listActiveStacks()).rejects.toThrow(
      'CloudFormation ListStacks pagination returned a repeated token; aborting'
    );
    expect(send).toHaveBeenCalledTimes(2);

    send.mockReset();
    let pages = 0;
    send.mockImplementation(async () => {
      pages += 1;
      return {
        StackSummaries: [{ StackName: `stack-${pages}`, StackId: `id-${pages}`, StackStatus: 'CREATE_COMPLETE' }],
        NextToken: `tok-${pages + 1}`
      };
    });
    await expect(client.listActiveStacks()).rejects.toThrow(
      `CloudFormation ListStacks pagination exceeded ${MAX_AWS_LIST_PAGES} pages; aborting`
    );
    expect(pages).toBe(MAX_AWS_LIST_PAGES);
  });

  it('Lambda listFunctions aggregates Marker pages and rejects repeated token / page-cap', async () => {
    const client = new LambdaSdkClient('us-east-1');
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Functions: [{ FunctionName: 'fn-1', FunctionArn: 'arn:aws:lambda:us-east-1:1:function:fn-1', Runtime: 'nodejs20.x' }],
        NextMarker: 'page-2'
      })
      .mockResolvedValueOnce({
        Functions: [{ FunctionName: 'fn-2', FunctionArn: 'arn:aws:lambda:us-east-1:1:function:fn-2', Runtime: 'python3.12' }]
      });
    (client as unknown as { client: { send: typeof send } }).client = { send };

    await expect(client.listFunctions()).resolves.toEqual([
      { name: 'fn-1', arn: 'arn:aws:lambda:us-east-1:1:function:fn-1', runtime: 'nodejs20.x' },
      { name: 'fn-2', arn: 'arn:aws:lambda:us-east-1:1:function:fn-2', runtime: 'python3.12' }
    ]);

    send.mockReset();
    send.mockResolvedValue({
      Functions: [{ FunctionName: 'fn-x', FunctionArn: 'arn:aws:lambda:us-east-1:1:function:fn-x' }],
      NextMarker: 'stuck'
    });
    await expect(client.listFunctions()).rejects.toThrow(
      'Lambda ListFunctions pagination returned a repeated token; aborting'
    );
    expect(send).toHaveBeenCalledTimes(2);

    send.mockReset();
    let pages = 0;
    send.mockImplementation(async () => {
      pages += 1;
      return {
        Functions: [{ FunctionName: `fn-${pages}`, FunctionArn: `arn:aws:lambda:us-east-1:1:function:fn-${pages}` }],
        NextMarker: `tok-${pages + 1}`
      };
    });
    await expect(client.listFunctions()).rejects.toThrow(
      `Lambda ListFunctions pagination exceeded ${MAX_AWS_LIST_PAGES} pages; aborting`
    );
    expect(pages).toBe(MAX_AWS_LIST_PAGES);
  });

  it('EventBridge Schemas and Glue listRegistries reject repeated token / page-cap', async () => {
    const schemas = new EventBridgeSchemasSdkClient('us-east-1');
    const schemasSend = vi.fn().mockResolvedValue({
      Registries: [{ RegistryName: 'reg-1', RegistryArn: 'arn:schemas:reg-1' }],
      NextToken: 'stuck'
    });
    (schemas as unknown as { client: { send: typeof schemasSend } }).client = { send: schemasSend };
    await expect(schemas.listRegistries()).rejects.toThrow(
      'EventBridge Schemas ListRegistries pagination returned a repeated token; aborting'
    );
    expect(schemasSend).toHaveBeenCalledTimes(2);

    const glue = new GlueSchemaSdkClient('us-east-1');
    let pages = 0;
    const glueSend = vi.fn().mockImplementation(async () => {
      pages += 1;
      return {
        Registries: [{ RegistryName: `reg-${pages}`, RegistryArn: `arn:glue:reg-${pages}` }],
        NextToken: `tok-${pages + 1}`
      };
    });
    (glue as unknown as { client: { send: typeof glueSend } }).client = { send: glueSend };
    await expect(glue.listRegistries()).rejects.toThrow(
      `Glue ListRegistries pagination exceeded ${MAX_AWS_LIST_PAGES} pages; aborting`
    );
    expect(pages).toBe(MAX_AWS_LIST_PAGES);
  });
});

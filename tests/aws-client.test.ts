import { parse } from 'yaml';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AwsApiGatewaySdkClient } from '../src/lib/aws/client.js';

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

  it('terminates REST enrichment pagination when a position token cycle repeats', async () => {
    const calls = new Map<string, number>();
    apiGatewayRestSendMock.mockImplementation(async (command: { constructor: { name: string } }) => {
      const name = command.constructor.name;
      if (name === 'GetExportCommand') {
        return { body: Buffer.from('openapi: 3.0.1\ninfo: { title: t, version: "1" }\npaths: {}') };
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
    await client.exportRestApi('rest-1', 'prod');

    for (const name of ['GetResourcesCommand', 'GetModelsCommand', 'GetRequestValidatorsCommand']) {
      expect(calls.get(name), name).toBe(3);
    }
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

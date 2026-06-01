import { parse } from 'yaml';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AwsApiGatewaySdkClient } from '../src/lib/aws/client.js';

const { apiGatewayV2SendMock } = vi.hoisted(() => ({
  apiGatewayV2SendMock: vi.fn()
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

describe('AwsApiGatewaySdkClient', () => {
  beforeEach(() => {
    apiGatewayV2SendMock.mockReset();
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
});

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { synthesizeWebSocketOpenApi } from '../src/lib/spec/websocket-openapi.js';

describe('synthesizeWebSocketOpenApi', () => {
  it('preserves WebSocket route models, integrations, authorizers, and route responses', () => {
    const content = synthesizeWebSocketOpenApi({
      apiId: 'ws-123',
      apiName: 'orders-websocket',
      region: 'us-east-1',
      stage: 'prod',
      routeSelectionExpression: '$request.body.action',
      routes: [
        {
          routeId: 'route-1',
          routeKey: 'sendMessage',
          apiKeyRequired: true,
          authorizationType: 'CUSTOM',
          authorizationScopes: ['orders:write'],
          authorizerId: 'authorizer-1',
          operationName: 'sendOrderMessage',
          modelSelectionExpression: '$request.body.messageType',
          requestModels: { 'application/json': 'OrderMessage' },
          requestParameters: {
            'route.request.header.Authorization': { Required: true }
          },
          routeResponseSelectionExpression: '$default',
          target: 'integrations/integration-1',
          integration: {
            integrationId: 'integration-1',
            integrationType: 'AWS_PROXY',
            integrationUri: 'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/function-arn/invocations',
            integrationMethod: 'POST',
            requestParameters: {
              'integration.request.header.TraceId': 'route.request.header.TraceId'
            },
            requestTemplates: {
              'application/json': '{"action":"$input.path(\'$.action\')"}'
            },
            templateSelectionExpression: '$request.body.template',
            timeoutInMillis: 29000
          },
          authorizer: {
            authorizerId: 'authorizer-1',
            authorizerType: 'REQUEST',
            authorizerUri: 'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/authorizer-arn/invocations',
            identitySource: ['route.request.header.Authorization']
          },
          routeResponses: [
            {
              routeResponseId: 'response-1',
              routeResponseKey: '$default',
              modelSelectionExpression: '$default',
              responseModels: { 'application/json': 'OrderAck' },
              responseParameters: {
                'route.response.header.RequestId': { Required: false }
              }
            }
          ]
        }
      ],
      models: [
        {
          name: 'OrderMessage',
          contentType: 'application/json',
          schema: '{"type":"object","required":["orderId"],"properties":{"orderId":{"type":"string"}}}'
        },
        {
          name: 'OrderAck',
          contentType: 'application/json',
          schema: '{"type":"object","properties":{"accepted":{"type":"boolean"}}}'
        }
      ]
    });

    const document = parse(content);
    const operation = document.paths['/sendMessage'].post;

    expect(operation.operationId).toBe('sendOrderMessage');
    expect(document.components.schemas.OrderMessage.required).toEqual(['orderId']);
    expect(document.components.schemas.OrderAck.properties.accepted.type).toBe('boolean');
    expect(operation.requestBody.content['application/json'].schema).toEqual({ $ref: '#/components/schemas/OrderMessage' });
    expect(operation['x-amazon-apigateway-route-id']).toBe('route-1');
    expect(operation['x-amazon-apigateway-api-key-required']).toBe(true);
    expect(operation['x-amazon-apigateway-authorization-scopes']).toEqual(['orders:write']);
    expect(operation['x-amazon-apigateway-model-selection-expression']).toBe('$request.body.messageType');
    expect(operation['x-amazon-apigateway-request-parameters']).toEqual({
      'route.request.header.Authorization': { Required: true }
    });
    expect(operation['x-amazon-apigateway-integration']).toEqual(
      expect.objectContaining({
        integrationId: 'integration-1',
        type: 'AWS_PROXY',
        uri: 'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/function-arn/invocations',
        httpMethod: 'POST',
        requestParameters: {
          'integration.request.header.TraceId': 'route.request.header.TraceId'
        },
        requestTemplates: {
          'application/json': '{"action":"$input.path(\'$.action\')"}'
        },
        templateSelectionExpression: '$request.body.template',
        timeoutInMillis: 29000
      })
    );
    expect(operation['x-amazon-apigateway-authorizer']).toEqual({
      authorizerId: 'authorizer-1',
      type: 'REQUEST',
      uri: 'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/authorizer-arn/invocations',
      identitySource: ['route.request.header.Authorization']
    });
    expect(operation['x-amazon-apigateway-route-responses']).toEqual([
      {
        routeResponseId: 'response-1',
        routeResponseKey: '$default',
        modelSelectionExpression: '$default',
        responseModels: { 'application/json': 'OrderAck' },
        responseParameters: {
          'route.response.header.RequestId': { Required: false }
        }
      }
    ]);
  });
});

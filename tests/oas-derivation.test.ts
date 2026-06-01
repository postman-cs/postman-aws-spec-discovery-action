import { describe, expect, it } from 'vitest';

import { deriveOpenApiDocument } from '../src/lib/spec/oas-derivation.js';

describe('deriveOpenApiDocument', () => {
  it('passes through OpenAPI 3.x documents as full derivations', () => {
    const result = deriveOpenApiDocument({
      content: 'openapi: 3.0.3\ninfo:\n  title: Orders\n  version: "1.0.0"\npaths: {}\n',
      format: 'openapi-yaml',
      title: 'Orders'
    });

    expect(result.completeness).toBe('full');
    expect(result.content).toContain('openapi: 3.0.3');
  });

  it('does not mark mislabeled non-OAS JSON as a full derivation', () => {
    const result = deriveOpenApiDocument({
      content: '{"specUrl":"https://example.invalid/openapi.yaml","fetchError":"failed"}',
      format: 'openapi-json',
      title: 'Pointer'
    });

    expect(result.completeness).toBe('partial');
    expect(result.content).toContain('"openapi": "3.1.0"');
  });

  it('derives partial OAS 3.1 for GraphQL SDL', () => {
    const result = deriveOpenApiDocument({
      content: 'type Query { order(id: ID!): Order }\ntype Order { id: ID! }',
      format: 'graphql-sdl',
      title: 'Orders GraphQL'
    });

    expect(result.completeness).toBe('partial');
    expect(result.content).toContain('"openapi": "3.1.0"');
    expect(result.content).toContain('"/graphql"');
  });

  it('derives GraphQL operation names, variables, and schema components from SDL', () => {
    const result = deriveOpenApiDocument({
      content: [
        'type Query { order(id: ID!): Order }',
        'type Mutation { createOrder(input: OrderInput!): Order }',
        'input OrderInput { id: ID!, total: Float }',
        'type Order { id: ID!, total: Float }'
      ].join('\n'),
      format: 'graphql-sdl',
      title: 'Orders GraphQL'
    });

    const document = JSON.parse(result.content);
    const operation = document.paths['/graphql'].post;
    const bodySchema = operation.requestBody.content['application/json'].schema;

    expect(operation.summary).toContain('order');
    expect(operation.summary).toContain('createOrder');
    expect(operation['x-graphql-operations'].map((entry: { name: string }) => entry.name)).toEqual(['order', 'createOrder']);
    expect(bodySchema.properties.operationName.enum).toEqual(['order', 'createOrder']);
    expect(bodySchema.properties.variables.oneOf[0].required).toEqual(['id']);
    expect(bodySchema.properties.variables.oneOf[0].properties.id.type).toBe('string');
    expect(document.components.schemas.Order.properties.total.type).toBe('number');
  });

  it('derives partial OAS 3.1 webhooks for AsyncAPI', () => {
    const result = deriveOpenApiDocument({
      content: 'asyncapi: 2.6.0\ninfo:\n  title: Events\nchannels:\n  order.created:\n    subscribe:\n      message:\n        payload:\n          type: object\n',
      format: 'asyncapi-yaml',
      title: 'Events'
    });

    expect(result.content).toContain('"openapi": "3.1.0"');
    expect(result.content).toContain('"webhooks"');
    expect(result.content).toContain('"order_created"');
  });

  it('preserves AsyncAPI channel schemas, direction, and examples in derived webhooks', () => {
    const result = deriveOpenApiDocument({
      content: [
        'asyncapi: 2.6.0',
        'info:',
        '  title: Order Events',
        '  version: 1.0.0',
        'channels:',
        '  order.created:',
        '    subscribe:',
        '      message:',
        '        name: OrderCreated',
        '        payload:',
        '          $ref: "#/components/schemas/OrderCreated"',
        '        examples:',
        '          - name: created',
        '            payload:',
        '              id: ord_123',
        'components:',
        '  schemas:',
        '    OrderCreated:',
        '      type: object',
        '      required: [id]',
        '      properties:',
        '        id:',
        '          type: string'
      ].join('\n'),
      format: 'asyncapi-yaml',
      title: 'Order Events'
    });

    const document = JSON.parse(result.content);
    const operation = document.webhooks.order_created.post;
    const media = operation.requestBody.content['application/json'];

    expect(operation['x-asyncapi-channel']).toBe('order.created');
    expect(operation['x-asyncapi-operation']).toBe('subscribe');
    expect(media.schema).toEqual({ $ref: '#/components/schemas/OrderCreated' });
    expect(media.examples.created.value).toEqual({ id: 'ord_123' });
    expect(document.components.schemas.OrderCreated.required).toEqual(['id']);
  });

  it('derives partial paths from Postman collections, protobuf, Smithy, and Avro', () => {
    const postman = deriveOpenApiDocument({
      content: JSON.stringify({
        info: { name: 'Postman API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: [{ name: 'List orders', request: { method: 'GET', url: { path: ['orders'] } } }]
      }),
      format: 'postman-collection'
    });
    const proto = deriveOpenApiDocument({
      content: 'syntax = "proto3"; service OrderService { rpc GetOrder (GetOrderRequest) returns (Order); }',
      format: 'protobuf',
      title: 'Orders Proto'
    });
    const smithy = deriveOpenApiDocument({
      content: '$version: "2"\nnamespace demo\nservice Orders { operations: [GetOrder] }\noperation GetOrder {}',
      format: 'smithy',
      title: 'Orders Smithy'
    });
    const avro = deriveOpenApiDocument({
      content: '{"type":"record","name":"OrderEvent","fields":[{"name":"id","type":"string"}]}',
      format: 'avro',
      title: 'Order Event'
    });

    expect(postman.content).toContain('"/orders"');
    expect(proto.content).toContain('"/OrderService/GetOrder"');
    expect(smithy.content).toContain('"/Orders/GetOrder"');
    expect(avro.content).toContain('"OrderEvent"');
  });

  it('preserves Postman query params, headers, body, auth, and response examples', () => {
    const result = deriveOpenApiDocument({
      content: JSON.stringify({
        info: { name: 'Orders Collection', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: [
          {
            name: 'Create order',
            request: {
              method: 'POST',
              url: {
                raw: 'https://api.example.test/orders?status=open',
                path: ['orders'],
                query: [{ key: 'status', value: 'open' }]
              },
              header: [{ key: 'X-Trace-Id', value: 'trace-123' }],
              auth: { type: 'bearer' },
              body: { mode: 'raw', raw: '{"id":"ord_123"}', options: { raw: { language: 'json' } } }
            },
            response: [{ name: 'created', code: 201, body: '{"id":"ord_123","status":"created"}' }]
          }
        ]
      }),
      format: 'postman-collection'
    });

    const document = JSON.parse(result.content);
    const operation = document.paths['/orders'].post;
    const requestMedia = operation.requestBody.content['application/json'];
    const responseMedia = operation.responses['201'].content['application/json'];

    expect(operation.parameters).toEqual([
      expect.objectContaining({ name: 'status', in: 'query', example: 'open' }),
      expect.objectContaining({ name: 'X-Trace-Id', in: 'header', example: 'trace-123' })
    ]);
    expect(operation['x-postman-auth-type']).toBe('bearer');
    expect(requestMedia.example).toEqual({ id: 'ord_123' });
    expect(requestMedia.schema.properties.id.type).toBe('string');
    expect(responseMedia.example.status).toBe('created');
  });

  it('preserves JSON Schema and Avro names as OpenAPI components', () => {
    const jsonSchema = deriveOpenApiDocument({
      content: JSON.stringify({
        $id: 'https://schemas.example.test/OrderCreated',
        title: 'OrderCreated',
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } }
      }),
      format: 'json-schema',
      title: 'Order Events'
    });
    const avro = deriveOpenApiDocument({
      content: JSON.stringify({
        type: 'record',
        name: 'OrderEvent',
        fields: [
          { name: 'id', type: 'string' },
          { name: 'total', type: 'double' }
        ]
      }),
      format: 'avro',
      title: 'Order Events'
    });

    const jsonDocument = JSON.parse(jsonSchema.content);
    const avroDocument = JSON.parse(avro.content);

    expect(jsonDocument.paths['/order-created'].post.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/OrderCreated'
    });
    expect(jsonDocument.components.schemas.OrderCreated.required).toEqual(['id']);
    expect(avroDocument.paths['/order-event'].post.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/OrderEvent'
    });
    expect(avroDocument.components.schemas.OrderEvent.properties.total.type).toBe('number');
  });

  it('derives protobuf message schemas and RPC request/response bodies', () => {
    const result = deriveOpenApiDocument({
      content: [
        'syntax = "proto3";',
        'package validation.orders;',
        'service OrderService {',
        '  rpc CreateOrder (CreateOrderRequest) returns (Order);',
        '}',
        'message CreateOrderRequest {',
        '  string id = 1;',
        '  repeated string item_ids = 2;',
        '  int32 quantity = 3;',
        '}',
        'message Order {',
        '  string id = 1;',
        '  bool accepted = 2;',
        '}'
      ].join('\n'),
      format: 'protobuf',
      title: 'Orders Proto'
    });

    const document = JSON.parse(result.content);
    const operation = document.paths['/OrderService/CreateOrder'].post;

    expect(operation.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/CreateOrderRequest'
    });
    expect(operation.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/Order'
    });
    expect(operation['x-protobuf-package']).toBe('validation.orders');
    expect(document.components.schemas.CreateOrderRequest.properties.item_ids).toEqual({
      type: 'array',
      items: { type: 'string' }
    });
    expect(document.components.schemas.CreateOrderRequest.properties.quantity.type).toBe('integer');
    expect(document.components.schemas.Order.properties.accepted.type).toBe('boolean');
  });

  it('derives Smithy operation inputs, outputs, errors, and required members', () => {
    const result = deriveOpenApiDocument({
      content: [
        '$version: "2"',
        'namespace validation',
        'service Orders {',
        '  operations: [CreateOrder]',
        '}',
        'operation CreateOrder {',
        '  input: CreateOrderInput,',
        '  output: CreateOrderOutput,',
        '  errors: [OrderError]',
        '}',
        'structure CreateOrderInput {',
        '  @required',
        '  id: String,',
        '  quantity: Integer',
        '}',
        'structure CreateOrderOutput {',
        '  accepted: Boolean',
        '}',
        'structure OrderError {',
        '  message: String',
        '}'
      ].join('\n'),
      format: 'smithy',
      title: 'Orders Smithy'
    });

    const document = JSON.parse(result.content);
    const operation = document.paths['/Orders/CreateOrder'].post;

    expect(operation.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/CreateOrderInput'
    });
    expect(operation.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/CreateOrderOutput'
    });
    expect(operation.responses.default.content['application/json'].schema.oneOf).toEqual([
      { $ref: '#/components/schemas/OrderError' }
    ]);
    expect(operation['x-smithy-errors']).toEqual(['OrderError']);
    expect(document.components.schemas.CreateOrderInput.required).toEqual(['id']);
    expect(document.components.schemas.CreateOrderInput.properties.quantity.type).toBe('integer');
    expect(document.components.schemas.CreateOrderOutput.properties.accepted.type).toBe('boolean');
  });
});

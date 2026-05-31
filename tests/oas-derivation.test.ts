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
});

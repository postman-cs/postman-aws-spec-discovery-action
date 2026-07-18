import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import {
  mergeRestApiModelsAndValidators,
  type MergeRestApiModelsInput,
  type RestApiFallbackResource
} from '../src/lib/spec/rest-api-fallback-openapi.js';

const createOrderSchema = JSON.stringify({
  type: 'object',
  required: ['sku'],
  properties: { sku: { type: 'string' }, quantity: { type: 'integer' } }
});

function baseNative(): Record<string, unknown> {
  return {
    openapi: '3.0.1',
    info: { title: 'orders-api', version: '1' },
    paths: {
      '/orders': {
        post: {
          operationId: 'createOrder',
          responses: { '200': { description: 'OK' } }
        }
      },
      '/health': {
        get: {
          operationId: 'health',
          responses: { '200': { description: 'OK' } }
        }
      }
    }
  };
}

const modeledResources: RestApiFallbackResource[] = [
  {
    path: '/orders',
    resourceMethods: {
      POST: {
        httpMethod: 'POST',
        requestModels: { 'application/json': 'CreateOrder' },
        ...( { requestValidatorId: 'val1' } as object)
      }
    }
  },
  { path: '/health', resourceMethods: { GET: { httpMethod: 'GET' } } }
];

function mergeInput(overrides: Partial<MergeRestApiModelsInput> = {}): MergeRestApiModelsInput {
  return {
    nativeExport: stringify(baseNative()),
    resources: modeledResources,
    models: [{ name: 'CreateOrder', schema: createOrderSchema, contentType: 'application/json' }],
    validators: [{ id: 'val1', name: 'body-and-params', validateRequestBody: true, validateRequestParameters: true }],
    ...overrides
  };
}

/** Collect every leaf path of a JSON-safe value as [path, value] pairs. */
function leafPaths(value: unknown, prefix = ''): Array<[string, unknown]> {
  if (value === null || typeof value !== 'object') {
    return [[prefix, value]];
  }
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return [[prefix, Array.isArray(value) ? '[]' : '{}']];
  }
  return entries.flatMap(([key, item]) => leafPaths(item, prefix ? `${prefix}.${key}` : key));
}

describe('mergeRestApiModelsAndValidators', () => {
  it('U6.1 fills missing model schema, media $ref, root validators, and operation validator', () => {
    const output = mergeRestApiModelsAndValidators(mergeInput());
    const parsed = parse(output) as Record<string, never>;
    expect(parsed.components?.['schemas']?.['CreateOrder']).toEqual(JSON.parse(createOrderSchema));
    const post = parsed.paths?.['/orders']?.['post'] as Record<string, never>;
    expect(post?.requestBody?.['content']?.['application/json']?.['schema']).toEqual({
      $ref: '#/components/schemas/CreateOrder'
    });
    expect(post?.['x-amazon-apigateway-request-validator']).toBe('body-and-params');
    expect(parsed['x-amazon-apigateway-request-validators']).toEqual({
      'body-and-params': { validateRequestBody: true, validateRequestParameters: true }
    });
    // requestBody.required must not be invented
    expect(Object.prototype.hasOwnProperty.call(post?.requestBody ?? {}, 'required')).toBe(false);
  });

  it('U6.2 preserves conflicting native values at every merge target', () => {
    const native = baseNative();
    (native as never as Record<string, unknown>)['x-amazon-apigateway-request-validators'] = {
      'body-and-params': { validateRequestBody: false, validateRequestParameters: false, custom: 'kept' }
    };
    (native.paths as Record<string, never>)['/orders']['post'] = {
      operationId: 'createOrder',
      'x-amazon-apigateway-request-validator': 'native-validator',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'string', description: 'native wins' }, example: 'kept' } }
      },
      responses: { '200': { description: 'OK' } }
    } as never;
    const nativeWithComponents = {
      ...native,
      components: { schemas: { CreateOrder: { type: 'array', items: { type: 'string' } } } }
    };
    const output = mergeRestApiModelsAndValidators(mergeInput({ nativeExport: stringify(nativeWithComponents) }));
    const parsed = parse(output) as Record<string, never>;
    expect(parsed.components?.['schemas']?.['CreateOrder']).toEqual({ type: 'array', items: { type: 'string' } });
    const post = parsed.paths?.['/orders']?.['post'] as Record<string, never>;
    expect(post?.requestBody).toEqual({
      required: true,
      content: { 'application/json': { schema: { type: 'string', description: 'native wins' }, example: 'kept' } }
    });
    expect(post?.['x-amazon-apigateway-request-validator']).toBe('native-validator');
    expect(parsed['x-amazon-apigateway-request-validators']).toEqual({
      'body-and-params': { validateRequestBody: false, validateRequestParameters: false, custom: 'kept' }
    });
  });

  it('U6.3 additive property: every native leaf survives merge across 100 seeded fixtures', () => {
    // Deterministic LCG with fixed committed seed -- no property-test dependency.
    let seedState = 0xC0FFEE;
    const rand = () => {
      seedState = (seedState * 1103515245 + 12345) % 0x80000000;
      return seedState / 0x80000000;
    };
    const pick = <T,>(items: T[]): T => items[Math.floor(rand() * items.length)] as T;
    const genValue = (depth: number): unknown => {
      if (depth <= 0 || rand() < 0.4) {
        return pick<unknown>(['alpha', 42, true, null, 'beta', 7.5]);
      }
      if (rand() < 0.3) {
        return [genValue(depth - 1), genValue(depth - 1)];
      }
      const obj: Record<string, unknown> = {};
      const keys = ['schema', 'example', 'description', 'items', 'format', 'nullable', 'x-custom'];
      const count = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < count; i += 1) {
        obj[pick(keys) + i] = genValue(depth - 1);
      }
      return obj;
    };

    for (let fixture = 0; fixture < 100; fixture += 1) {
      const native = baseNative();
      const post = (native.paths as Record<string, never>)['/orders']['post'] as Record<string, unknown>;
      if (rand() < 0.5) {
        post.requestBody = genValue(3);
      }
      if (rand() < 0.5) {
        (native as Record<string, unknown>).components = { schemas: { CreateOrder: genValue(2) } };
      }
      if (rand() < 0.3) {
        (native as Record<string, unknown>)['x-amazon-apigateway-request-validators'] = genValue(2);
      }
      const output = mergeRestApiModelsAndValidators(mergeInput({ nativeExport: stringify(native) }));
      const merged = parse(output);
      const mergedLeaves = new Map(leafPaths(merged));
      for (const [leafPath, leafValue] of leafPaths(native)) {
        expect(mergedLeaves.has(leafPath), `missing native leaf ${leafPath} in fixture ${fixture}`).toBe(true);
        expect(mergedLeaves.get(leafPath), `changed native leaf ${leafPath} in fixture ${fixture}`).toEqual(leafValue);
      }
    }
  });

  it('U6.4 skips invalid model JSON, unknown validator IDs, and missing paths/methods without throwing', () => {
    const output = mergeRestApiModelsAndValidators(
      mergeInput({
        models: [{ name: 'CreateOrder', schema: '{invalid json', contentType: 'application/json' }],
        validators: [{ id: 'other', name: 'other-validator', validateRequestBody: true, validateRequestParameters: false }],
        resources: [
          {
            path: '/missing',
            resourceMethods: { POST: { httpMethod: 'POST', requestModels: { 'application/json': 'CreateOrder' } } }
          },
          {
            path: '/orders',
            resourceMethods: { PUT: { httpMethod: 'PUT', requestModels: { 'application/json': 'CreateOrder' } } }
          }
        ]
      })
    );
    const parsed = parse(output) as Record<string, never>;
    expect(parsed.components?.['schemas']?.['CreateOrder']).toBeUndefined();
    const post = parsed.paths?.['/orders']?.['post'] as Record<string, unknown>;
    expect(post.requestBody).toBeUndefined();
    expect(post['x-amazon-apigateway-request-validator']).toBeUndefined();
    // unknown validator still lands at root (additive, harmless)
    expect(parsed['x-amazon-apigateway-request-validators']).toEqual({
      'other-validator': { validateRequestBody: true, validateRequestParameters: false }
    });
  });

  it('U6.7 leaves route-only operations without invented request bodies', () => {
    const output = mergeRestApiModelsAndValidators(mergeInput());
    const parsed = parse(output) as Record<string, never>;
    const health = parsed.paths?.['/health']?.['get'] as Record<string, unknown>;
    expect(health.requestBody).toBeUndefined();
    expect(health['x-amazon-apigateway-request-validator']).toBeUndefined();
  });

  it('returns the exact original string for non-OpenAPI input', () => {
    for (const nativeExport of ['not: openapi', '{"no": "paths"}', '::: garbage :::']) {
      expect(mergeRestApiModelsAndValidators(mergeInput({ nativeExport }))).toBe(nativeExport);
    }
  });
});

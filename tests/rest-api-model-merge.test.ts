import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import {
  mergeRestApiModelsAndValidators,
  synthesizeRestApiFallbackOpenApi,
  type MergeRestApiModelsInput,
  type RestApiFallbackResource
} from '../src/lib/spec/rest-api-fallback-openapi.js';
import {
  auditOpenApiContractCoverage,
  formatOpenApiContractAuditWarning
} from '../src/lib/spec/normalize-openapi.js';

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

const orderAckSchema = JSON.stringify({
  type: 'object',
  properties: { orderId: { type: 'string' }, accepted: { type: 'boolean' } }
});

interface ParsedPostOperation {
  requestBody?: unknown;
  responses: Record<string, { content: Record<string, { schema: unknown }> }>;
}

interface ParsedOpenApiDocument {
  paths: Record<string, { post: ParsedPostOperation }>;
}

const modeledResources: RestApiFallbackResource[] = [
  {
    path: '/orders',
    resourceMethods: {
      POST: {
        httpMethod: 'POST',
        requestModels: { 'application/json': 'CreateOrder' },
        methodResponses: {
          '200': {
            statusCode: '200',
            responseModels: { 'application/json': 'OrderAck' }
          }
        },
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
    models: [
      { name: 'CreateOrder', schema: createOrderSchema, contentType: 'application/json' },
      { name: 'OrderAck', schema: orderAckSchema, contentType: 'application/json' }
    ],
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
    expect(parsed.components?.['schemas']?.['OrderAck']).toEqual(JSON.parse(orderAckSchema));
    const post = parsed.paths?.['/orders']?.['post'] as Record<string, never>;
    expect(post?.requestBody?.['content']?.['application/json']?.['schema']).toEqual({
      $ref: '#/components/schemas/CreateOrder'
    });
    expect(post?.responses?.['200']?.['content']?.['application/json']?.['schema']).toEqual({
      $ref: '#/components/schemas/OrderAck'
    });
    expect(post?.['x-amazon-apigateway-request-validator']).toBe('body-and-params');
    expect(parsed['x-amazon-apigateway-request-validators']).toEqual({
      'body-and-params': { validateRequestBody: true, validateRequestParameters: true }
    });
    // requestBody.required must not be invented
    expect(Object.prototype.hasOwnProperty.call(post?.requestBody ?? {}, 'required')).toBe(false);
  });

  it('U6.1b maps methodResponses responseModels into response content schema $refs', () => {
    const native = baseNative();
    (native.paths as Record<string, never>)['/orders']['post'] = {
      operationId: 'createOrder',
      responses: {
        '200': { description: 'OK' },
        '400': { description: 'Bad Request' }
      }
    } as never;
    const output = mergeRestApiModelsAndValidators(
      mergeInput({
        nativeExport: stringify(native),
        resources: [
          {
            path: '/orders',
            resourceMethods: {
              POST: {
                httpMethod: 'POST',
                methodResponses: {
                  '200': {
                    statusCode: '200',
                    responseModels: { 'application/json': 'OrderAck' }
                  },
                  '400': {
                    statusCode: '400',
                    responseModels: { 'application/json': 'MissingModel' }
                  }
                }
              }
            }
          }
        ]
      })
    );
    const parsed = parse(output) as Record<string, never>;
    const post = parsed.paths?.['/orders']?.['post'] as Record<string, never>;
    expect(post?.responses?.['200']).toEqual({
      description: 'OK',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/OrderAck' } }
      }
    });
    // MissingModel was never collected into components.schemas — leave status untouched
    expect(post?.responses?.['400']).toEqual({ description: 'Bad Request' });
  });

  it('leaves a native response $ref byte-for-byte without sibling content', () => {
    const nativeResponseRef = { $ref: '#/components/responses/OrderAckResponse' };
    const native = baseNative();
    (native.paths as Record<string, never>)['/orders']['post'] = {
      operationId: 'createOrder',
      responses: {
        '200': nativeResponseRef
      }
    } as never;
    const output = mergeRestApiModelsAndValidators(
      mergeInput({
        nativeExport: stringify(native),
        resources: [
          {
            path: '/orders',
            resourceMethods: {
              POST: {
                httpMethod: 'POST',
                methodResponses: {
                  '200': {
                    statusCode: '200',
                    responseModels: { 'application/json': 'OrderAck' }
                  }
                }
              }
            }
          }
        ]
      })
    );
    const parsed = parse(output) as Record<string, never>;
    const response200 = parsed.paths?.['/orders']?.['post']?.['responses']?.['200'];
    expect(response200).toEqual(nativeResponseRef);
    expect(Object.keys(response200 as object)).toEqual(['$ref']);
    expect(Object.prototype.hasOwnProperty.call(response200 as object, 'content')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(response200 as object, 'description')).toBe(false);
  });

  it('maps default response keys and non-JSON response media types without overwriting native media', () => {
    const native = baseNative();
    (native.paths as Record<string, never>)['/orders']['post'] = {
      operationId: 'createOrder',
      responses: {
        default: { description: 'Fallback response' },
        '200': { description: 'OK', content: { 'application/json': { schema: { type: 'string' } } } }
      }
    } as never;
    const output = mergeRestApiModelsAndValidators(mergeInput({
      nativeExport: stringify(native),
      resources: [{
        path: '/orders',
        resourceMethods: {
          POST: {
            methodResponses: {
              default: { responseModels: { 'application/problem+json': 'OrderAck' } },
              '200': { responseModels: { 'application/json': 'OrderAck' } }
            }
          }
        }
      }]
    }));
    const post = (parse(output) as ParsedOpenApiDocument).paths['/orders'].post;
    expect(post.responses.default.content['application/problem+json'].schema).toEqual({ $ref: '#/components/schemas/OrderAck' });
    expect(post.responses['200'].content['application/json'].schema).toEqual({ type: 'string' });
  });

  it('does not synthesize dangling model refs when fallback model JSON is unavailable', () => {
    const output = synthesizeRestApiFallbackOpenApi({
      apiId: 'rest-1',
      apiName: 'orders',
      region: 'us-east-1',
      models: [{ name: 'Known', schema: '{"type":"object"}' }, { name: 'Broken', schema: '{invalid' }],
      resources: [{
        path: '/orders',
        resourceMethods: {
          POST: {
            requestModels: { 'application/json': 'Broken' },
            methodResponses: { '200': { responseModels: { 'application/problem+json': 'Broken', 'application/json': 'Known' } } }
          }
        }
      }]
    });
    const post = (parse(output) as ParsedOpenApiDocument).paths['/orders'].post;
    expect(post.requestBody).toEqual({});
    expect(post.responses['200'].content).toEqual({ 'application/json': { schema: { $ref: '#/components/schemas/Known' } } });
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
      responses: {
        '200': {
          description: 'native response',
          content: {
            'application/json': {
              schema: { type: 'object', description: 'native response schema' },
              example: { kept: true }
            }
          }
        }
      }
    } as never;
    const nativeWithComponents = {
      ...native,
      components: {
        schemas: {
          CreateOrder: { type: 'array', items: { type: 'string' } },
          OrderAck: { type: 'string', description: 'native OrderAck' }
        }
      }
    };
    const output = mergeRestApiModelsAndValidators(mergeInput({ nativeExport: stringify(nativeWithComponents) }));
    const parsed = parse(output) as Record<string, never>;
    expect(parsed.components?.['schemas']?.['CreateOrder']).toEqual({ type: 'array', items: { type: 'string' } });
    expect(parsed.components?.['schemas']?.['OrderAck']).toEqual({ type: 'string', description: 'native OrderAck' });
    const post = parsed.paths?.['/orders']?.['post'] as Record<string, never>;
    expect(post?.requestBody).toEqual({
      required: true,
      content: { 'application/json': { schema: { type: 'string', description: 'native wins' }, example: 'kept' } }
    });
    expect(post?.responses?.['200']).toEqual({
      description: 'native response',
      content: {
        'application/json': {
          schema: { type: 'object', description: 'native response schema' },
          example: { kept: true }
        }
      }
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

  it('enriched responseModels make the contract audit schema-complete without incomplete warnings', () => {
    const native = baseNative();
    (native.paths as Record<string, never>)['/orders']['post'] = {
      operationId: 'createOrder',
      responses: { '200': { description: 'OK' } }
    } as never;
    delete (native.paths as Record<string, unknown>)['/health'];
    const merged = mergeRestApiModelsAndValidators(
      mergeInput({
        nativeExport: stringify(native),
        resources: [
          {
            path: '/orders',
            resourceMethods: {
              POST: {
                httpMethod: 'POST',
                requestModels: { 'application/json': 'CreateOrder' },
                methodResponses: {
                  '200': {
                    statusCode: '200',
                    responseModels: { 'application/json': 'OrderAck' }
                  }
                }
              }
            }
          }
        ]
      })
    );
    const audit = auditOpenApiContractCoverage(parse(merged));
    expect(audit).toMatchObject({
      status: 'schema-complete',
      responsesWithoutContent: 0,
      responseMediaTypesWithoutSchema: 0,
      requestMediaTypesWithoutSchema: 0
    });
    expect(formatOpenApiContractAuditWarning(audit!, 'REST')).toBeUndefined();
  });
});

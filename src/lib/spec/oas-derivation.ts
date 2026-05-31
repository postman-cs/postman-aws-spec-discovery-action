import { parse } from 'yaml';

import type { SpecFormat } from '../../contracts.js';

export interface OpenApiDerivationInput {
  content: string;
  format: SpecFormat;
  title?: string;
}

export interface OpenApiDerivationResult {
  content: string;
  format: 'openapi-json' | 'openapi-yaml';
  version: '3.0.3' | '3.1.0';
  completeness: 'full' | 'partial';
  evidence: string[];
}

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, unknown>;
  webhooks?: Record<string, unknown>;
  components?: Record<string, unknown>;
}

export function deriveOpenApiDocument(input: OpenApiDerivationInput): OpenApiDerivationResult {
  const title = input.title?.trim() || titleFromContent(input.content) || 'Discovered API';
  if (input.content.trim().startsWith('swagger:') || input.content.trim().startsWith('{"swagger"')) {
    return jsonResult(swaggerToOpenApi(input.content, title), '3.0.3', 'Converted Swagger 2.0 paths to OpenAPI 3.0');
  }
  if (input.format === 'openapi-json' || input.format === 'openapi-yaml') {
    const version = openApiVersion(input.content);
    if (!version) {
      return jsonResult(schemaToOpenApi(input.content, title), '3.1.0', 'Wrapped mislabeled non-OAS artifact in partial OpenAPI 3.1');
    }
    return {
      content: input.content,
      format: input.format,
      version,
      completeness: 'full',
      evidence: ['Source artifact is already OpenAPI 3.x']
    };
  }

  switch (input.format) {
    case 'graphql-sdl':
      return jsonResult(graphqlToOpenApi(title), '3.1.0', 'Synthesized GraphQL POST endpoint as partial OpenAPI 3.1');
    case 'asyncapi-json':
    case 'asyncapi-yaml':
      return jsonResult(asyncApiToOpenApi(input.content, title), '3.1.0', 'Synthesized OpenAPI 3.1 webhooks from AsyncAPI channels');
    case 'postman-collection':
      return jsonResult(postmanToOpenApi(input.content, title), '3.1.0', 'Synthesized OpenAPI paths from Postman collection requests');
    case 'protobuf':
      return jsonResult(protobufToOpenApi(input.content, title), '3.1.0', 'Synthesized OpenAPI RPC paths from protobuf service methods');
    case 'smithy':
      return jsonResult(smithyToOpenApi(input.content, title), '3.1.0', 'Synthesized OpenAPI paths from Smithy service operations');
    case 'avro':
    case 'json-schema':
      return jsonResult(schemaToOpenApi(input.content, title), '3.1.0', `Wrapped ${input.format} schema in a partial OpenAPI 3.1 request path`);
    default:
      return jsonResult(emptyPartial(title), '3.1.0', `Created partial OpenAPI 3.1 placeholder for ${input.format}`);
  }
}

function jsonResult(document: OpenApiDocument, version: '3.0.3' | '3.1.0', evidence: string): OpenApiDerivationResult {
  return {
    content: `${JSON.stringify(document, null, 2)}\n`,
    format: 'openapi-json',
    version,
    completeness: 'partial',
    evidence: [evidence]
  };
}

function baseDocument(title: string, version: '3.0.3' | '3.1.0' = '3.1.0'): OpenApiDocument {
  return {
    openapi: version,
    info: {
      title,
      version: '1.0.0'
    },
    paths: {}
  };
}

function graphqlToOpenApi(title: string): OpenApiDocument {
  const document = baseDocument(title);
  document.paths['/graphql'] = {
    post: {
      operationId: 'executeGraphql',
      summary: 'Execute GraphQL operation',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['query'],
              properties: {
                query: { type: 'string' },
                operationName: { type: 'string' },
                variables: { type: 'object', additionalProperties: true }
              }
            }
          }
        }
      },
      responses: { '200': { description: 'GraphQL response' } }
    }
  };
  return document;
}

function asyncApiToOpenApi(content: string, title: string): OpenApiDocument {
  const parsed = parseStructured(content);
  const document = baseDocument(title);
  document.webhooks = {};
  const channels = recordValue(parsed.channels);
  for (const channelName of Object.keys(channels)) {
    const webhookName = safeWebhookName(channelName);
    document.webhooks[webhookName] = {
      post: {
        operationId: `receive${pascalCase(webhookName)}`,
        summary: `Receive ${channelName}`,
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: { type: 'object', additionalProperties: true }
            }
          }
        },
        responses: { '200': { description: 'Event accepted' } }
      }
    };
  }
  if (Object.keys(document.webhooks).length === 0) {
    document.webhooks.event = document.webhooks.event ?? {
      post: { operationId: 'receiveEvent', responses: { '200': { description: 'Event accepted' } } }
    };
  }
  return document;
}

function postmanToOpenApi(content: string, title: string): OpenApiDocument {
  const parsed = parseStructured(content);
  const document = baseDocument(stringValue(recordValue(parsed.info).name) || title);
  for (const request of postmanRequests(parsed.item)) {
    const method = request.method.toLowerCase();
    const path = request.path;
    document.paths[path] = {
      ...recordValue(document.paths[path]),
      [method]: {
        operationId: safeOperationName(`${method} ${path}`),
        summary: request.name,
        responses: { '200': { description: 'Response' } }
      }
    };
  }
  if (Object.keys(document.paths).length === 0) {
    document.paths['/postman-request'] = { post: { operationId: 'postmanRequest', responses: { '200': { description: 'Response' } } } };
  }
  return document;
}

function protobufToOpenApi(content: string, title: string): OpenApiDocument {
  const document = baseDocument(title);
  const servicePattern = /service\s+([A-Za-z_][\w]*)\s*\{([\s\S]*?)\}/g;
  for (const serviceMatch of content.matchAll(servicePattern)) {
    const serviceName = serviceMatch[1] ?? 'Service';
    const body = serviceMatch[2] ?? '';
    for (const rpcMatch of body.matchAll(/rpc\s+([A-Za-z_][\w]*)\s*\(/g)) {
      const methodName = rpcMatch[1] ?? 'Method';
      addRpcPath(document, serviceName, methodName);
    }
  }
  if (Object.keys(document.paths).length === 0) {
    document.paths['/protobuf'] = { post: { operationId: 'protobufRequest', responses: { '200': { description: 'Response' } } } };
  }
  return document;
}

function smithyToOpenApi(content: string, title: string): OpenApiDocument {
  const document = baseDocument(title);
  const serviceName = content.match(/\bservice\s+([A-Za-z_][\w]*)/)?.[1] ?? 'SmithyService';
  const operations = new Set<string>();
  const serviceBody = content.match(/\bservice\s+[A-Za-z_][\w]*\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  for (const operation of serviceBody.match(/operations\s*:\s*\[([^\]]+)\]/)?.[1]?.split(',') ?? []) {
    const name = operation.trim().replace(/^#/, '');
    if (name) operations.add(name);
  }
  for (const operationMatch of content.matchAll(/\boperation\s+([A-Za-z_][\w]*)/g)) {
    operations.add(operationMatch[1] ?? '');
  }
  for (const operation of [...operations].filter(Boolean)) {
    addRpcPath(document, serviceName, operation);
  }
  if (Object.keys(document.paths).length === 0) {
    document.paths[`/${serviceName}`] = { post: { operationId: safeOperationName(serviceName), responses: { '200': { description: 'Response' } } } };
  }
  return document;
}

function schemaToOpenApi(content: string, title: string): OpenApiDocument {
  const parsed = parseStructured(content);
  const schema = Object.keys(parsed).length > 0 ? parsed : { type: 'object', additionalProperties: true };
  const name = stringValue(parsed.name) || safeOperationName(title) || 'schema';
  const document = baseDocument(title);
  document.paths[`/${kebabCase(name)}`] = {
    post: {
      operationId: `submit${pascalCase(name)}`,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema
          }
        }
      },
      responses: { '202': { description: 'Accepted' } }
    }
  };
  return document;
}

function swaggerToOpenApi(content: string, title: string): OpenApiDocument {
  const parsed = parseStructured(content);
  const document = baseDocument(stringValue(recordValue(parsed.info).title) || title, '3.0.3');
  const paths = recordValue(parsed.paths);
  for (const [pathName, pathItem] of Object.entries(paths)) {
    document.paths[pathName] = pathItem;
  }
  return document;
}

function emptyPartial(title: string): OpenApiDocument {
  const document = baseDocument(title);
  document.paths['/artifact'] = {
    post: {
      operationId: 'submitArtifact',
      responses: { '202': { description: 'Accepted' } }
    }
  };
  return document;
}

function addRpcPath(document: OpenApiDocument, serviceName: string, methodName: string): void {
  document.paths[`/${serviceName}/${methodName}`] = {
    post: {
      operationId: safeOperationName(`${serviceName} ${methodName}`),
      summary: `${serviceName}.${methodName}`,
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: { type: 'object', additionalProperties: true }
          }
        }
      },
      responses: { '200': { description: 'Response' } }
    }
  };
}

function postmanRequests(items: unknown, parentName = ''): { name: string; method: string; path: string }[] {
  if (!Array.isArray(items)) return [];
  const requests: { name: string; method: string; path: string }[] = [];
  for (const item of items) {
    const record = recordValue(item);
    const name = stringValue(record.name) || parentName || 'Request';
    if (record.request) {
      const request = recordValue(record.request);
      requests.push({ name, method: stringValue(request.method) || 'GET', path: postmanPath(request.url) });
    }
    requests.push(...postmanRequests(record.item, name));
  }
  return requests;
}

function postmanPath(url: unknown): string {
  if (typeof url === 'string') {
    try {
      const parsed = new URL(url);
      return parsed.pathname || '/';
    } catch {
      return url.startsWith('/') ? url : `/${url}`;
    }
  }
  const record = recordValue(url);
  const path = Array.isArray(record.path) ? record.path.map((entry) => String(entry)).join('/') : stringValue(record.raw);
  if (!path) return '/';
  if (/^https?:\/\//i.test(path)) {
    try {
      return new URL(path).pathname || '/';
    } catch {
      return '/';
    }
  }
  return path.startsWith('/') ? path : `/${path}`;
}

function parseStructured(content: string): Record<string, unknown> {
  try {
    const parsed = content.trim().startsWith('{') ? JSON.parse(content) : parse(content);
    return recordValue(parsed);
  } catch {
    return {};
  }
}

function titleFromContent(content: string): string | undefined {
  const parsed = parseStructured(content);
  const infoTitle = stringValue(recordValue(parsed.info).title);
  if (infoTitle) return infoTitle;
  return stringValue(parsed.name);
}

function openApiVersion(content: string): '3.0.3' | '3.1.0' | undefined {
  const parsed = parseStructured(content);
  const version = stringValue(parsed.openapi);
  if (version.startsWith('3.1')) return '3.1.0';
  if (version.startsWith('3.')) return '3.0.3';
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function safeOperationName(value: string): string {
  const words = value.replace(/^\//, '').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'operation';
  return words.map((word, index) => index === 0 ? word.toLowerCase() : `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join('');
}

function safeWebhookName(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'event';
}

function pascalCase(value: string): string {
  const camel = safeOperationName(value);
  return `${camel.slice(0, 1).toUpperCase()}${camel.slice(1)}`;
}

function kebabCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'schema';
}

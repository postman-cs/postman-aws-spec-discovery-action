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
      return jsonResult(graphqlToOpenApi(input.content, title), '3.1.0', 'Synthesized GraphQL POST endpoint as partial OpenAPI 3.1');
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
      return jsonResult(schemaToOpenApi(input.content, title, input.format), '3.1.0', `Wrapped ${input.format} schema in a partial OpenAPI 3.1 request path`);
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

function graphqlToOpenApi(content: string, title: string): OpenApiDocument {
  const document = baseDocument(title);
  const graphqlTypes = parseGraphqlTypes(content);
  const operations = graphqlOperations(graphqlTypes);
  const operationNames = operations.map((operation) => operation.name);
  const variables = operations.map((operation) => operation.variables).filter(Boolean);
  const components = graphqlComponents(graphqlTypes);
  if (Object.keys(components).length > 0) {
    document.components = { schemas: components };
  }

  const requestSchema: Record<string, unknown> = {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string' },
      operationName: operationNames.length > 0 ? { type: 'string', enum: operationNames } : { type: 'string' },
      variables: variables.length > 0 ? { oneOf: variables } : { type: 'object', additionalProperties: true }
    }
  };

  document.paths['/graphql'] = {
    post: {
      operationId: 'executeGraphql',
      summary: operationNames.length > 0
        ? `Execute GraphQL operations: ${operationNames.join(', ')}`
        : 'Execute GraphQL operation',
      ...(operations.length > 0 ? { 'x-graphql-operations': operations } : {}),
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: requestSchema
          }
        }
      },
      responses: { '200': { description: 'GraphQL response' } }
    }
  };
  return document;
}

interface GraphqlField {
  name: string;
  type: string;
  args: { name: string; type: string }[];
}

interface GraphqlType {
  kind: 'type' | 'input';
  fields: GraphqlField[];
}

function parseGraphqlTypes(content: string): Record<string, GraphqlType> {
  const types: Record<string, GraphqlType> = {};
  for (const match of content.matchAll(/\b(type|input)\s+([A-Za-z_][\w]*)\s*\{([\s\S]*?)\}/g)) {
    const kind = match[1] === 'input' ? 'input' : 'type';
    const name = match[2] ?? '';
    const body = match[3] ?? '';
    if (!name) continue;
    types[name] = { kind, fields: parseGraphqlFields(body) };
  }
  return types;
}

function parseGraphqlFields(body: string): GraphqlField[] {
  const fields: GraphqlField[] = [];
  for (const match of body.matchAll(/([A-Za-z_][\w]*)\s*(?:\(([^)]*)\))?\s*:\s*([A-Za-z_][\w]*!?|\[[A-Za-z_][\w]*!?\]!?)/g)) {
    fields.push({
      name: match[1] ?? 'field',
      args: parseGraphqlArgs(match[2] ?? ''),
      type: match[3] ?? 'String'
    });
  }
  return fields;
}

function parseGraphqlArgs(args: string): { name: string; type: string }[] {
  return args
    .split(',')
    .map((arg) => arg.trim())
    .filter(Boolean)
    .map((arg) => {
      const match = arg.match(/^([A-Za-z_][\w]*)\s*:\s*([A-Za-z_][\w]*!?|\[[A-Za-z_][\w]*!?\]!?)/);
      return match ? { name: match[1] ?? 'arg', type: match[2] ?? 'String' } : undefined;
    })
    .filter((arg): arg is { name: string; type: string } => Boolean(arg));
}

function graphqlOperations(types: Record<string, GraphqlType>): Record<string, unknown>[] {
  const operations: Record<string, unknown>[] = [];
  for (const [operationType, typeName] of [['query', 'Query'], ['mutation', 'Mutation']] as const) {
    for (const field of types[typeName]?.fields ?? []) {
      operations.push({
        type: operationType,
        name: field.name,
        returnType: graphqlTypeName(field.type),
        variables: graphqlVariablesSchema(field.name, field.args)
      });
    }
  }
  return operations;
}

function graphqlVariablesSchema(operationName: string, args: { name: string; type: string }[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const arg of args) {
    properties[arg.name] = graphqlTypeToSchema(arg.type);
    if (isGraphqlRequired(arg.type)) {
      required.push(arg.name);
    }
  }
  return {
    title: `${operationName} variables`,
    type: 'object',
    ...(required.length > 0 ? { required } : {}),
    properties
  };
}

function graphqlComponents(types: Record<string, GraphqlType>): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(types)) {
    if (name === 'Query' || name === 'Mutation') continue;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const field of type.fields) {
      properties[field.name] = graphqlTypeToSchema(field.type);
      if (isGraphqlRequired(field.type)) {
        required.push(field.name);
      }
    }
    schemas[name] = {
      type: 'object',
      ...(required.length > 0 ? { required } : {}),
      properties
    };
  }
  return schemas;
}

function graphqlTypeToSchema(type: string): Record<string, unknown> {
  const isList = type.includes('[');
  const cleanType = graphqlTypeName(type);
  const scalar = graphqlScalarSchema(cleanType);
  const schema = scalar ?? { $ref: `#/components/schemas/${cleanType}` };
  return isList ? { type: 'array', items: schema } : schema;
}

function graphqlScalarSchema(type: string): Record<string, unknown> | undefined {
  switch (type) {
    case 'ID':
    case 'String':
      return { type: 'string' };
    case 'Int':
      return { type: 'integer' };
    case 'Float':
      return { type: 'number' };
    case 'Boolean':
      return { type: 'boolean' };
    default:
      return undefined;
  }
}

function graphqlTypeName(type: string): string {
  return type.replaceAll('!', '').replaceAll('[', '').replaceAll(']', '');
}

function isGraphqlRequired(type: string): boolean {
  return type.trim().endsWith('!');
}

function asyncApiToOpenApi(content: string, title: string): OpenApiDocument {
  const parsed = parseStructured(content);
  const document = baseDocument(title);
  document.webhooks = {};
  const components = recordValue(parsed.components);
  const schemas = recordValue(components.schemas);
  if (Object.keys(schemas).length > 0) {
    document.components = { schemas: cloneJsonValue(schemas) };
  }
  const channels = recordValue(parsed.channels);
  for (const channelName of Object.keys(channels)) {
    const channel = recordValue(channels[channelName]);
    const operations = asyncApiChannelOperations(channel);
    for (const [index, operation] of operations.entries()) {
      const webhookName = operations.length === 1
        ? safeWebhookName(channelName)
        : safeWebhookName(`${channelName}_${operation.direction}`);
      document.webhooks[webhookName] = {
        post: asyncApiWebhookOperation(channelName, operation.direction, operation.operation, components, index)
      };
    }
  }
  if (Object.keys(document.webhooks).length === 0) {
    document.webhooks.event = document.webhooks.event ?? {
      post: { operationId: 'receiveEvent', responses: { '200': { description: 'Event accepted' } } }
    };
  }
  return document;
}

function asyncApiChannelOperations(channel: Record<string, unknown>): {
  direction: 'publish' | 'subscribe';
  operation: Record<string, unknown>;
}[] {
  const operations: { direction: 'publish' | 'subscribe'; operation: Record<string, unknown> }[] = [];
  for (const direction of ['subscribe', 'publish'] as const) {
    const operation = recordValue(channel[direction]);
    if (Object.keys(operation).length > 0) {
      operations.push({ direction, operation });
    }
  }
  return operations;
}

function asyncApiWebhookOperation(
  channelName: string,
  direction: 'publish' | 'subscribe',
  operation: Record<string, unknown>,
  components: Record<string, unknown>,
  index: number
): Record<string, unknown> {
  const message = asyncApiMessage(operation.message, components);
  const media: Record<string, unknown> = {
    schema: asyncApiPayloadSchema(message)
  };
  const examples = asyncApiExamples(message.examples);
  if (Object.keys(examples).length > 0) {
    media.examples = examples;
  }

  return {
    operationId: safeOperationName(`${direction} ${channelName} ${index === 0 ? '' : index + 1}`),
    summary: stringValue(operation.summary) || stringValue(message.summary) || `${direction === 'subscribe' ? 'Receive' : 'Publish'} ${channelName}`,
    'x-asyncapi-channel': channelName,
    'x-asyncapi-operation': direction,
    requestBody: {
      required: false,
      content: {
        'application/json': media
      }
    },
    responses: { '200': { description: 'Event accepted' } }
  };
}

function asyncApiMessage(messageValue: unknown, components: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(messageValue)) {
    return asyncApiMessage(messageValue[0], components);
  }
  const message = recordValue(messageValue);
  const ref = stringValue(message.$ref);
  if (ref.startsWith('#/components/messages/')) {
    const name = ref.slice('#/components/messages/'.length);
    return recordValue(recordValue(components.messages)[name]);
  }
  return message;
}

function asyncApiPayloadSchema(message: Record<string, unknown>): unknown {
  const payload = message.payload;
  if (payload && typeof payload === 'object') {
    return cloneJsonValue(payload);
  }
  return { type: 'object', additionalProperties: true };
}

function asyncApiExamples(examplesValue: unknown): Record<string, unknown> {
  const examples: Record<string, unknown> = {};
  for (const [index, example] of arrayValue(examplesValue).entries()) {
    const record = recordValue(example);
    const name = stringValue(record.name) || `example${index + 1}`;
    const value = 'payload' in record ? record.payload : record;
    examples[name] = {
      ...(stringValue(record.summary) ? { summary: stringValue(record.summary) } : {}),
      value: cloneJsonValue(value)
    };
  }
  return examples;
}

function postmanToOpenApi(content: string, title: string): OpenApiDocument {
  const parsed = parseStructured(content);
  const document = baseDocument(stringValue(recordValue(parsed.info).name) || title);
  for (const request of postmanRequests(parsed.item)) {
    const method = request.method.toLowerCase();
    const path = request.path;
    const operation: Record<string, unknown> = {
      operationId: safeOperationName(`${method} ${path}`),
      summary: request.name,
      responses: postmanResponsesToOpenApi(request.responses)
    };
    const parameters = [...request.queryParams, ...request.headers];
    if (parameters.length > 0) {
      operation.parameters = parameters;
    }
    if (request.authType) {
      operation['x-postman-auth-type'] = request.authType;
    }
    if (request.body) {
      operation.requestBody = {
        required: false,
        content: {
          [request.body.mediaType]: {
            schema: schemaFromExample(request.body.example),
            example: request.body.example
          }
        }
      };
    }
    document.paths[path] = {
      ...recordValue(document.paths[path]),
      [method]: operation
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

function schemaToOpenApi(content: string, title: string, format: 'avro' | 'json-schema' = 'json-schema'): OpenApiDocument {
  const parsed = parseStructured(content);
  const schema = format === 'avro' ? avroToJsonSchema(parsed) : Object.keys(parsed).length > 0 ? parsed : { type: 'object', additionalProperties: true };
  const name = schemaComponentName(parsed, title);
  const document = baseDocument(title);
  document.components = {
    schemas: {
      [name]: schema
    }
  };
  document.paths[`/${kebabCase(name)}`] = {
    post: {
      operationId: `submit${pascalCase(name)}`,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: `#/components/schemas/${name}` }
          }
        }
      },
      responses: { '202': { description: 'Accepted' } }
    }
  };
  return document;
}

function schemaComponentName(parsed: Record<string, unknown>, title: string): string {
  return (
    stringValue(parsed.title) ||
    stringValue(parsed.name) ||
    schemaNameFromId(stringValue(parsed.$id) || stringValue(parsed.id)) ||
    pascalCase(title) ||
    'Schema'
  );
}

function schemaNameFromId(id: string): string | undefined {
  if (!id) return undefined;
  const candidate = id.split(/[/#]/).filter(Boolean).pop() ?? '';
  const safe = pascalCase(candidate);
  return safe === 'Operation' ? undefined : safe;
}

function avroToJsonSchema(schema: unknown): Record<string, unknown> {
  const record = recordValue(schema);
  if (stringValue(record.type) === 'record') {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const field of arrayValue(record.fields)) {
      const fieldRecord = recordValue(field);
      const name = stringValue(fieldRecord.name);
      if (!name) continue;
      properties[name] = avroFieldTypeToJsonSchema(fieldRecord.type);
      if (fieldRecord.default === undefined && !avroTypeAllowsNull(fieldRecord.type)) {
        required.push(name);
      }
    }
    return {
      type: 'object',
      ...(required.length > 0 ? { required } : {}),
      properties
    };
  }
  return Object.keys(record).length > 0 ? cloneJsonValue(record) : { type: 'object', additionalProperties: true };
}

function avroFieldTypeToJsonSchema(type: unknown): Record<string, unknown> {
  if (Array.isArray(type)) {
    const nonNull = type.find((entry) => entry !== 'null') ?? 'string';
    return avroFieldTypeToJsonSchema(nonNull);
  }
  if (typeof type === 'string') {
    switch (type) {
      case 'string':
      case 'enum':
        return { type: 'string' };
      case 'int':
      case 'long':
        return { type: 'integer' };
      case 'float':
      case 'double':
        return { type: 'number' };
      case 'boolean':
        return { type: 'boolean' };
      case 'bytes':
        return { type: 'string', format: 'byte' };
      default:
        return { type: 'object', additionalProperties: true };
    }
  }
  const record = recordValue(type);
  if (stringValue(record.type) === 'array') {
    return { type: 'array', items: avroFieldTypeToJsonSchema(record.items) };
  }
  if (stringValue(record.type) === 'record') {
    return avroToJsonSchema(record);
  }
  return { type: 'object', additionalProperties: true };
}

function avroTypeAllowsNull(type: unknown): boolean {
  return Array.isArray(type) && type.includes('null');
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

interface PostmanDerivedRequest {
  name: string;
  method: string;
  path: string;
  queryParams: Record<string, unknown>[];
  headers: Record<string, unknown>[];
  authType?: string;
  body?: { mediaType: string; example: unknown };
  responses: { name: string; code: string; body?: unknown }[];
}

function postmanRequests(items: unknown, parentName = ''): PostmanDerivedRequest[] {
  if (!Array.isArray(items)) return [];
  const requests: PostmanDerivedRequest[] = [];
  for (const item of items) {
    const record = recordValue(item);
    const name = stringValue(record.name) || parentName || 'Request';
    if (record.request) {
      const request = recordValue(record.request);
      requests.push({
        name,
        method: stringValue(request.method) || 'GET',
        path: postmanPath(request.url),
        queryParams: postmanQueryParameters(request.url),
        headers: postmanHeaderParameters(request.header),
        authType: stringValue(recordValue(request.auth).type),
        body: postmanRequestBody(request.body),
        responses: postmanResponses(record.response)
      });
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

function postmanQueryParameters(url: unknown): Record<string, unknown>[] {
  const record = recordValue(url);
  const query = Array.isArray(record.query) ? record.query : [];
  return query
    .map((entry) => recordValue(entry))
    .filter((entry) => stringValue(entry.key))
    .map((entry) => ({
      name: stringValue(entry.key),
      in: 'query',
      required: false,
      schema: { type: 'string' },
      ...(stringValue(entry.value) ? { example: stringValue(entry.value) } : {})
    }));
}

function postmanHeaderParameters(headers: unknown): Record<string, unknown>[] {
  return arrayValue(headers)
    .map((entry) => recordValue(entry))
    .filter((entry) => stringValue(entry.key))
    .map((entry) => ({
      name: stringValue(entry.key),
      in: 'header',
      required: false,
      schema: { type: 'string' },
      ...(stringValue(entry.value) ? { example: stringValue(entry.value) } : {})
    }));
}

function postmanRequestBody(bodyValue: unknown): { mediaType: string; example: unknown } | undefined {
  const body = recordValue(bodyValue);
  if (!body.mode) return undefined;
  if (stringValue(body.mode) === 'raw') {
    const raw = stringValue(body.raw);
    return { mediaType: postmanRawMediaType(body), example: parseJsonOrString(raw) };
  }
  return undefined;
}

function postmanRawMediaType(body: Record<string, unknown>): string {
  const language = stringValue(recordValue(recordValue(body.options).raw).language).toLowerCase();
  return language === 'json' ? 'application/json' : 'text/plain';
}

function postmanResponses(responsesValue: unknown): { name: string; code: string; body?: unknown }[] {
  return arrayValue(responsesValue).map((response) => {
    const record = recordValue(response);
    const code = Number(record.code);
    const rawBody = stringValue(record.body);
    return {
      name: stringValue(record.name) || 'Response',
      code: Number.isFinite(code) ? String(code) : '200',
      ...(rawBody ? { body: parseJsonOrString(rawBody) } : {})
    };
  });
}

function postmanResponsesToOpenApi(responses: { name: string; code: string; body?: unknown }[]): Record<string, unknown> {
  if (responses.length === 0) {
    return { '200': { description: 'Response' } };
  }
  const result: Record<string, unknown> = {};
  for (const response of responses) {
    result[response.code] = {
      description: response.name,
      ...(response.body !== undefined
        ? {
            content: {
              'application/json': {
                schema: schemaFromExample(response.body),
                example: response.body
              }
            }
          }
        : {})
    };
  }
  return result;
}

function parseJsonOrString(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function schemaFromExample(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return { type: 'array', items: value.length > 0 ? schemaFromExample(value[0]) : {} };
  }
  if (value && typeof value === 'object') {
    const properties: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      properties[key] = schemaFromExample(nestedValue);
    }
    return { type: 'object', properties };
  }
  switch (typeof value) {
    case 'number':
      return Number.isInteger(value) ? { type: 'integer' } : { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'string':
      return { type: 'string' };
    default:
      return {};
  }
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

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

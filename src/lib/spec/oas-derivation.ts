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
  const parsed = parseProtobuf(content);
  if (Object.keys(parsed.messages).length > 0) {
    document.components = { schemas: parsed.messages };
  }
  for (const service of parsed.services) {
    for (const rpc of service.rpcs) {
      addRpcPath(document, service.name, rpc.name, {
        input: parsed.messages[rpc.input] ? rpc.input : undefined,
        output: parsed.messages[rpc.output] ? rpc.output : undefined,
        extensions: {
          'x-protobuf-package': parsed.packageName,
          'x-protobuf-service': service.name,
          'x-protobuf-method': rpc.name
        }
      });
    }
  }
  if (Object.keys(document.paths).length === 0) {
    document.paths['/protobuf'] = { post: { operationId: 'protobufRequest', responses: { '200': { description: 'Response' } } } };
  }
  return document;
}

function smithyToOpenApi(content: string, title: string): OpenApiDocument {
  const document = baseDocument(title);
  const parsed = parseSmithy(content);
  if (Object.keys(parsed.structures).length > 0) {
    document.components = { schemas: parsed.structures };
  }
  const service = parsed.service ?? { name: 'SmithyService', operations: Object.keys(parsed.operations) };
  for (const operationName of service.operations) {
    const operation = parsed.operations[operationName] ?? { name: operationName, errors: [] };
    addRpcPath(document, service.name, operation.name, {
      input: operation.input && parsed.structures[operation.input] ? operation.input : undefined,
      output: operation.output && parsed.structures[operation.output] ? operation.output : undefined,
      errors: operation.errors.filter((error) => Boolean(parsed.structures[error])),
      extensions: {
        'x-smithy-namespace': parsed.namespace,
        'x-smithy-service': service.name,
        'x-smithy-operation': operation.name,
        'x-smithy-errors': operation.errors.length > 0 ? operation.errors : undefined
      }
    });
  }
  if (Object.keys(document.paths).length === 0) {
    document.paths[`/${service.name}`] = { post: { operationId: safeOperationName(service.name), responses: { '200': { description: 'Response' } } } };
  }
  return document;
}

interface ParsedBlock {
  name: string;
  body: string;
}

interface ParsedProtoRpc {
  name: string;
  input: string;
  output: string;
}

interface ParsedProtoService {
  name: string;
  rpcs: ParsedProtoRpc[];
}

interface ParsedProtobuf {
  packageName?: string;
  services: ParsedProtoService[];
  messages: Record<string, unknown>;
}

interface ParsedSmithyOperation {
  name: string;
  input?: string;
  output?: string;
  errors: string[];
}

interface ParsedSmithyService {
  name: string;
  operations: string[];
}

interface ParsedSmithy {
  namespace?: string;
  service?: ParsedSmithyService;
  operations: Record<string, ParsedSmithyOperation>;
  structures: Record<string, unknown>;
}

function parseProtobuf(content: string): ParsedProtobuf {
  const sanitized = stripLineComments(content);
  const packageName = sanitized.match(/\bpackage\s+([A-Za-z_][\w.]*)\s*;/)?.[1];
  const messages = Object.fromEntries(readNamedBlocks(sanitized, 'message').map((block) => [block.name, protoMessageSchema(block.body)]));
  const services = readNamedBlocks(sanitized, 'service').map((block) => ({
    name: block.name,
    rpcs: parseProtoRpcs(block.body)
  }));
  return { packageName, services, messages };
}

function parseProtoRpcs(body: string): ParsedProtoRpc[] {
  const rpcs: ParsedProtoRpc[] = [];
  for (const match of body.matchAll(/\brpc\s+([A-Za-z_][\w]*)\s*\(\s*(?:stream\s+)?([A-Za-z_][\w.]*)\s*\)\s*returns\s*\(\s*(?:stream\s+)?([A-Za-z_][\w.]*)\s*\)/g)) {
    rpcs.push({
      name: match[1] ?? 'Method',
      input: unqualifiedName(match[2] ?? ''),
      output: unqualifiedName(match[3] ?? '')
    });
  }
  return rpcs;
}

function protoMessageSchema(body: string): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const statement of body.split(';')) {
    const match = statement.trim().match(/^(repeated\s+)?([A-Za-z_][\w.]*)\s+([A-Za-z_][\w]*)\s*=/);
    if (!match) continue;
    const repeated = Boolean(match[1]);
    const typeName = match[2] ?? 'string';
    const fieldName = match[3] ?? 'field';
    const fieldSchema = protoFieldSchema(typeName);
    properties[fieldName] = repeated ? { type: 'array', items: fieldSchema } : fieldSchema;
  }
  return { type: 'object', properties };
}

function protoFieldSchema(typeName: string): Record<string, unknown> {
  switch (unqualifiedName(typeName)) {
    case 'double':
    case 'float':
      return { type: 'number' };
    case 'int32':
    case 'int64':
    case 'uint32':
    case 'uint64':
    case 'sint32':
    case 'sint64':
    case 'fixed32':
    case 'fixed64':
    case 'sfixed32':
    case 'sfixed64':
      return { type: 'integer' };
    case 'bool':
      return { type: 'boolean' };
    case 'string':
      return { type: 'string' };
    case 'bytes':
      return { type: 'string', format: 'byte' };
    default:
      return { $ref: `#/components/schemas/${unqualifiedName(typeName)}` };
  }
}

function parseSmithy(content: string): ParsedSmithy {
  const sanitized = stripLineComments(content);
  const namespace = sanitized.match(/\bnamespace\s+([A-Za-z_][\w.]*)/)?.[1];
  const structures = Object.fromEntries(readNamedBlocks(sanitized, 'structure').map((block) => [block.name, smithyStructureSchema(block.body)]));
  const operations = Object.fromEntries(
    readNamedBlocks(sanitized, 'operation').map((block) => {
      const operation = smithyOperation(block.name, block.body);
      return [operation.name, operation];
    })
  );
  const serviceBlock = readNamedBlocks(sanitized, 'service')[0];
  const service = serviceBlock ? {
    name: serviceBlock.name,
    operations: parseSmithyList(serviceBlock.body.match(/\boperations\s*:\s*\[([^\]]*)\]/)?.[1] ?? '')
  } : undefined;
  return { namespace, service, operations, structures };
}

function smithyOperation(name: string, body: string): ParsedSmithyOperation {
  return {
    name,
    input: body.match(/\binput\s*:\s*#?([A-Za-z_][\w.]*)/)?.[1],
    output: body.match(/\boutput\s*:\s*#?([A-Za-z_][\w.]*)/)?.[1],
    errors: parseSmithyList(body.match(/\berrors\s*:\s*\[([^\]]*)\]/)?.[1] ?? '')
  };
}

function smithyStructureSchema(body: string): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  let requiredNext = false;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim().replace(/,$/, '');
    if (!line) continue;
    if (line === '@required') {
      requiredNext = true;
      continue;
    }
    const match = line.match(/^([A-Za-z_][\w]*)\s*:\s*#?([A-Za-z_][\w.]*)/);
    if (!match) continue;
    const memberName = match[1] ?? 'member';
    properties[memberName] = smithyShapeSchema(match[2] ?? 'String');
    if (requiredNext) {
      required.push(memberName);
      requiredNext = false;
    }
  }
  return { type: 'object', ...(required.length > 0 ? { required } : {}), properties };
}

function smithyShapeSchema(typeName: string): Record<string, unknown> {
  switch (unqualifiedName(typeName)) {
    case 'String':
    case 'Blob':
    case 'Timestamp':
      return { type: 'string' };
    case 'Integer':
    case 'Long':
    case 'Short':
    case 'Byte':
      return { type: 'integer' };
    case 'Float':
    case 'Double':
    case 'BigDecimal':
    case 'BigInteger':
      return { type: 'number' };
    case 'Boolean':
      return { type: 'boolean' };
    default:
      return { $ref: `#/components/schemas/${unqualifiedName(typeName)}` };
  }
}

function parseSmithyList(value: string): string[] {
  return value.split(',').map((item) => item.trim().replace(/^#/, '')).filter(Boolean);
}

function readNamedBlocks(content: string, keyword: 'message' | 'service' | 'operation' | 'structure'): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const pattern = new RegExp(`\\b${keyword}\\s+([A-Za-z_][\\w]*)\\s*\\{`, 'g');
  for (const match of content.matchAll(pattern)) {
    const name = match[1] ?? keyword;
    const openBrace = (match.index ?? 0) + match[0].length - 1;
    const closeBrace = matchingBrace(content, openBrace);
    if (closeBrace > openBrace) {
      blocks.push({ name, body: content.slice(openBrace + 1, closeBrace) });
    }
  }
  return blocks;
}

function matchingBrace(content: string, openBrace: number): number {
  let depth = 0;
  for (let index = openBrace; index < content.length; index += 1) {
    const char = content[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function stripLineComments(content: string): string {
  return content.replace(/\/\/.*$/gm, '');
}

function unqualifiedName(value: string): string {
  return value.split('.').filter(Boolean).pop() ?? value;
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

function addRpcPath(
  document: OpenApiDocument,
  serviceName: string,
  methodName: string,
  options: {
    input?: string;
    output?: string;
    errors?: string[];
    extensions?: Record<string, unknown>;
  } = {}
): void {
  document.paths[`/${serviceName}/${methodName}`] = {
    post: {
      operationId: safeOperationName(`${serviceName} ${methodName}`),
      summary: `${serviceName}.${methodName}`,
      ...compactRecord(options.extensions ?? {}),
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: options.input ? { $ref: `#/components/schemas/${options.input}` } : { type: 'object', additionalProperties: true }
          }
        }
      },
      responses: rpcResponses(options.output, options.errors ?? [])
    }
  };
}

function rpcResponses(output: string | undefined, errors: string[]): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    '200': {
      description: 'Response',
      ...(output ? {
        content: {
          'application/json': {
            schema: { $ref: `#/components/schemas/${output}` }
          }
        }
      } : {})
    }
  };
  if (errors.length > 0) {
    responses.default = {
      description: 'Error response',
      content: {
        'application/json': {
          schema: { oneOf: errors.map((error) => ({ $ref: `#/components/schemas/${error}` })) }
        }
      }
    };
  }
  return responses;
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

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
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

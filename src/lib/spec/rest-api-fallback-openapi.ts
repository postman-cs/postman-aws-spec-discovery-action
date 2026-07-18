import { parse, stringify } from 'yaml';

export interface RestApiFallbackMethod {
  httpMethod?: string;
  authorizationType?: string;
  operationName?: string;
  apiKeyRequired?: boolean;
  requestParameters?: Record<string, boolean>;
  requestModels?: Record<string, string>;
  methodResponses?: Record<string, { statusCode?: string; responseModels?: Record<string, string>; responseParameters?: Record<string, boolean> }>;
  methodIntegration?: {
    type?: string;
    httpMethod?: string;
    uri?: string;
    connectionType?: string;
    requestParameters?: Record<string, string>;
    integrationResponses?: Record<string, { statusCode?: string; selectionPattern?: string }>;
  };
}

export interface RestApiFallbackResource {
  path?: string;
  resourceMethods?: Record<string, RestApiFallbackMethod>;
}

export interface RestApiFallbackModel {
  name?: string;
  schema?: string;
  contentType?: string;
}

export interface RestApiFallbackInput {
  apiId: string;
  apiName: string;
  region: string;
  stage?: string;
  resources: RestApiFallbackResource[];
  models: RestApiFallbackModel[];
}

export function synthesizeRestApiFallbackOpenApi(input: RestApiFallbackInput): string {
  const document: Record<string, unknown> = {
    openapi: '3.0.3',
    info: {
      title: input.apiName || input.apiId,
      version: '1.0.0'
    },
    servers: [
      {
        url: `https://${input.apiId}.execute-api.${input.region}.amazonaws.com${input.stage ? `/${input.stage}` : ''}`
      }
    ],
    paths: {},
    'x-postman-discovery': {
      apiGatewayFallback: true,
      completeness: 'partial',
      evidence: 'Synthesized from API Gateway REST resources, methods, and models after native export failed'
    }
  };
  const components = restApiComponents(input.models);
  if (Object.keys(components).length > 0) {
    document.components = { schemas: components };
  }

  const paths = document.paths as Record<string, unknown>;
  for (const resource of input.resources) {
    if (!resource.path || resource.path === '/') continue;
    const pathItem = recordValue(paths[resource.path]);
    for (const [methodName, method] of Object.entries(resource.resourceMethods ?? {})) {
      const lowerMethod = methodName.toLowerCase();
      pathItem[lowerMethod] = restApiOperation(resource.path, lowerMethod, method);
    }
    if (Object.keys(pathItem).length > 0) {
      paths[resource.path] = pathItem;
    }
  }
  if (Object.keys(paths).length === 0) {
    paths['/{proxy+}'] = {
      'x-postman-discovery-note': 'No REST methods were returned by API Gateway fallback resource inspection'
    };
  }

  return stringify(document);
}

function restApiComponents(models: RestApiFallbackModel[]): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const model of models) {
    if (!model.name || !model.schema || model.name === 'Empty') continue;
    const parsed = parseJson(model.schema);
    if (parsed && typeof parsed === 'object') {
      schemas[model.name] = parsed;
    }
  }
  return schemas;
}

function restApiOperation(pathName: string, methodName: string, method: RestApiFallbackMethod): Record<string, unknown> {
  return {
    operationId: method.operationName || safeOperationName(`${methodName} ${pathName}`),
    ...(method.authorizationType && method.authorizationType !== 'NONE' ? { security: [{ [method.authorizationType]: [] }] } : {}),
    ...(method.authorizationType ? { 'x-amazon-apigateway-authorization-type': method.authorizationType } : {}),
    ...(method.apiKeyRequired ? { 'x-api-key-required': true } : {}),
    parameters: restApiParameters(method.requestParameters),
    ...(Object.keys(method.requestModels ?? {}).length > 0 ? { requestBody: restApiRequestBody(method.requestModels ?? {}) } : {}),
    responses: restApiResponses(method.methodResponses ?? {}),
    ...(method.methodIntegration ? { 'x-amazon-apigateway-integration': restApiIntegration(method.methodIntegration) } : {})
  };
}

function restApiParameters(parameters: Record<string, boolean> | undefined): Record<string, unknown>[] {
  return Object.entries(parameters ?? {}).map(([name, required]) => {
    const match = name.match(/^method\.request\.(querystring|header|path)\.(.+)$/);
    const location = match?.[1] === 'querystring' ? 'query' : match?.[1] ?? 'query';
    return {
      name: match?.[2] ?? name,
      in: location,
      required: Boolean(required) || location === 'path',
      schema: { type: 'string' }
    };
  });
}

function restApiRequestBody(requestModels: Record<string, string>): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const [mediaType, modelName] of Object.entries(requestModels)) {
    content[mediaType] = { schema: { $ref: `#/components/schemas/${modelName}` } };
  }
  return { required: false, content };
}

function restApiResponses(methodResponses: Record<string, { statusCode?: string; responseModels?: Record<string, string> }>): Record<string, unknown> {
  if (Object.keys(methodResponses).length === 0) {
    return { '200': { description: 'Response' } };
  }
  const responses: Record<string, unknown> = {};
  for (const [statusCode, response] of Object.entries(methodResponses)) {
    const models = response.responseModels ?? {};
    const content: Record<string, unknown> = {};
    for (const [mediaType, modelName] of Object.entries(models)) {
      content[mediaType] = { schema: { $ref: `#/components/schemas/${modelName}` } };
    }
    responses[response.statusCode || statusCode] = {
      description: 'Response',
      ...(Object.keys(content).length > 0 ? { content } : {})
    };
  }
  return responses;
}

function restApiIntegration(integration: NonNullable<RestApiFallbackMethod['methodIntegration']>): Record<string, unknown> {
  return {
    ...(integration.type ? { type: integration.type.toLowerCase() } : {}),
    ...(integration.httpMethod ? { httpMethod: integration.httpMethod } : {}),
    ...(integration.uri ? { uri: integration.uri } : {}),
    ...(integration.connectionType ? { connectionType: integration.connectionType } : {}),
    ...(integration.requestParameters ? { requestParameters: integration.requestParameters } : {})
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeOperationName(value: string): string {
  const words = value.replace(/^\//, '').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'operation';
  return words.map((word, index) => index === 0 ? word.toLowerCase() : `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join('');
}

export interface RestApiRequestValidatorSummary {
  id?: string;
  name?: string;
  validateRequestBody?: boolean;
  validateRequestParameters?: boolean;
}

export interface MergeRestApiModelsInput {
  nativeExport: string;
  resources: RestApiFallbackResource[];
  models: RestApiFallbackModel[];
  validators: RestApiRequestValidatorSummary[];
}

interface RestApiFallbackMethodWithValidator extends RestApiFallbackMethod {
  requestValidatorId?: string;
}

function parseNativeExport(nativeExport: string): Record<string, unknown> | undefined {
  try {
    const parsed = nativeExport.trim().startsWith('{') ? JSON.parse(nativeExport) : parse(nativeExport);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as Record<string, unknown>).paths) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to undefined
  }
  return undefined;
}

/**
 * Additively enrich a native REST GetExport document with API Gateway Models and
 * RequestValidators. Only absent values are added; every native value is preserved
 * byte-for-byte as a parsed value. On any shape surprise the native export is returned
 * unchanged.
 */
export function mergeRestApiModelsAndValidators(input: MergeRestApiModelsInput): string {
  const document = parseNativeExport(input.nativeExport);
  if (!document) {
    return input.nativeExport;
  }

  // 1. Add absent model schemas under components.schemas; native entries win untouched.
  const componentsValue = document.components;
  if (componentsValue !== undefined && (typeof componentsValue !== 'object' || componentsValue === null || Array.isArray(componentsValue))) {
    return stringify(document); // native non-object components wins; nothing to merge into
  }
  const components = (componentsValue as Record<string, unknown> | undefined) ?? {};
  const schemasValue = components.schemas;
  if (schemasValue !== undefined && (typeof schemasValue !== 'object' || schemasValue === null || Array.isArray(schemasValue))) {
    return stringify(document);
  }
  const schemas = (schemasValue as Record<string, unknown> | undefined) ?? {};
  let schemasAdded = false;
  for (const model of input.models) {
    if (!model.name || !model.schema || model.name === 'Empty') continue;
    if (Object.prototype.hasOwnProperty.call(schemas, model.name)) continue;
    const parsedSchema = parseJson(model.schema);
    if (parsedSchema && typeof parsedSchema === 'object') {
      schemas[model.name] = parsedSchema;
      schemasAdded = true;
    }
  }
  if (schemasAdded || Object.keys(schemas).length > 0) {
    if (Object.keys(schemas).length > 0) {
      components.schemas = schemas;
    }
    if (Object.keys(components).length > 0) {
      document.components = components;
    }
  }

  const validatorById = new Map(
    input.validators
      .filter((validator): validator is RestApiRequestValidatorSummary & { id: string; name: string } =>
        Boolean(validator.id && validator.name)
      )
      .map((validator) => [validator.id, validator])
  );

  // 4. Root x-amazon-apigateway-request-validators entries (absent names only).
  if (validatorById.size > 0) {
    const rootValue = document['x-amazon-apigateway-request-validators'];
    if (rootValue === undefined || (rootValue && typeof rootValue === 'object' && !Array.isArray(rootValue))) {
    const root = (rootValue as Record<string, unknown> | undefined) ?? {};
    for (const validator of validatorById.values()) {
      if (!Object.prototype.hasOwnProperty.call(root, validator.name)) {
        root[validator.name] = {
          validateRequestBody: Boolean(validator.validateRequestBody),
          validateRequestParameters: Boolean(validator.validateRequestParameters)
        };
      }
    }
    if (Object.keys(root).length > 0) {
      document['x-amazon-apigateway-request-validators'] = root;
    }
    }
  }

  // 2-4. Per-operation request model bindings and validator names.
  const pathsValue = document.paths;
  const paths =
    pathsValue && typeof pathsValue === 'object' && !Array.isArray(pathsValue)
      ? (pathsValue as Record<string, unknown>)
      : undefined;
  if (paths) {
    for (const resource of input.resources) {
      if (!resource.path) continue;
      const pathItemValue = paths[resource.path];
      if (!pathItemValue || typeof pathItemValue !== 'object' || Array.isArray(pathItemValue)) continue;
      const pathItem = pathItemValue as Record<string, unknown>;
      for (const [methodName, method] of Object.entries(resource.resourceMethods ?? {})) {
        const operationValue = pathItem[methodName.toLowerCase()];
        if (!operationValue || typeof operationValue !== 'object' || Array.isArray(operationValue)) continue;
        const operation = operationValue as Record<string, unknown>;

        const requestModels = method.requestModels ?? {};
        for (const [mediaType, modelName] of Object.entries(requestModels)) {
          if (!modelName || !Object.prototype.hasOwnProperty.call(schemas, modelName)) continue;
          const requestBodyValue = operation.requestBody;
          if (requestBodyValue !== undefined && (typeof requestBodyValue !== 'object' || requestBodyValue === null || Array.isArray(requestBodyValue))) {
            continue; // native non-object requestBody wins untouched
          }
          const requestBody = (requestBodyValue as Record<string, unknown> | undefined) ?? {};
          const contentValue = requestBody.content;
          if (contentValue !== undefined && (typeof contentValue !== 'object' || contentValue === null || Array.isArray(contentValue))) {
            continue; // native non-object content wins untouched
          }
          const content = (contentValue as Record<string, unknown> | undefined) ?? {};
          const mediaValue = content[mediaType];
          if (mediaValue !== undefined && (typeof mediaValue !== 'object' || mediaValue === null || Array.isArray(mediaValue))) {
            continue; // native non-object media wins untouched
          }
          const media = (mediaValue as Record<string, unknown> | undefined) ?? {};
          if (!Object.prototype.hasOwnProperty.call(media, 'schema')) {
            media.schema = { $ref: `#/components/schemas/${modelName}` };
            content[mediaType] = media;
            requestBody.content = content;
            operation.requestBody = requestBody;
          }
        }

        const validatorId = (method as RestApiFallbackMethodWithValidator).requestValidatorId;
        if (validatorId) {
          const validator = validatorById.get(validatorId);
          if (validator && !Object.prototype.hasOwnProperty.call(operation, 'x-amazon-apigateway-request-validator')) {
            operation['x-amazon-apigateway-request-validator'] = validator.name;
          }
        }
      }
    }
  }

  // 6. GetExport requested application/yaml, so serialize as YAML.
  return stringify(document);
}

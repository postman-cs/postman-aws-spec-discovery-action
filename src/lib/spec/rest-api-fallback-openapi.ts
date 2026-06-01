import { stringify } from 'yaml';

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

import { stringify } from 'yaml';

export interface WebSocketRouteSummary {
  routeKey: string;
  routeId?: string;
  apiKeyRequired?: boolean;
  authorizationType?: string;
  authorizationScopes?: string[];
  authorizerId?: string;
  operationName?: string;
  modelSelectionExpression?: string;
  requestModels?: Record<string, string>;
  requestParameters?: Record<string, unknown>;
  routeResponseSelectionExpression?: string;
  target?: string;
  integration?: WebSocketIntegrationSummary;
  authorizer?: WebSocketAuthorizerSummary;
  routeResponses?: WebSocketRouteResponseSummary[];
}

export interface WebSocketIntegrationSummary {
  integrationId?: string;
  integrationType?: string;
  integrationUri?: string;
  integrationMethod?: string;
  requestParameters?: Record<string, string>;
  requestTemplates?: Record<string, string>;
  templateSelectionExpression?: string;
  timeoutInMillis?: number;
}

export interface WebSocketAuthorizerSummary {
  authorizerId?: string;
  authorizerType?: string;
  authorizerUri?: string;
  identitySource?: string[];
}

export interface WebSocketRouteResponseSummary {
  routeResponseId?: string;
  routeResponseKey?: string;
  modelSelectionExpression?: string;
  responseModels?: Record<string, string>;
  responseParameters?: Record<string, unknown>;
}

export interface WebSocketModelSummary {
  name: string;
  contentType?: string;
  schema?: string;
}

export interface WebSocketOpenApiInput {
  apiId: string;
  apiName: string;
  region: string;
  stage?: string;
  routeSelectionExpression?: string;
  routes: WebSocketRouteSummary[];
  models?: WebSocketModelSummary[];
}

const DEFAULT_ROUTES: WebSocketRouteSummary[] = [
  { routeKey: '$connect' },
  { routeKey: '$disconnect' },
  { routeKey: '$default' }
];

export function synthesizeWebSocketOpenApi(input: WebSocketOpenApiInput): string {
  const routes = input.routes.length > 0 ? input.routes : DEFAULT_ROUTES;
  const document: Record<string, unknown> = {
    openapi: '3.0.3',
    info: {
      title: input.apiName || input.apiId,
      version: '1.0.0',
      description: 'Partial OpenAPI description synthesized from API Gateway WebSocket routes.'
    },
    servers: [
      {
        url: serverUrl(input),
        description: 'API Gateway WebSocket endpoint'
      }
    ],
    'x-amazon-apigateway-api-id': input.apiId,
    'x-amazon-apigateway-protocol': 'WEBSOCKET',
    'x-amazon-apigateway-route-selection-expression': input.routeSelectionExpression || '$request.body.action',
    paths: {}
  };

  const schemas = modelSchemas(input.models ?? []);
  if (Object.keys(schemas).length > 0) {
    document.components = { schemas };
  }

  for (const route of routes) {
    const routeKey = route.routeKey || '$default';
    const path = routePath(routeKey);
    (document.paths as Record<string, unknown>)[path] = {
      post: routeOperation(route, routeKey)
    };
  }

  return stringify(document, { lineWidth: 0 });
}

function routeOperation(route: WebSocketRouteSummary, routeKey: string): Record<string, unknown> {
  return omitUndefined({
    operationId: operationId(route),
    summary: `WebSocket route ${routeKey}`,
    'x-amazon-apigateway-route-key': routeKey,
    'x-amazon-apigateway-route-id': route.routeId,
    'x-amazon-apigateway-api-key-required': route.apiKeyRequired,
    'x-amazon-apigateway-authorization-type': route.authorizationType,
    'x-amazon-apigateway-authorization-scopes': route.authorizationScopes,
    'x-amazon-apigateway-authorizer-id': route.authorizerId,
    'x-amazon-apigateway-authorizer': authorizerExtension(route.authorizer),
    'x-amazon-apigateway-model-selection-expression': route.modelSelectionExpression,
    'x-amazon-apigateway-request-models': route.requestModels,
    'x-amazon-apigateway-request-parameters': route.requestParameters,
    'x-amazon-apigateway-route-response-selection-expression': route.routeResponseSelectionExpression,
    'x-amazon-apigateway-route-responses': routeResponseExtensions(route.routeResponses),
    'x-amazon-apigateway-target': route.target,
    'x-amazon-apigateway-integration': integrationExtension(route.integration),
    requestBody: {
      required: false,
      content: requestBodyContent(route.requestModels)
    },
    responses: {
      '200': {
        description: 'WebSocket route accepted'
      }
    }
  });
}

function serverUrl(input: WebSocketOpenApiInput): string {
  const base = `wss://${input.apiId}.execute-api.${input.region}.amazonaws.com`;
  return input.stage ? `${base}/${input.stage}` : base;
}

function routePath(routeKey: string): string {
  if (routeKey.startsWith('$')) {
    return `/${routeKey}`;
  }
  return `/${routeKey.replace(/\s+/g, '-')}`;
}

function operationId(route: WebSocketRouteSummary): string {
  const raw = route.operationName?.trim() || route.routeKey || 'default';
  const clean = raw.replace(/^\$/, '').replace(/[^a-zA-Z0-9]+/g, ' ').trim();
  const words = clean ? clean.split(/\s+/) : ['default'];
  return words
    .map((word, index) => {
      const normalized = `${word.slice(0, 1).toLowerCase()}${word.slice(1)}`;
      return index === 0 ? normalized : `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`;
    })
    .join('');
}

function requestBodyContent(requestModels: Record<string, string> | undefined): Record<string, unknown> {
  const entries = Object.entries(requestModels ?? {});
  if (entries.length === 0) {
    return {
      'application/json': {
        schema: { type: 'object', additionalProperties: true }
      }
    };
  }
  return Object.fromEntries(
    entries.map(([contentType, modelName]) => [
      contentType,
      {
        schema: { $ref: `#/components/schemas/${modelName}` }
      }
    ])
  );
}

function integrationExtension(integration: WebSocketIntegrationSummary | undefined): Record<string, unknown> | undefined {
  if (!integration) return undefined;
  return omitUndefined({
    integrationId: integration.integrationId,
    type: integration.integrationType,
    uri: integration.integrationUri,
    httpMethod: integration.integrationMethod,
    requestParameters: integration.requestParameters,
    requestTemplates: integration.requestTemplates,
    templateSelectionExpression: integration.templateSelectionExpression,
    timeoutInMillis: integration.timeoutInMillis
  });
}

function authorizerExtension(authorizer: WebSocketAuthorizerSummary | undefined): Record<string, unknown> | undefined {
  if (!authorizer) return undefined;
  return omitUndefined({
    authorizerId: authorizer.authorizerId,
    type: authorizer.authorizerType,
    uri: authorizer.authorizerUri,
    identitySource: authorizer.identitySource
  });
}

function routeResponseExtensions(routeResponses: WebSocketRouteResponseSummary[] | undefined): Record<string, unknown>[] | undefined {
  const responses = (routeResponses ?? [])
    .map((response) => omitUndefined({
      routeResponseId: response.routeResponseId,
      routeResponseKey: response.routeResponseKey,
      modelSelectionExpression: response.modelSelectionExpression,
      responseModels: response.responseModels,
      responseParameters: response.responseParameters
    }))
    .filter((response) => Object.keys(response).length > 0);
  return responses.length > 0 ? responses : undefined;
}

function modelSchemas(models: WebSocketModelSummary[]): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const model of models) {
    if (!model.name) continue;
    schemas[model.name] = parseModelSchema(model.schema);
  }
  return schemas;
}

function parseModelSchema(schema: string | undefined): unknown {
  if (!schema?.trim()) {
    return { type: 'object', additionalProperties: true };
  }
  try {
    return JSON.parse(schema);
  } catch {
    return { type: 'object', additionalProperties: true };
  }
}

function omitUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

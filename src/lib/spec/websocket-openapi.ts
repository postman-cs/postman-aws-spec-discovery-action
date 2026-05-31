export interface WebSocketRouteSummary {
  routeKey: string;
  authorizationType?: string;
  operationName?: string;
  target?: string;
}

export interface WebSocketOpenApiInput {
  apiId: string;
  apiName: string;
  region: string;
  stage?: string;
  routeSelectionExpression?: string;
  routes: WebSocketRouteSummary[];
}

const DEFAULT_ROUTES: WebSocketRouteSummary[] = [
  { routeKey: '$connect' },
  { routeKey: '$disconnect' },
  { routeKey: '$default' }
];

export function synthesizeWebSocketOpenApi(input: WebSocketOpenApiInput): string {
  const routes = input.routes.length > 0 ? input.routes : DEFAULT_ROUTES;
  const lines: string[] = [
    'openapi: 3.0.3',
    'info:',
    `  title: ${quoteYaml(input.apiName || input.apiId)}`,
    '  version: "1.0.0"',
    '  description: "Partial OpenAPI description synthesized from API Gateway WebSocket routes."',
    'servers:',
    `  - url: ${quoteYaml(serverUrl(input))}`,
    '    description: "API Gateway WebSocket endpoint"',
    `x-amazon-apigateway-api-id: ${quoteYaml(input.apiId)}`,
    'x-amazon-apigateway-protocol: "WEBSOCKET"',
    `x-amazon-apigateway-route-selection-expression: ${quoteYaml(input.routeSelectionExpression || '$request.body.action')}`,
    'paths:'
  ];

  for (const route of routes) {
    const routeKey = route.routeKey || '$default';
    const path = routePath(routeKey);
    lines.push(`  ${quoteYaml(path)}:`);
    lines.push('    post:');
    lines.push(`      operationId: ${operationId(route)}`);
    lines.push(`      summary: ${quoteYaml(`WebSocket route ${routeKey}`)}`);
    lines.push(`      x-amazon-apigateway-route-key: ${quoteYaml(routeKey)}`);
    if (route.authorizationType) {
      lines.push(`      x-amazon-apigateway-authorization-type: ${quoteYaml(route.authorizationType)}`);
    }
    if (route.target) {
      lines.push(`      x-amazon-apigateway-target: ${quoteYaml(route.target)}`);
    }
    lines.push('      requestBody:');
    lines.push('        required: false');
    lines.push('        content:');
    lines.push('          application/json:');
    lines.push('            schema:');
    lines.push('              type: object');
    lines.push('              additionalProperties: true');
    lines.push('      responses:');
    lines.push('        "200":');
    lines.push('          description: WebSocket route accepted');
  }

  return `${lines.join('\n')}\n`;
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
    .map((word, index) => index === 0 ? word.toLowerCase() : `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join('');
}

function quoteYaml(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

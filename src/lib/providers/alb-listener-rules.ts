import type { AlbListenerRulesSpecClient, AlbRuleCondition } from '../aws/alb-client.js';
import type { ExportOptions, SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

export class AlbListenerRulesProvider implements SpecProvider {
  public readonly type = 'alb-listener-rule' as const;

  public constructor(private readonly client: AlbListenerRulesSpecClient) {}

  public async probe(): Promise<boolean> {
    return this.client.probe();
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    return (await this.client.listRules()).map((rule) => ({
      id: rule.ruleArn,
      name: rule.priority ? `alb-rule-${rule.priority}` : rule.ruleArn.split('/').pop() ?? 'alb-rule',
      providerType: 'alb-listener-rule',
      tags: {},
      evidence: [`ALB listener rule discovered: ${rule.ruleArn}`],
      meta: {
        ruleArn: rule.ruleArn,
        priority: rule.priority ?? '',
        listenerArn: rule.listenerArn ?? '',
        loadBalancerArn: rule.loadBalancerArn ?? '',
        loadBalancerDnsName: rule.loadBalancerDnsName ?? '',
        conditionsJson: JSON.stringify(rule.conditions),
        actionsJson: JSON.stringify(rule.actions)
      }
    }));
  }

  public async exportSpec(candidate: SpecCandidate, _options?: ExportOptions): Promise<SpecExportResult> {
    void _options;
    const conditions = parseConditions(candidate.meta.conditionsJson);
    const paths = pathsForConditions(conditions);
    const methods = methodsForConditions(conditions);
    const queryParams = queryParamsForConditions(conditions);
    const hostnames = hostnamesForConditions(conditions);
    const document = {
      openapi: '3.1.0',
      info: {
        title: candidate.name,
        version: '1.0.0',
        description: 'Partial HTTP surface derived from Application Load Balancer listener rule conditions.'
      },
      servers: candidate.meta.loadBalancerDnsName ? [{ url: `https://${candidate.meta.loadBalancerDnsName}` }] : [],
      paths: Object.fromEntries(
        paths.map((path) => [
          path,
          Object.fromEntries(
            methods.map((method) => [
              method.toLowerCase(),
              {
                operationId: `${method.toLowerCase()}${camelPath(path)}AlbRule`,
                summary: `ALB listener rule ${candidate.meta.priority || candidate.name}`,
                parameters: [
                  ...queryParams.map((param) => ({
                    name: param.key || 'query',
                    in: 'query',
                    required: false,
                    schema: param.value ? { type: 'string', const: param.value } : { type: 'string' }
                  }))
                ],
                'x-aws-alb-listener-rule': {
                  ruleArn: candidate.meta.ruleArn,
                  listenerArn: candidate.meta.listenerArn || undefined,
                  loadBalancerArn: candidate.meta.loadBalancerArn || undefined,
                  hostnames,
                  conditions,
                  actions: parseJsonArray(candidate.meta.actionsJson)
                },
                responses: { '200': { description: 'Response forwarded by ALB target' } }
              }
            ])
          )
        ])
      )
    };
    return {
      content: `${JSON.stringify(document, null, 2)}\n`,
      format: 'openapi-json',
      filename: 'index.json',
      derivedOpenApiCompleteness: 'partial',
      evidence: [`Synthesized partial OpenAPI paths from ALB listener rule ${candidate.meta.ruleArn}`]
    };
  }
}

function parseConditions(raw: string | undefined): AlbRuleCondition[] {
  const parsed = parseJsonArray(raw);
  return parsed as AlbRuleCondition[];
}

function pathsForConditions(conditions: AlbRuleCondition[]): string[] {
  const values = conditions
    .filter((condition) => condition.field === 'path-pattern')
    .flatMap((condition) => condition.values ?? []);
  const paths = values.length > 0 ? values : ['/'];
  return [...new Set(paths.map((value) => value.replace(/\*/g, '{proxy}')))];
}

function methodsForConditions(conditions: AlbRuleCondition[]): string[] {
  const values = conditions
    .filter((condition) => condition.field === 'http-request-method')
    .flatMap((condition) => condition.values ?? [])
    .map((value) => value.toLowerCase());
  return values.length > 0 ? [...new Set(values)] : ['get', 'post'];
}

function queryParamsForConditions(conditions: AlbRuleCondition[]): Array<{ key?: string; value?: string }> {
  return conditions
    .filter((condition) => condition.field === 'query-string')
    .flatMap((condition) => condition.queryString ?? []);
}

function hostnamesForConditions(conditions: AlbRuleCondition[]): string[] {
  return conditions
    .filter((condition) => condition.field === 'host-header')
    .flatMap((condition) => condition.values ?? []);
}

function parseJsonArray(raw: string | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function camelPath(value: string): string {
  const cleaned = value.replace(/[{}]/g, '').replace(/[^a-zA-Z0-9]+(.)/g, (_match, chr: string) => chr.toUpperCase());
  return cleaned.replace(/^([a-z])/, (match) => match.toUpperCase()) || 'Root';
}

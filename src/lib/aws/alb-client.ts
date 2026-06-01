import {
  DescribeListenersCommand,
  DescribeLoadBalancersCommand,
  DescribeRulesCommand,
  ElasticLoadBalancingV2Client,
  type Action,
  type Listener,
  type LoadBalancer,
  type Rule,
  type RuleCondition
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export interface AlbRuleCondition {
  field?: string;
  values?: string[];
  httpHeaderName?: string;
  queryString?: Array<{ key?: string; value?: string }>;
}

export interface AlbRuleAction {
  type?: string;
  targetGroupArn?: string;
  redirectJson?: string;
  fixedResponseJson?: string;
}

export interface AlbRuleSummary {
  ruleArn: string;
  priority?: string;
  listenerArn?: string;
  loadBalancerArn?: string;
  loadBalancerDnsName?: string;
  conditions: AlbRuleCondition[];
  actions: AlbRuleAction[];
}

export interface AlbListenerRulesSpecClient {
  listRules(): Promise<AlbRuleSummary[]>;
  probe(): Promise<boolean>;
}

export class AlbListenerRulesSdkClient implements AlbListenerRulesSpecClient {
  private readonly client: ElasticLoadBalancingV2Client;

  public constructor(region: string, options: { requestTimeoutMs?: number; maxAttempts?: number } = {}) {
    const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.client = new ElasticLoadBalancingV2Client({
      region,
      maxAttempts: options.maxAttempts ?? 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: requestTimeoutMs,
        socketTimeout: requestTimeoutMs
      })
    });
  }

  public async listRules(): Promise<AlbRuleSummary[]> {
    const rules: AlbRuleSummary[] = [];
    for (const loadBalancer of await this.listLoadBalancers()) {
      if (!loadBalancer.LoadBalancerArn || loadBalancer.Type !== 'application') continue;
      for (const listener of await this.listListeners(loadBalancer.LoadBalancerArn)) {
        if (!listener.ListenerArn) continue;
        for (const rule of await this.listRulesForListener(listener.ListenerArn)) {
          const mapped = mapRule(rule, listener, loadBalancer);
          if (mapped && !rule.IsDefault) rules.push(mapped);
        }
      }
    }
    return rules;
  }

  public async probe(): Promise<boolean> {
    try {
      await this.client.send(new DescribeLoadBalancersCommand({ PageSize: 1 }));
      return true;
    } catch {
      return false;
    }
  }

  private async listLoadBalancers(): Promise<LoadBalancer[]> {
    const loadBalancers: LoadBalancer[] = [];
    let marker: string | undefined;
    do {
      const response = await this.client.send(new DescribeLoadBalancersCommand({ Marker: marker, PageSize: 400 }));
      loadBalancers.push(...(response.LoadBalancers ?? []));
      marker = response.NextMarker;
    } while (marker);
    return loadBalancers;
  }

  private async listListeners(loadBalancerArn: string): Promise<Listener[]> {
    const listeners: Listener[] = [];
    let marker: string | undefined;
    do {
      const response = await this.client.send(
        new DescribeListenersCommand({ LoadBalancerArn: loadBalancerArn, Marker: marker, PageSize: 400 })
      );
      listeners.push(...(response.Listeners ?? []));
      marker = response.NextMarker;
    } while (marker);
    return listeners;
  }

  private async listRulesForListener(listenerArn: string): Promise<Rule[]> {
    const rules: Rule[] = [];
    let marker: string | undefined;
    do {
      const response = await this.client.send(new DescribeRulesCommand({ ListenerArn: listenerArn, Marker: marker, PageSize: 400 }));
      rules.push(...(response.Rules ?? []));
      marker = response.NextMarker;
    } while (marker);
    return rules;
  }
}

function mapRule(rule: Rule, listener: Listener, loadBalancer: LoadBalancer): AlbRuleSummary | undefined {
  if (!rule.RuleArn) return undefined;
  return {
    ruleArn: rule.RuleArn,
    priority: rule.Priority,
    listenerArn: listener.ListenerArn,
    loadBalancerArn: loadBalancer.LoadBalancerArn,
    loadBalancerDnsName: loadBalancer.DNSName,
    conditions: (rule.Conditions ?? []).map(mapCondition),
    actions: (rule.Actions ?? []).map(mapAction)
  };
}

function mapCondition(condition: RuleCondition): AlbRuleCondition {
  return {
    field: condition.Field,
    values: condition.Values ?? condition.HostHeaderConfig?.Values ?? condition.PathPatternConfig?.Values ??
      condition.HttpRequestMethodConfig?.Values ?? condition.SourceIpConfig?.Values,
    httpHeaderName: condition.HttpHeaderConfig?.HttpHeaderName,
    queryString: condition.QueryStringConfig?.Values?.map((item) => ({ key: item.Key, value: item.Value }))
  };
}

function mapAction(action: Action): AlbRuleAction {
  return {
    type: action.Type,
    targetGroupArn: action.TargetGroupArn,
    redirectJson: action.RedirectConfig ? JSON.stringify(action.RedirectConfig) : undefined,
    fixedResponseJson: action.FixedResponseConfig ? JSON.stringify(action.FixedResponseConfig) : undefined
  };
}

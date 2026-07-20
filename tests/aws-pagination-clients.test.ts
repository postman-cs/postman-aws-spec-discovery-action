import { describe, expect, it, vi } from 'vitest';

import { AlbListenerRulesSdkClient } from '../src/lib/aws/alb-client.js';
import { LambdaEventSourceSdkClient } from '../src/lib/aws/lambda-event-source-client.js';
import { MAX_AWS_LIST_PAGES } from '../src/lib/aws/pagination.js';

describe('LambdaEventSourceSdkClient pagination', () => {
  it('aggregates two Marker pages and rejects repeated token / page-cap', async () => {
    const client = new LambdaEventSourceSdkClient('us-east-1');
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        EventSourceMappings: [
          {
            UUID: 'map-1',
            EventSourceArn: 'arn:aws:sqs:us-east-1:1:q1',
            FunctionArn: 'arn:aws:lambda:us-east-1:1:function:fn-1',
            State: 'Enabled'
          }
        ],
        NextMarker: 'page-2'
      })
      .mockResolvedValueOnce({
        EventSourceMappings: [
          {
            UUID: 'map-2',
            EventSourceArn: 'arn:aws:sqs:us-east-1:1:q2',
            FunctionArn: 'arn:aws:lambda:us-east-1:1:function:fn-2',
            State: 'Disabled'
          }
        ]
      });
    (client as unknown as { client: { send: typeof send } }).client = { send };

    await expect(client.listEventSourceMappings()).resolves.toEqual([
      {
        uuid: 'map-1',
        eventSourceArn: 'arn:aws:sqs:us-east-1:1:q1',
        functionArn: 'arn:aws:lambda:us-east-1:1:function:fn-1',
        state: 'Enabled',
        batchSize: undefined,
        maximumBatchingWindowInSeconds: undefined,
        filterCriteria: undefined,
        topics: undefined,
        queues: undefined
      },
      {
        uuid: 'map-2',
        eventSourceArn: 'arn:aws:sqs:us-east-1:1:q2',
        functionArn: 'arn:aws:lambda:us-east-1:1:function:fn-2',
        state: 'Disabled',
        batchSize: undefined,
        maximumBatchingWindowInSeconds: undefined,
        filterCriteria: undefined,
        topics: undefined,
        queues: undefined
      }
    ]);
    expect(send).toHaveBeenCalledTimes(2);

    send.mockReset();
    send.mockResolvedValue({
      EventSourceMappings: [{ UUID: 'map-x', FunctionArn: 'arn:aws:lambda:us-east-1:1:function:fn-x' }],
      NextMarker: 'stuck'
    });
    await expect(client.listEventSourceMappings()).rejects.toThrow(
      'Lambda ListEventSourceMappings pagination returned a repeated token; aborting'
    );
    expect(send).toHaveBeenCalledTimes(2);

    send.mockReset();
    let pages = 0;
    send.mockImplementation(async () => {
      pages += 1;
      return {
        EventSourceMappings: [{ UUID: `map-${pages}`, FunctionArn: `arn:aws:lambda:us-east-1:1:function:fn-${pages}` }],
        NextMarker: `tok-${pages + 1}`
      };
    });
    await expect(client.listEventSourceMappings()).rejects.toThrow(
      `Lambda ListEventSourceMappings pagination exceeded ${MAX_AWS_LIST_PAGES} pages; aborting`
    );
    expect(pages).toBe(MAX_AWS_LIST_PAGES);
  });
});

describe('AlbListenerRulesSdkClient pagination', () => {
  const loadBalancer = {
    LoadBalancerArn: 'arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/demo/abc',
    DNSName: 'demo.us-east-1.elb.amazonaws.com',
    Type: 'application'
  };
  const listener = {
    ListenerArn: 'arn:aws:elasticloadbalancing:us-east-1:1:listener/app/demo/abc/111'
  };

  it('aggregates two DescribeRules Marker pages via listRules', async () => {
    const client = new AlbListenerRulesSdkClient('us-east-1');
    const send = vi.fn().mockImplementation(async (command: { constructor: { name: string }; input?: Record<string, unknown> }) => {
      const name = command.constructor.name;
      if (name === 'DescribeLoadBalancersCommand') {
        return { LoadBalancers: [loadBalancer] };
      }
      if (name === 'DescribeListenersCommand') {
        return { Listeners: [listener] };
      }
      if (name === 'DescribeRulesCommand') {
        if (command.input?.Marker === 'rules-page-2') {
          return {
            Rules: [
              {
                RuleArn: 'arn:aws:elasticloadbalancing:us-east-1:1:listener-rule/app/demo/abc/111/r2',
                Priority: '20',
                Conditions: [{ Field: 'host-header', Values: ['api.example.com'] }],
                Actions: [{ Type: 'forward', TargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:1:targetgroup/tg/2' }],
                IsDefault: false
              }
            ]
          };
        }
        return {
          Rules: [
            {
              RuleArn: 'arn:aws:elasticloadbalancing:us-east-1:1:listener-rule/app/demo/abc/111/r1',
              Priority: '10',
              Conditions: [{ Field: 'path-pattern', Values: ['/v1/*'] }],
              Actions: [{ Type: 'forward', TargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:1:targetgroup/tg/1' }],
              IsDefault: false
            }
          ],
          NextMarker: 'rules-page-2'
        };
      }
      throw new Error(`Unexpected command ${name}`);
    });
    (client as unknown as { client: { send: typeof send } }).client = { send };

    const rules = await client.listRules();
    expect(rules).toHaveLength(2);
    expect(rules.map((rule) => rule.ruleArn)).toEqual([
      'arn:aws:elasticloadbalancing:us-east-1:1:listener-rule/app/demo/abc/111/r1',
      'arn:aws:elasticloadbalancing:us-east-1:1:listener-rule/app/demo/abc/111/r2'
    ]);
    expect(rules[0]?.conditions[0]?.values).toEqual(['/v1/*']);
    expect(rules[1]?.conditions[0]?.values).toEqual(['api.example.com']);
  });

  it('rejects repeated Marker on DescribeLoadBalancers without returning partial results', async () => {
    const client = new AlbListenerRulesSdkClient('us-east-1');
    const send = vi.fn().mockResolvedValue({
      LoadBalancers: [loadBalancer],
      NextMarker: 'stuck'
    });
    (client as unknown as { client: { send: typeof send } }).client = { send };

    await expect(client.listRules()).rejects.toThrow(
      'ALB DescribeLoadBalancers pagination returned a repeated token; aborting'
    );
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rejects the 100-page cap on DescribeLoadBalancers with exact call count', async () => {
    const client = new AlbListenerRulesSdkClient('us-east-1');
    let pages = 0;
    const send = vi.fn().mockImplementation(async () => {
      pages += 1;
      return {
        LoadBalancers: [
          {
            ...loadBalancer,
            LoadBalancerArn: `${loadBalancer.LoadBalancerArn}-${pages}`
          }
        ],
        NextMarker: `tok-${pages + 1}`
      };
    });
    (client as unknown as { client: { send: typeof send } }).client = { send };

    await expect(client.listRules()).rejects.toThrow(
      `ALB DescribeLoadBalancers pagination exceeded ${MAX_AWS_LIST_PAGES} pages; aborting`
    );
    expect(pages).toBe(MAX_AWS_LIST_PAGES);
    expect(send).toHaveBeenCalledTimes(MAX_AWS_LIST_PAGES);
  });
});

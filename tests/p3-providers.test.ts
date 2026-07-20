import { describe, expect, it, vi } from 'vitest';

import { AlbListenerRulesProvider } from '../src/lib/providers/alb-listener-rules.js';
import { AppSyncEventsProvider } from '../src/lib/providers/appsync-events.js';
import { BedrockActionGroupProvider } from '../src/lib/providers/bedrock-action-groups.js';
import { EventBridgeSurfaceProvider } from '../src/lib/providers/eventbridge-surfaces.js';
import { LambdaEventSourceProvider } from '../src/lib/providers/lambda-event-source.js';
import { StepFunctionsProvider } from '../src/lib/providers/step-functions.js';
import { VerifiedPermissionsProvider } from '../src/lib/providers/verified-permissions.js';
import type { AlbListenerRulesSpecClient } from '../src/lib/aws/alb-client.js';
import { AppSyncEventsSdkClient } from '../src/lib/aws/appsync-events-client.js';
import type { AppSyncEventsSpecClient } from '../src/lib/aws/appsync-events-client.js';
import { BedrockActionGroupsSdkClient } from '../src/lib/aws/bedrock-agent-client.js';
import type { BedrockActionGroupsSpecClient } from '../src/lib/aws/bedrock-agent-client.js';
import type { EventBridgeSurfaceSpecClient } from '../src/lib/aws/eventbridge-client.js';
import type { LambdaEventSourceSpecClient } from '../src/lib/aws/lambda-event-source-client.js';
import { MAX_AWS_LIST_PAGES } from '../src/lib/aws/pagination.js';
import { StepFunctionsSdkClient } from '../src/lib/aws/step-functions-client.js';
import type { StepFunctionsSpecClient } from '../src/lib/aws/step-functions-client.js';
import { VerifiedPermissionsSdkClient } from '../src/lib/aws/verified-permissions-client.js';
import type { VerifiedPermissionsSpecClient } from '../src/lib/aws/verified-permissions-client.js';
import type { S3SpecClient } from '../src/lib/aws/s3-client.js';

function parsed(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

describe('EventBridgeSurfaceProvider', () => {
  it('discovers rules, pipes, and API destinations and exports partial OpenAPI evidence', async () => {
    const client: EventBridgeSurfaceSpecClient = {
      probe: vi.fn().mockResolvedValue(true),
      listRules: vi.fn().mockResolvedValue([
        {
          name: 'orders-rule',
          arn: 'arn:aws:events:us-east-1:123456789012:rule/orders-rule',
          eventBusName: 'default',
          eventPattern: '{"source":["orders.service"],"detail-type":["OrderCreated"]}',
          state: 'ENABLED'
        }
      ]),
      listTargetsByRule: vi.fn().mockResolvedValue([
        {
          id: 'api',
          arn: 'arn:aws:events:us-east-1:123456789012:api-destination/orders-destination',
          httpParameters: {
            headerParameters: { 'X-Trace-Id': '$.id' },
            queryStringParameters: { source: 'eventbridge' }
          }
        }
      ]),
      listPipes: vi.fn().mockResolvedValue([
        {
          name: 'orders-pipe',
          arn: 'arn:aws:pipes:us-east-1:123456789012:pipe/orders-pipe',
          source: 'arn:aws:sqs:us-east-1:123456789012:orders',
          target: 'arn:aws:lambda:us-east-1:123456789012:function:orders'
        }
      ]),
      describePipe: vi.fn().mockResolvedValue({
        name: 'orders-pipe',
        arn: 'arn:aws:pipes:us-east-1:123456789012:pipe/orders-pipe',
        source: 'arn:aws:sqs:us-east-1:123456789012:orders',
        target: 'arn:aws:lambda:us-east-1:123456789012:function:orders',
        filterCriteria: { filters: [{ pattern: '{"body":{"type":["order.created"]}}' }] }
      }),
      listApiDestinations: vi.fn().mockResolvedValue([
        {
          name: 'orders-destination',
          arn: 'arn:aws:events:us-east-1:123456789012:api-destination/orders-destination',
          invocationEndpoint: 'https://api.example.com/orders',
          httpMethod: 'POST',
          connectionArn: 'arn:aws:events:us-east-1:123456789012:connection/orders',
          invocationRateLimitPerSecond: 25
        }
      ])
    };
    const provider = new EventBridgeSurfaceProvider(client);

    const candidates = await provider.listCandidates();
    expect(candidates.map((candidate) => candidate.meta.surfaceKind)).toEqual(['rule', 'pipe', 'api-destination']);

    const ruleExport = await provider.exportSpec(candidates[0]!, {});
    const ruleDoc = parsed(ruleExport.content);
    expect(ruleExport.derivedOpenApiCompleteness).toBe('partial');
    expect(ruleDoc.webhooks).toHaveProperty('orders-rule');
    expect(
      (((ruleDoc.webhooks as Record<string, unknown>)['orders-rule'] as Record<string, unknown>).post as Record<string, unknown>)[
        'x-aws-eventbridge-event-pattern'
      ]
    ).toEqual({ source: ['orders.service'], 'detail-type': ['OrderCreated'] });

    const destinationExport = await provider.exportSpec(candidates[2]!, {});
    const destinationDoc = parsed(destinationExport.content);
    expect(destinationDoc.paths).toHaveProperty('/orders');
    expect(
      (((destinationDoc.paths as Record<string, unknown>)['/orders'] as Record<string, unknown>).post as Record<string, unknown>)[
        'x-aws-eventbridge-api-destination'
      ]
    ).toMatchObject({ connectionArn: expect.stringContaining(':connection/orders'), invocationRateLimitPerSecond: 25 });
  });
});

describe('BedrockActionGroupProvider', () => {
  it('exports inline OpenAPI action group schemas', async () => {
    const client: BedrockActionGroupsSpecClient = {
      probe: vi.fn().mockResolvedValue(true),
      listAgents: vi.fn().mockResolvedValue([{ agentId: 'agent-1', agentName: 'orders-agent', latestAgentVersion: 'DRAFT' }]),
      listActionGroups: vi.fn().mockResolvedValue([
        { agentId: 'agent-1', agentVersion: 'DRAFT', actionGroupId: 'ag-1', actionGroupName: 'orders-api' }
      ]),
      getActionGroup: vi.fn().mockResolvedValue({
        agentId: 'agent-1',
        agentVersion: 'DRAFT',
        actionGroupId: 'ag-1',
        actionGroupName: 'orders-api',
        apiSchema: {
          payload: JSON.stringify({
            openapi: '3.0.3',
            info: { title: 'Orders', version: '1.0.0' },
            paths: { '/orders': { post: { responses: { '200': { description: 'ok' } } } } }
          })
        }
      })
    };
    const provider = new BedrockActionGroupProvider(client);
    const [candidate] = await provider.listCandidates();

    const result = await provider.exportSpec(candidate!, {});
    const doc = parsed(result.content);
    expect(result.format).toBe('openapi-json');
    expect(result.derivedOpenApiCompleteness).toBe('partial');
    expect(doc.paths).toHaveProperty('/orders');
    expect(doc['x-aws-bedrock-agent-action-group']).toMatchObject({ actionGroupId: 'ag-1' });
  });

  it('loads Bedrock action group OpenAPI schemas from S3 when referenced', async () => {
    const client: BedrockActionGroupsSpecClient = {
      probe: vi.fn().mockResolvedValue(true),
      listAgents: vi.fn().mockResolvedValue([]),
      listActionGroups: vi.fn().mockResolvedValue([]),
      getActionGroup: vi.fn().mockResolvedValue({
        agentId: 'agent-1',
        agentVersion: 'DRAFT',
        actionGroupId: 'ag-1',
        actionGroupName: 'orders-api',
        apiSchema: { s3: { s3BucketName: 'schemas', s3ObjectKey: 'orders/openapi.json' } }
      })
    };
    const s3: S3SpecClient = {
      getObject: vi.fn().mockResolvedValue('{"openapi":"3.0.3","info":{"title":"Orders","version":"1.0.0"},"paths":{}}')
    };
    const provider = new BedrockActionGroupProvider(client, s3);

    const result = await provider.exportSpec(
      {
        id: 'agent-1/DRAFT/ag-1',
        name: 'orders-api',
        providerType: 'bedrock-action-group',
        tags: {},
        evidence: [],
        meta: { agentId: 'agent-1', agentVersion: 'DRAFT', actionGroupId: 'ag-1' }
      },
      {}
    );

    expect(s3.getObject).toHaveBeenCalledWith('schemas', 'orders/openapi.json');
    expect(parsed(result.content)).toHaveProperty('openapi', '3.0.3');
  });
});

describe('AppSyncEventsProvider', () => {
  it('synthesizes publish and subscribe channel namespace webhooks', async () => {
    const client: AppSyncEventsSpecClient = {
      probe: vi.fn().mockResolvedValue(true),
      listEventApis: vi.fn().mockResolvedValue([
        {
          apiId: 'evt-1',
          name: 'orders-events',
          apiArn: 'arn:aws:appsync:us-east-1:123456789012:apis/evt-1',
          dns: { realtime: 'abc.appsync-realtime-api.us-east-1.amazonaws.com' }
        }
      ]),
      listChannelNamespaces: vi.fn().mockResolvedValue([
        {
          apiId: 'evt-1',
          name: 'orders',
          channelNamespaceArn: 'arn:aws:appsync:us-east-1:123456789012:apis/evt-1/channelNamespace/orders',
          publishAuthModes: [{ authType: 'API_KEY' }],
          subscribeAuthModes: [{ authType: 'AWS_IAM' }]
        }
      ])
    };
    const provider = new AppSyncEventsProvider(client);
    const [candidate] = await provider.listCandidates();

    const result = await provider.exportSpec(candidate!, {});
    const doc = parsed(result.content);
    expect(result.format).toBe('openapi-json');
    expect(Object.keys(doc.webhooks as Record<string, unknown>)).toEqual(['orders.publish', 'orders.subscribe']);
    expect((doc['x-aws-appsync-events'] as Record<string, unknown>).apiId).toBe('evt-1');
  });
});

describe('AlbListenerRulesProvider', () => {
  it('derives HTTP paths, methods, and parameters from listener rule conditions', async () => {
    const client: AlbListenerRulesSpecClient = {
      probe: vi.fn().mockResolvedValue(true),
      listRules: vi.fn().mockResolvedValue([
        {
          ruleArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener-rule/app/orders/abc/def/rule',
          priority: '10',
          conditions: [
            { field: 'host-header', values: ['api.example.com'] },
            { field: 'path-pattern', values: ['/orders/*'] },
            { field: 'http-request-method', values: ['GET', 'POST'] },
            { field: 'query-string', queryString: [{ key: 'status', value: 'open' }] }
          ],
          actions: [{ type: 'forward', targetGroupArn: 'arn:aws:elasticloadbalancing:targetgroup/orders' }]
        }
      ])
    };
    const provider = new AlbListenerRulesProvider(client);
    const [candidate] = await provider.listCandidates();

    const result = await provider.exportSpec(candidate!, {});
    const doc = parsed(result.content);
    const pathItem = (doc.paths as Record<string, Record<string, unknown>>)['/orders/{proxy}']!;
    expect(Object.keys(pathItem)).toEqual(['get', 'post']);
    expect(pathItem.get).toMatchObject({ parameters: expect.arrayContaining([expect.objectContaining({ name: 'status', in: 'query' })]) });
  });
});

describe('LambdaEventSourceProvider', () => {
  it('preserves event source mapping filter criteria and batch settings', async () => {
    const client: LambdaEventSourceSpecClient = {
      probe: vi.fn().mockResolvedValue(true),
      listEventSourceMappings: vi.fn().mockResolvedValue([
        {
          uuid: 'esm-1',
          eventSourceArn: 'arn:aws:sqs:us-east-1:123456789012:orders',
          functionArn: 'arn:aws:lambda:us-east-1:123456789012:function:orders',
          state: 'Enabled',
          batchSize: 10,
          filterCriteria: { filters: [{ pattern: '{"body":{"type":["order.created"]}}' }] }
        }
      ]),
      getEventSourceMapping: vi.fn().mockResolvedValue({
        uuid: 'esm-1',
        eventSourceArn: 'arn:aws:sqs:us-east-1:123456789012:orders',
        functionArn: 'arn:aws:lambda:us-east-1:123456789012:function:orders',
        state: 'Enabled',
        batchSize: 10,
        filterCriteria: { filters: [{ pattern: '{"body":{"type":["order.created"]}}' }] }
      })
    };
    const provider = new LambdaEventSourceProvider(client);
    const [candidate] = await provider.listCandidates();

    const result = await provider.exportSpec(candidate!, {});
    const doc = parsed(result.content);
    const operation = ((doc.webhooks as Record<string, Record<string, unknown>>)['lambda-event-source.esm-1']!.post) as Record<string, unknown>;
    expect(operation['x-aws-lambda-filter-criteria']).toMatchObject({ filters: [{ pattern: '{"body":{"type":["order.created"]}}' }] });
    expect(operation['x-aws-lambda-event-source-mapping']).toMatchObject({ batchSize: 10, state: 'Enabled' });
  });
});

describe('VerifiedPermissionsProvider', () => {
  it('exports Cedar schema metadata without inventing endpoints', async () => {
    const client: VerifiedPermissionsSpecClient = {
      probe: vi.fn().mockResolvedValue(true),
      listPolicyStores: vi.fn().mockResolvedValue([
        { policyStoreId: 'store-1', arn: 'arn:aws:verifiedpermissions:us-east-1:123456789012:policy-store/store-1', description: 'orders auth' }
      ]),
      getSchema: vi.fn().mockResolvedValue({
        policyStoreId: 'store-1',
        schema: '{"Orders":{"entityTypes":{"User":{"shape":{"type":"Record","attributes":{}}}}}}',
        namespaces: ['Orders']
      })
    };
    const provider = new VerifiedPermissionsProvider(client);
    const [candidate] = await provider.listCandidates();

    const result = await provider.exportSpec(candidate!, {});
    const doc = parsed(result.content);
    expect(doc.paths).toEqual({});
    expect(doc['x-aws-verified-permissions']).toMatchObject({ policyStoreId: 'store-1', namespaces: ['Orders'] });
  });
});

describe('StepFunctionsProvider', () => {
  it('exports ASL definitions as partial workflow OpenAPI metadata', async () => {
    const client: StepFunctionsSpecClient = {
      probe: vi.fn().mockResolvedValue(true),
      listStateMachines: vi.fn().mockResolvedValue([
        { name: 'orders-workflow', arn: 'arn:aws:states:us-east-1:123456789012:stateMachine:orders-workflow', type: 'STANDARD' }
      ]),
      describeStateMachine: vi.fn().mockResolvedValue({
        name: 'orders-workflow',
        arn: 'arn:aws:states:us-east-1:123456789012:stateMachine:orders-workflow',
        type: 'STANDARD',
        definition: '{"StartAt":"Validate","States":{"Validate":{"Type":"Pass","End":true}}}',
        revisionId: 'rev-1'
      })
    };
    const provider = new StepFunctionsProvider(client);
    const [candidate] = await provider.listCandidates();

    const result = await provider.exportSpec(candidate!, {});
    const doc = parsed(result.content);
    expect(doc.paths).toHaveProperty('/step-functions/orders-workflow/executions');
    expect(doc['x-aws-stepfunctions']).toMatchObject({ stateMachineArn: expect.stringContaining('orders-workflow') });
  });
});

describe('P3 SDK client finite pagination', () => {
  it('Bedrock listAgents aggregates pages and rejects repeated token / page-cap', async () => {
    const client = new BedrockActionGroupsSdkClient('us-east-1');
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        agentSummaries: [{ agentId: 'a-1', agentName: 'agent-one', latestAgentVersion: '1' }],
        nextToken: 'page-2'
      })
      .mockResolvedValueOnce({
        agentSummaries: [{ agentId: 'a-2', agentName: 'agent-two', latestAgentVersion: '2' }]
      });
    (client as unknown as { client: { send: typeof send } }).client = { send };

    await expect(client.listAgents()).resolves.toEqual([
      { agentId: 'a-1', agentName: 'agent-one', latestAgentVersion: '1' },
      { agentId: 'a-2', agentName: 'agent-two', latestAgentVersion: '2' }
    ]);

    send.mockReset();
    send.mockResolvedValue({
      agentSummaries: [{ agentId: 'a-x', agentName: 'loop' }],
      nextToken: 'stuck'
    });
    await expect(client.listAgents()).rejects.toThrow(
      'Bedrock ListAgents pagination returned a repeated token; aborting'
    );
    expect(send).toHaveBeenCalledTimes(2);

    send.mockReset();
    let pages = 0;
    send.mockImplementation(async () => {
      pages += 1;
      return {
        agentSummaries: [{ agentId: `a-${pages}`, agentName: `agent-${pages}` }],
        nextToken: `tok-${pages + 1}`
      };
    });
    await expect(client.listAgents()).rejects.toThrow(
      `Bedrock ListAgents pagination exceeded ${MAX_AWS_LIST_PAGES} pages; aborting`
    );
    expect(pages).toBe(MAX_AWS_LIST_PAGES);
  });

  it('Step Functions listStateMachines rejects repeated token / page-cap', async () => {
    const client = new StepFunctionsSdkClient('us-east-1');
    const send = vi.fn().mockResolvedValue({
      stateMachines: [
        {
          name: 'wf-1',
          stateMachineArn: 'arn:aws:states:us-east-1:1:stateMachine:wf-1',
          type: 'STANDARD'
        }
      ],
      nextToken: 'stuck'
    });
    (client as unknown as { client: { send: typeof send } }).client = { send };

    await expect(client.listStateMachines()).rejects.toThrow(
      'Step Functions ListStateMachines pagination returned a repeated token; aborting'
    );
    expect(send).toHaveBeenCalledTimes(2);

    send.mockReset();
    let pages = 0;
    send.mockImplementation(async () => {
      pages += 1;
      return {
        stateMachines: [
          {
            name: `wf-${pages}`,
            stateMachineArn: `arn:aws:states:us-east-1:1:stateMachine:wf-${pages}`,
            type: 'STANDARD'
          }
        ],
        nextToken: `tok-${pages + 1}`
      };
    });
    await expect(client.listStateMachines()).rejects.toThrow(
      `Step Functions ListStateMachines pagination exceeded ${MAX_AWS_LIST_PAGES} pages; aborting`
    );
    expect(pages).toBe(MAX_AWS_LIST_PAGES);
  });

  it('Verified Permissions listPolicyStores aggregates and rejects page-cap', async () => {
    const client = new VerifiedPermissionsSdkClient('us-east-1');
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        policyStores: [{ policyStoreId: 'store-1', arn: 'arn:aws:verifiedpermissions:us-east-1:1:policy-store/store-1' }],
        nextToken: 'page-2'
      })
      .mockResolvedValueOnce({
        policyStores: [{ policyStoreId: 'store-2', arn: 'arn:aws:verifiedpermissions:us-east-1:1:policy-store/store-2' }]
      });
    (client as unknown as { client: { send: typeof send } }).client = { send };

    await expect(client.listPolicyStores()).resolves.toEqual([
      { policyStoreId: 'store-1', arn: 'arn:aws:verifiedpermissions:us-east-1:1:policy-store/store-1' },
      { policyStoreId: 'store-2', arn: 'arn:aws:verifiedpermissions:us-east-1:1:policy-store/store-2' }
    ]);

    send.mockReset();
    let pages = 0;
    send.mockImplementation(async () => {
      pages += 1;
      return {
        policyStores: [
          {
            policyStoreId: `store-${pages}`,
            arn: `arn:aws:verifiedpermissions:us-east-1:1:policy-store/store-${pages}`
          }
        ],
        nextToken: `tok-${pages + 1}`
      };
    });
    await expect(client.listPolicyStores()).rejects.toThrow(
      `Verified Permissions ListPolicyStores pagination exceeded ${MAX_AWS_LIST_PAGES} pages; aborting`
    );
    expect(pages).toBe(MAX_AWS_LIST_PAGES);
  });

  it('AppSync Events listEventApis rejects repeated token', async () => {
    const client = new AppSyncEventsSdkClient('us-east-1');
    const send = vi.fn().mockResolvedValue({
      apis: [{ apiId: 'evt-1', name: 'events', eventConfig: {}, apiArn: 'arn:evt-1' }],
      nextToken: 'stuck'
    });
    (client as unknown as { client: { send: typeof send } }).client = { send };

    await expect(client.listEventApis()).rejects.toThrow(
      'AppSync Events ListApis pagination returned a repeated token; aborting'
    );
    expect(send).toHaveBeenCalledTimes(2);
  });
});

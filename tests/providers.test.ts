import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as childProcess from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  GetSubscriptionAttributesCommand,
  GetTopicAttributesCommand,
  ListSubscriptionsByTopicCommand,
  ListTagsForResourceCommand,
  ListTopicsCommand
} from '@aws-sdk/client-sns';

import { ProviderRegistry } from '../src/lib/providers/registry.js';
import { ApiGatewayProvider } from '../src/lib/providers/api-gateway.js';
import { AppSyncProvider } from '../src/lib/providers/appsync.js';
import { EventBridgeSchemasProvider } from '../src/lib/providers/eventbridge-schemas.js';
import { CloudFormationProvider } from '../src/lib/providers/cloudformation.js';
import { GlueSchemaProvider } from '../src/lib/providers/glue.js';
import { LambdaUrlProvider } from '../src/lib/providers/lambda-url.js';
import { SnsProvider } from '../src/lib/providers/sns.js';
import { resolveCodeDerivedContract } from '../src/lib/providers/sns-code-derived.js';
import { SnsSdkClient } from '../src/lib/aws/sns-client.js';
import type { AwsGatewayClient } from '../src/lib/aws/client.js';
import type { AppSyncSpecClient } from '../src/lib/aws/appsync-client.js';
import type { EventBridgeSchemasSpecClient } from '../src/lib/aws/schemas-client.js';
import type { CloudFormationSpecClient } from '../src/lib/aws/cloudformation-client.js';
import type { GlueSchemaSpecClient } from '../src/lib/aws/glue-client.js';
import type { LambdaSpecClient } from '../src/lib/aws/lambda-client.js';
import type { SnsSpecClient } from '../src/lib/aws/sns-client.js';
import type { SsmSpecClient } from '../src/lib/aws/ssm-client.js';
import type { SpecCandidate } from '../src/lib/providers/types.js';

const { snsSendMock } = vi.hoisted(() => ({
  snsSendMock: vi.fn()
}));

vi.mock('@aws-sdk/client-sns', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-sns')>('@aws-sdk/client-sns');
  return {
    ...actual,
    SNSClient: class {
      public send = snsSendMock;
    }
  };
});

function createGatewayClientStub(overrides: Partial<AwsGatewayClient> = {}): AwsGatewayClient {
  return {
    listRestApis: vi.fn().mockResolvedValue([]),
    listHttpApis: vi.fn().mockResolvedValue([]),
    getRestApi: vi.fn().mockResolvedValue(undefined),
    getHttpApi: vi.fn().mockResolvedValue(undefined),
    listRestStages: vi.fn().mockResolvedValue([]),
    listHttpStages: vi.fn().mockResolvedValue([]),
    getRestTags: vi.fn().mockResolvedValue({}),
    getHttpTags: vi.fn().mockResolvedValue({}),
    exportRestApi: vi.fn().mockResolvedValue('openapi: 3.0.1'),
    exportHttpApi: vi.fn().mockResolvedValue('openapi: 3.0.1'),
    exportWebSocketApi: vi.fn().mockResolvedValue('openapi: 3.0.3'),
    getCallerIdentity: vi.fn().mockResolvedValue({ accountId: '123456789012', arn: 'arn:aws:iam::123456789012:role/test' }),
    probeApiGatewayReadAccess: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

function createAppSyncClientStub(overrides: Partial<AppSyncSpecClient> = {}): AppSyncSpecClient {
  return {
    listGraphqlApis: vi.fn().mockResolvedValue([]),
    getSchema: vi.fn().mockResolvedValue('type Query { hello: String }'),
    getTags: vi.fn().mockResolvedValue({}),
    probe: vi.fn().mockResolvedValue(true),
    ...overrides
  };
}

function createSchemasClientStub(overrides: Partial<EventBridgeSchemasSpecClient> = {}): EventBridgeSchemasSpecClient {
  return {
    listRegistries: vi.fn().mockResolvedValue([]),
    listSchemas: vi.fn().mockResolvedValue([]),
    exportSchema: vi.fn().mockResolvedValue('{}'),
    describeSchema: vi.fn().mockResolvedValue({ content: '{}', schemaVersion: '1' }),
    getTags: vi.fn().mockResolvedValue({}),
    probe: vi.fn().mockResolvedValue(true),
    ...overrides
  };
}

function createCfnClientStub(overrides: Partial<CloudFormationSpecClient> = {}): CloudFormationSpecClient {
  return {
    listActiveStacks: vi.fn().mockResolvedValue([]),
    listApiResources: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue('{}'),
    getStackTags: vi.fn().mockResolvedValue({}),
    probe: vi.fn().mockResolvedValue(true),
    ...overrides
  };
}

function createGlueClientStub(overrides: Partial<GlueSchemaSpecClient> = {}): GlueSchemaSpecClient {
  return {
    listRegistries: vi.fn().mockResolvedValue([]),
    listSchemas: vi.fn().mockResolvedValue([]),
    getLatestSchemaVersion: vi.fn().mockResolvedValue({ content: '{}', dataFormat: 'JSON', versionNumber: 1 }),
    getTags: vi.fn().mockResolvedValue({}),
    probe: vi.fn().mockResolvedValue(true),
    ...overrides
  };
}

function createLambdaClientStub(overrides: Partial<LambdaSpecClient> = {}): LambdaSpecClient {
  return {
    listFunctions: vi.fn().mockResolvedValue([]),
    getFunctionUrlConfig: vi.fn().mockResolvedValue(undefined),
    getTags: vi.fn().mockResolvedValue({}),
    probe: vi.fn().mockResolvedValue(true),
    ...overrides
  };
}

function createSnsClientStub(overrides: Partial<SnsSpecClient> = {}): SnsSpecClient {
  return {
    probe: vi.fn().mockResolvedValue(true),
    listTopics: vi.fn().mockResolvedValue([]),
    getTopicAttributes: vi.fn().mockResolvedValue({}),
    listTagsForResource: vi.fn().mockResolvedValue({}),
    listSubscriptionsByTopic: vi.fn().mockResolvedValue([]),
    getSubscriptionAttributes: vi.fn().mockResolvedValue({}),
    ...overrides
  };
}

function createSsmClientStub(overrides: Partial<SsmSpecClient> = {}): SsmSpecClient {
  return {
    listSpecParameters: vi.fn().mockResolvedValue([]),
    probe: vi.fn().mockResolvedValue(true),
    ...overrides
  };
}

function createSnsCandidate(overrides: Partial<SpecCandidate> = {}): SpecCandidate {
  return {
    id: 'arn:aws:sns:us-east-1:123456789012:orders-topic',
    name: 'orders-topic',
    providerType: 'sns',
    tags: {},
    evidence: [],
    meta: {
      topicArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic'
    },
    ...overrides
  };
}

describe('ProviderRegistry', () => {
  it('probes and returns only available providers', async () => {
    const registry = new ProviderRegistry();
    const available = createAppSyncClientStub({ probe: vi.fn().mockResolvedValue(true) });
    const unavailable = createSchemasClientStub({ probe: vi.fn().mockResolvedValue(false) });

    registry.register(new AppSyncProvider(available));
    registry.register(new EventBridgeSchemasProvider(unavailable));

    const result = await registry.probeAvailable();
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('appsync');
  });

  it('handles probe errors gracefully', async () => {
    const registry = new ProviderRegistry();
    const erroring = createAppSyncClientStub({ probe: vi.fn().mockRejectedValue(new Error('access denied')) });
    registry.register(new AppSyncProvider(erroring));

    const result = await registry.probeAvailable();
    expect(result).toHaveLength(0);
  });
});

describe('ApiGatewayProvider', () => {
  it('lists REST, HTTP, and WebSocket candidates', async () => {
    const client = createGatewayClientStub({
      listRestApis: vi.fn().mockResolvedValue([{ id: 'rest-1', name: 'my-rest' }]),
      listHttpApis: vi.fn().mockResolvedValue([
        { id: 'http-1', name: 'my-http', protocolType: 'HTTP' },
        { id: 'ws-1', name: 'my-ws', protocolType: 'WEBSOCKET' }
      ])
    });
    const provider = new ApiGatewayProvider(client, { includeV2: true });

    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.meta.gatewayType)).toEqual(['REST', 'HTTP', 'WEBSOCKET']);
  });

  it('filters out v2 APIs when includeV2 is false', async () => {
    const client = createGatewayClientStub({
      listRestApis: vi.fn().mockResolvedValue([{ id: 'rest-1', name: 'my-rest' }]),
      listHttpApis: vi.fn().mockResolvedValue([{ id: 'http-1', name: 'my-http', protocolType: 'HTTP' }])
    });
    const provider = new ApiGatewayProvider(client, { includeV2: false });

    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.meta.gatewayType).toBe('REST');
  });

  it('treats HTTP API access as available when REST probing is denied', async () => {
    const client = createGatewayClientStub({
      probeApiGatewayReadAccess: vi.fn().mockRejectedValue(new Error('rest denied')),
      probeHttpApiGatewayReadAccess: vi.fn().mockResolvedValue(undefined),
      listRestApis: vi.fn().mockRejectedValue(new Error('rest denied')),
      listHttpApis: vi.fn().mockResolvedValue([{ id: 'http-1', name: 'my-http', protocolType: 'HTTP' }])
    });
    const provider = new ApiGatewayProvider(client, { includeV2: true });

    await expect(provider.probe()).resolves.toBe(true);
    const candidates = await provider.listCandidates();

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe('http-1');
  });

  it('exports REST API spec', async () => {
    const client = createGatewayClientStub({
      exportRestApi: vi.fn().mockResolvedValue('openapi: 3.0.1\ninfo:\n  title: test')
    });
    const provider = new ApiGatewayProvider(client, { includeV2: true });

    const result = await provider.exportSpec(
      { id: 'rest-1', name: 'test', providerType: 'api-gateway', tags: {}, evidence: [], meta: { gatewayType: 'REST' } },
      { stage: 'prod' }
    );
    expect(result.format).toBe('openapi-yaml');
    expect(result.filename).toBe('index.yaml');
    expect(result.content).toContain('openapi');
  });

  it('exports partial WebSocket API OpenAPI spec', async () => {
    const client = createGatewayClientStub({
      exportWebSocketApi: vi.fn().mockResolvedValue([
        'openapi: 3.0.3',
        'info:',
        '  title: ws-api',
        '  version: "1.0.0"',
        'paths:',
        '  /sendMessage:',
        '    post:',
        '      x-amazon-apigateway-route-key: sendMessage'
      ].join('\n'))
    });
    const provider = new ApiGatewayProvider(client, { includeV2: true });

    const result = await provider.exportSpec(
      { id: 'ws-1', name: 'ws-api', providerType: 'api-gateway', tags: {}, evidence: [], meta: { gatewayType: 'WEBSOCKET' } },
      { stage: 'prod' }
    );

    expect(result.format).toBe('openapi-yaml');
    expect(result.filename).toBe('index.yaml');
    expect(result.content).toContain('x-amazon-apigateway-route-key: sendMessage');
    expect(result.evidence).toContain('Synthesized partial OpenAPI 3.0 spec for WebSocket API ws-1');
  });
});

describe('AppSyncProvider', () => {
  it('lists GraphQL and Merged APIs, skips Events APIs', async () => {
    const client = createAppSyncClientStub({
      listGraphqlApis: vi.fn().mockResolvedValue([
        { id: 'gql-1', name: 'my-api', arn: 'arn:1', apiType: 'GRAPHQL' },
        { id: 'gql-2', name: 'merged', arn: 'arn:2', apiType: 'MERGED' },
        { id: 'evt-1', name: 'events', arn: 'arn:3', apiType: 'EVENTS' }
      ])
    });
    const provider = new AppSyncProvider(client);

    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.name)).toEqual(['my-api', 'merged']);
  });

  it('exports GraphQL SDL schema', async () => {
    const client = createAppSyncClientStub({
      getSchema: vi.fn().mockResolvedValue('type Query { hello: String }'),
      getTags: vi.fn().mockResolvedValue({ 'postman:project-name': 'my-service' })
    });
    const provider = new AppSyncProvider(client);

    const result = await provider.exportSpec(
      { id: 'gql-1', name: 'my-api', providerType: 'appsync', tags: {}, evidence: [], meta: { arn: 'arn:1', apiType: 'GRAPHQL' } },
      {}
    );
    expect(result.format).toBe('graphql-sdl');
    expect(result.filename).toBe('schema.graphql');
    expect(result.content).toContain('type Query');
  });
});

describe('EventBridgeSchemasProvider', () => {
  it('lists schemas from custom registries, skips aws.events', async () => {
    const client = createSchemasClientStub({
      listRegistries: vi.fn().mockResolvedValue([
        { name: 'aws.events', arn: 'arn:aws-events' },
        { name: 'custom-registry', arn: 'arn:custom' }
      ]),
      listSchemas: vi.fn().mockResolvedValue([
        { name: 'OrderCreated', arn: 'arn:schema', registryName: 'custom-registry', versionCount: 2 }
      ])
    });
    const provider = new EventBridgeSchemasProvider(client);

    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.name).toBe('OrderCreated');
    expect(candidates[0]?.id).toBe('custom-registry/OrderCreated');
  });

  it('exports schema via describeSchema', async () => {
    const client = createSchemasClientStub({
      describeSchema: vi.fn().mockResolvedValue({ content: '{"openapi":"3.0.0","components":{}}', schemaVersion: '1' })
    });
    const provider = new EventBridgeSchemasProvider(client);

    const result = await provider.exportSpec(
      { id: 'reg/schema', name: 'OrderCreated', providerType: 'eventbridge-schemas', tags: {}, evidence: [], meta: { registryName: 'custom', schemaName: 'OrderCreated', arn: 'arn:1' } },
      {}
    );
    expect(result.format).toBe('openapi-json');
    expect(result.filename).toBe('index.json');
    expect(result.content).toContain('openapi');
  });

  it('keeps JSON Schema content labeled as json-schema', async () => {
    const client = createSchemasClientStub({
      describeSchema: vi.fn().mockResolvedValue({ content: '{"type":"object","properties":{}}', schemaVersion: '1' })
    });
    const provider = new EventBridgeSchemasProvider(client);

    const result = await provider.exportSpec(
      { id: 'reg/schema', name: 'OrderCreated', providerType: 'eventbridge-schemas', tags: {}, evidence: [], meta: { registryName: 'custom', schemaName: 'OrderCreated', arn: 'arn:1' } },
      {}
    );
    expect(result.format).toBe('json-schema');
  });
});

describe('CloudFormationProvider', () => {
  it('lists API resources from active stacks', async () => {
    const client = createCfnClientStub({
      listActiveStacks: vi.fn().mockResolvedValue([
        { name: 'my-stack', id: 'stack-1', status: 'CREATE_COMPLETE' }
      ]),
      listApiResources: vi.fn().mockResolvedValue([
        { logicalId: 'MyApi', physicalId: 'rest-1', type: 'AWS::ApiGateway::RestApi' }
      ])
    });
    const provider = new CloudFormationProvider(client);

    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe('my-stack/MyApi');
    expect(candidates[0]?.meta.resourceType).toBe('AWS::ApiGateway::RestApi');
  });

  it('extracts embedded OpenAPI spec from template', async () => {
    const template = JSON.stringify({
      Resources: {
        MyApi: {
          Type: 'AWS::ApiGateway::RestApi',
          Properties: {
            Body: { openapi: '3.0.1', info: { title: 'embedded', version: '1.0' }, paths: {} }
          }
        }
      }
    });
    const client = createCfnClientStub({
      getTemplate: vi.fn().mockResolvedValue(template)
    });
    const provider = new CloudFormationProvider(client);

    const result = await provider.exportSpec(
      { id: 'stack/MyApi', name: 'MyApi', providerType: 'cloudformation', tags: {}, evidence: [], meta: { stackName: 'my-stack', logicalId: 'MyApi', physicalId: 'rest-1', resourceType: 'AWS::ApiGateway::RestApi' } },
      {}
    );
    expect(result.format).toBe('openapi-json');
    expect(JSON.parse(result.content)).toHaveProperty('openapi', '3.0.1');
  });

  it('extracts OpenAPI spec from local SAM DefinitionUri', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cfn-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'openapi.yaml'), 'openapi: 3.0.1\ninfo:\n  title: local\n  version: "1.0"\npaths: {}', 'utf8');
      const template = JSON.stringify({
        Resources: {
          MyApi: {
            Type: 'AWS::Serverless::Api',
            Properties: {
              DefinitionUri: './openapi.yaml'
            }
          }
        }
      });
      const client = createCfnClientStub({
        getTemplate: vi.fn().mockResolvedValue(template)
      });
      const provider = new CloudFormationProvider(client, tempDir);

      const result = await provider.exportSpec(
        { id: 'stack/MyApi', name: 'MyApi', providerType: 'cloudformation', tags: {}, evidence: [], meta: { stackName: 'my-stack', logicalId: 'MyApi', physicalId: 'rest-1', resourceType: 'AWS::Serverless::Api' } },
        {}
      );

      expect(result.content).toContain('openapi: 3.0.1');
      expect(result.format).toBe('openapi-yaml');
      expect(result.filename).toBe('index.yaml');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('extracts OpenAPI spec from S3 BodyS3Location when an S3 client is available', async () => {
    const template = JSON.stringify({
      Resources: {
        MyApi: {
          Type: 'AWS::ApiGateway::RestApi',
          Properties: {
            BodyS3Location: {
              Bucket: 'spec-bucket',
              Key: 'orders/openapi.json'
            }
          }
        }
      }
    });
    const client = createCfnClientStub({
      getTemplate: vi.fn().mockResolvedValue(template)
    });
    const s3Client = {
      getObject: vi.fn().mockResolvedValue('{"openapi":"3.0.1","info":{"title":"s3","version":"1.0"},"paths":{}}')
    };
    const provider = new CloudFormationProvider(client, '.', s3Client);

    const result = await provider.exportSpec(
      { id: 'stack/MyApi', name: 'MyApi', providerType: 'cloudformation', tags: {}, evidence: [], meta: { stackName: 'my-stack', logicalId: 'MyApi', physicalId: 'rest-1', resourceType: 'AWS::ApiGateway::RestApi' } },
      {}
    );

    expect(s3Client.getObject).toHaveBeenCalledWith('spec-bucket', 'orders/openapi.json', undefined);
    expect(JSON.parse(result.content)).toHaveProperty('openapi', '3.0.1');
  });

  it('throws when no embedded spec found', async () => {
    const template = JSON.stringify({
      Resources: {
        MyApi: {
          Type: 'AWS::ApiGateway::RestApi',
          Properties: { Name: 'no-body' }
        }
      }
    });
    const client = createCfnClientStub({
      getTemplate: vi.fn().mockResolvedValue(template)
    });
    const provider = new CloudFormationProvider(client);

    await expect(
      provider.exportSpec(
        { id: 'stack/MyApi', name: 'MyApi', providerType: 'cloudformation', tags: {}, evidence: [], meta: { stackName: 'my-stack', logicalId: 'MyApi', physicalId: 'rest-1', resourceType: 'AWS::ApiGateway::RestApi' } },
        {}
      )
    ).rejects.toThrow(/No embedded or referenced OpenAPI spec/);
  });
});

describe('GlueSchemaProvider', () => {
  it('lists schemas from registries', async () => {
    const client = createGlueClientStub({
      listRegistries: vi.fn().mockResolvedValue([{ name: 'my-registry', arn: 'arn:reg' }]),
      listSchemas: vi.fn().mockResolvedValue([{ name: 'UserEvent', arn: 'arn:schema', registryName: 'my-registry' }])
    });
    const provider = new GlueSchemaProvider(client);

    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.name).toBe('UserEvent');
  });

  it('exports Avro schema with correct format', async () => {
    const client = createGlueClientStub({
      getLatestSchemaVersion: vi.fn().mockResolvedValue({
        content: '{"type":"record","name":"UserEvent","fields":[]}',
        dataFormat: 'AVRO',
        versionNumber: 3
      })
    });
    const provider = new GlueSchemaProvider(client);

    const result = await provider.exportSpec(
      { id: 'reg/schema', name: 'UserEvent', providerType: 'glue', tags: {}, evidence: [], meta: { registryName: 'my-registry', schemaName: 'UserEvent', schemaArn: 'arn:schema' } },
      {}
    );
    expect(result.format).toBe('avro');
    expect(result.filename).toBe('schema.avsc');
    expect(result.content).toContain('UserEvent');
  });

  it('exports JSON Schema with correct format', async () => {
    const client = createGlueClientStub({
      getLatestSchemaVersion: vi.fn().mockResolvedValue({
        content: '{"$schema":"http://json-schema.org/draft-07/schema#"}',
        dataFormat: 'JSON',
        versionNumber: 1
      })
    });
    const provider = new GlueSchemaProvider(client);

    const result = await provider.exportSpec(
      { id: 'reg/schema', name: 'TestSchema', providerType: 'glue', tags: {}, evidence: [], meta: { registryName: 'reg', schemaName: 'TestSchema', schemaArn: 'arn:s' } },
      {}
    );
    expect(result.format).toBe('json-schema');
    expect(result.filename).toBe('schema.json');
  });

  it('exports Protobuf schema with correct format', async () => {
    const client = createGlueClientStub({
      getLatestSchemaVersion: vi.fn().mockResolvedValue({
        content: 'syntax = "proto3";',
        dataFormat: 'PROTOBUF',
        versionNumber: 1
      })
    });
    const provider = new GlueSchemaProvider(client);

    const result = await provider.exportSpec(
      { id: 'reg/schema', name: 'TestSchema', providerType: 'glue', tags: {}, evidence: [], meta: { registryName: 'reg', schemaName: 'TestSchema', schemaArn: 'arn:s' } },
      {}
    );
    expect(result.format).toBe('protobuf');
    expect(result.filename).toBe('schema.proto');
  });
});

describe('LambdaUrlProvider', () => {
  it('lists functions with configured Function URLs', async () => {
    const client = createLambdaClientStub({
      listFunctions: vi.fn().mockResolvedValue([
        { name: 'orders-fn', arn: 'arn:aws:lambda:us-east-1:123456789012:function:orders-fn', runtime: 'nodejs24.x' },
        { name: 'worker-fn', arn: 'arn:aws:lambda:us-east-1:123456789012:function:worker-fn', runtime: 'nodejs24.x' }
      ]),
      getFunctionUrlConfig: vi
        .fn()
        .mockResolvedValueOnce({
          functionArn: 'arn:aws:lambda:us-east-1:123456789012:function:orders-fn',
          functionUrl: 'https://abc.lambda-url.us-east-1.on.aws/',
          authType: 'NONE'
        })
        .mockResolvedValueOnce(undefined),
      getTags: vi.fn().mockResolvedValue({ Name: 'orders-api' })
    });
    const provider = new LambdaUrlProvider(client);

    const candidates = await provider.listCandidates();

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.providerType).toBe('lambda-url');
    expect(candidates[0]?.name).toBe('orders-fn');
    expect(candidates[0]?.meta.gatewayType).toBe('LAMBDA_URL');
  });

  it('synthesizes OpenAPI for Function URL candidates', async () => {
    const provider = new LambdaUrlProvider(createLambdaClientStub());

    const result = await provider.exportSpec(
      {
        id: 'orders-fn',
        name: 'orders-fn',
        providerType: 'lambda-url',
        tags: { Name: 'orders-api' },
        evidence: [],
        meta: {
          functionArn: 'arn:aws:lambda:us-east-1:123456789012:function:orders-fn',
          functionUrl: 'https://abc.lambda-url.us-east-1.on.aws/',
          authType: 'AWS_IAM'
        }
      },
      {}
    );

    expect(result.format).toBe('openapi-yaml');
    expect(result.filename).toBe('index.yaml');
    expect(result.content).toContain('x-aws-lambda-function-url-auth-type: "AWS_IAM"');
    expect(result.content).toContain('  /{proxy}:');
    expect(result.content).toContain('      - name: proxy');
  });
});

describe('SnsProvider', () => {
  it('probe delegates to SNS client', async () => {
    const client = createSnsClientStub({ probe: vi.fn().mockResolvedValue(true) });
    const provider = new SnsProvider(client);

    await expect(provider.probe()).resolves.toBe(true);
    expect(client.probe).toHaveBeenCalledTimes(1);
  });

  it('listCandidates uses postman:project-name tag when present and falls back to ARN-derived name', async () => {
    const taggedTopicArn = 'arn:aws:sns:us-east-1:123456789012:orders-topic';
    const untaggedTopicArn = 'arn:aws:sns:us-east-1:123456789012:billing-topic';
    const client = createSnsClientStub({
      listTopics: vi.fn().mockResolvedValue([
        { topicArn: taggedTopicArn, name: 'ignored-name' },
        { topicArn: untaggedTopicArn, name: 'ignored-name-too' }
      ]),
      getTopicAttributes: vi
        .fn()
        .mockResolvedValueOnce({ DisplayName: 'Orders Topic' })
        .mockResolvedValueOnce({ DisplayName: 'Billing Topic' }),
      listTagsForResource: vi
        .fn()
        .mockResolvedValueOnce({ 'postman:project-name': 'orders-service', team: 'platform' })
        .mockResolvedValueOnce({ team: 'platform' })
    });
    const provider = new SnsProvider(client);

    const candidates = await provider.listCandidates();

    expect(candidates).toEqual([
      {
        id: taggedTopicArn,
        name: 'orders-service',
        providerType: 'sns',
        tags: { 'postman:project-name': 'orders-service', team: 'platform' },
        evidence: [`SNS topic discovered: ${taggedTopicArn}`],
        meta: {
          topicArn: taggedTopicArn,
          arnDerivedTopicName: 'orders-topic',
          displayName: 'Orders Topic'
        }
      },
      {
        id: untaggedTopicArn,
        name: 'billing-topic',
        providerType: 'sns',
        tags: { team: 'platform' },
        evidence: [`SNS topic discovered: ${untaggedTopicArn}`],
        meta: {
          topicArn: untaggedTopicArn,
          arnDerivedTopicName: 'billing-topic',
          displayName: 'Billing Topic'
        }
      }
    ]);
  });

  it('listCandidates returns empty array when no topics are found', async () => {
    const client = createSnsClientStub({ listTopics: vi.fn().mockResolvedValue([]) });
    const provider = new SnsProvider(client);

    await expect(provider.listCandidates()).resolves.toEqual([]);
  });

  it('listCandidates handles FIFO topics and keeps .fifo suffix', async () => {
    const topicArn = 'arn:aws:sns:us-east-1:123456789012:billing-events.fifo';
    const client = createSnsClientStub({
      listTopics: vi.fn().mockResolvedValue([{ topicArn, name: 'ignored' }])
    });
    const provider = new SnsProvider(client);

    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.name).toBe('billing-events.fifo');
  });

  it('exportSpec resolves AsyncAPI YAML from repo-local asyncapi.yaml', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'asyncapi.yaml'),
        'asyncapi: 2.6.0\ninfo:\n  title: Orders Events\n  version: 1.0.0\nchannels: {}',
        'utf8'
      );
      const provider = new SnsProvider(createSnsClientStub(), tempDir);

      const result = await provider.exportSpec(createSnsCandidate(), {});

      expect(result.format).toBe('asyncapi-yaml');
      expect(result.filename).toBe('asyncapi.yaml');
      expect(result.content).toContain('asyncapi: 2.6.0');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('exportSpec resolves AsyncAPI JSON from repo-local asyncapi.json', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'asyncapi.json'),
        JSON.stringify({ asyncapi: '2.6.0', info: { title: 'Orders', version: '1.0.0' }, channels: {} }, null, 2),
        'utf8'
      );
      const provider = new SnsProvider(createSnsClientStub(), tempDir);

      const result = await provider.exportSpec(createSnsCandidate(), {});

      expect(result.format).toBe('asyncapi-json');
      expect(result.filename).toBe('asyncapi.json');
      expect(result.content).toContain('"asyncapi": "2.6.0"');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('exportSpec skips malformed AsyncAPI and falls through to JSON Schema', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'asyncapi.yaml'), 'info:\n  title: Missing asyncapi key', 'utf8');
      await writeFile(path.join(tempDir, 'schema.json'), '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}', 'utf8');
      const provider = new SnsProvider(createSnsClientStub(), tempDir);

      const result = await provider.exportSpec(createSnsCandidate(), {});

      expect(result.format).toBe('json-schema');
      expect(result.filename).toBe('schema.json');
      expect(result.evidence.some((line) => line.includes('Skipped malformed AsyncAPI file'))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('enforces precedence: AsyncAPI over JSON Schema and SSM', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'asyncapi.yaml'), 'asyncapi: "2.6.0"\ninfo:\n  title: Orders\n  version: "1.0.0"\nchannels: {}', 'utf8');
      await writeFile(path.join(tempDir, 'schema.json'), '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}', 'utf8');
      const ssmClient = createSsmClientStub({
        listSpecParameters: vi.fn().mockResolvedValue([
          { serviceName: 'orders-topic', key: 'content', value: '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}' }
        ])
      });
      const provider = new SnsProvider(createSnsClientStub(), tempDir, ssmClient);

      const result = await provider.exportSpec(createSnsCandidate(), {});

      expect(result.format).toBe('asyncapi-yaml');
      expect(ssmClient.listSpecParameters).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('enforces precedence: JSON Schema over SSM', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'schema.json'), '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}', 'utf8');
      const ssmClient = createSsmClientStub({
        listSpecParameters: vi.fn().mockResolvedValue([
          { serviceName: 'orders-topic', key: 'content', value: '{"asyncapi":"2.6.0","info":{"title":"from-ssm","version":"1.0.0"},"channels":{}}' }
        ])
      });
      const provider = new SnsProvider(createSnsClientStub(), tempDir, ssmClient);

      const result = await provider.exportSpec(createSnsCandidate(), {});

      expect(result.format).toBe('json-schema');
      expect(ssmClient.listSpecParameters).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('falls back to SSM when no repo-local contract exists', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const ssmClient = createSsmClientStub({
        listSpecParameters: vi.fn().mockResolvedValue([
          {
            serviceName: 'orders-topic',
            key: 'content',
            value: '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}'
          }
        ])
      });
      const provider = new SnsProvider(createSnsClientStub(), tempDir, ssmClient);

      const result = await provider.exportSpec(createSnsCandidate(), {});

      expect(result.format).toBe('json-schema');
      expect(result.filename).toBe('schema.json');
      expect(result.evidence.some((line) => line.includes('/postman/specs/orders-topic/'))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns manual-review result when no contract can be resolved', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const provider = new SnsProvider(createSnsClientStub(), tempDir, createSsmClientStub());

      const result = await provider.exportSpec(createSnsCandidate(), {});

      expect(result.filename).toBe('manual-review.json');
      expect(result.evidence.some((line) => line.includes('manual review'))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('enforces path sandboxing for unsafe topic names', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const provider = new SnsProvider(createSnsClientStub(), tempDir);

      await expect(
        provider.exportSpec(
          createSnsCandidate({
            id: 'arn:aws:sns:us-east-1:123456789012:../../escape',
            name: '../../escape',
            meta: { topicArn: 'arn:aws:sns:us-east-1:123456789012:../../escape' }
          }),
          {}
        )
      ).rejects.toThrow(/must stay within repo-root\/workspace/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract returns repo-asyncapi origin for yaml, yml, and json', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const yamlDir = path.join(tempDir, 'yaml');
      const ymlDir = path.join(tempDir, 'yml');
      const jsonDir = path.join(tempDir, 'json');
      await mkdir(yamlDir, { recursive: true });
      await mkdir(ymlDir, { recursive: true });
      await mkdir(jsonDir, { recursive: true });
      await writeFile(path.join(yamlDir, 'asyncapi.yaml'), 'asyncapi: 2.6.0\ninfo:\n  title: YAML\n  version: 1.0.0\nchannels: {}', 'utf8');
      await writeFile(path.join(ymlDir, 'asyncapi.yml'), 'asyncapi: 2.6.0\ninfo:\n  title: YML\n  version: 1.0.0\nchannels: {}', 'utf8');
      await writeFile(
        path.join(jsonDir, 'asyncapi.json'),
        JSON.stringify({ asyncapi: '2.6.0', info: { title: 'JSON', version: '1.0.0' }, channels: {} }),
        'utf8'
      );

      const yamlProvider = new SnsProvider(createSnsClientStub(), yamlDir);
      const ymlProvider = new SnsProvider(createSnsClientStub(), ymlDir);
      const jsonProvider = new SnsProvider(createSnsClientStub(), jsonDir);

      const yamlResult = await yamlProvider.resolveContract(createSnsCandidate());
      const ymlResult = await ymlProvider.resolveContract(createSnsCandidate());
      const jsonResult = await jsonProvider.resolveContract(createSnsCandidate());

      expect(yamlResult).toMatchObject({ resolved: true, origin: 'repo-asyncapi' });
      expect(ymlResult).toMatchObject({ resolved: true, origin: 'repo-asyncapi' });
      expect(jsonResult).toMatchObject({ resolved: true, origin: 'repo-asyncapi' });
      if (yamlResult.resolved) expect(yamlResult.result.format).toBe('asyncapi-yaml');
      if (ymlResult.resolved) expect(ymlResult.result.format).toBe('asyncapi-yaml');
      if (jsonResult.resolved) expect(jsonResult.result.format).toBe('asyncapi-json');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract returns repo-json-schema origin', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'events.schema.json'), '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}', 'utf8');
      const provider = new SnsProvider(createSnsClientStub(), tempDir);

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toMatchObject({ resolved: true, origin: 'repo-json-schema' });
      if (result.resolved) {
        expect(result.result.format).toBe('json-schema');
        expect(result.result.filename).toBe('events.schema.json');
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract returns generated-asyncapi origin from spec, contracts, and events directories', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const specDir = path.join(tempDir, 'spec');
      const contractsDir = path.join(tempDir, 'contracts');
      const eventsDir = path.join(tempDir, 'events', 'orders-topic');
      await mkdir(specDir, { recursive: true });
      await mkdir(contractsDir, { recursive: true });
      await mkdir(eventsDir, { recursive: true });

      const specFile = path.join(specDir, 'orders-topic.asyncapi.yaml');
      const contractsFile = path.join(contractsDir, 'billing.asyncapi.json');
      const eventsFile = path.join(eventsDir, 'asyncapi.yml');

      await writeFile(specFile, 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      const specProvider = new SnsProvider(createSnsClientStub(), tempDir);
      const specResult = await specProvider.resolveContract(createSnsCandidate());
      expect(specResult).toMatchObject({ resolved: true, origin: 'generated-asyncapi' });
      if (specResult.resolved) {
        expect(specResult.result.format).toBe('asyncapi-yaml');
        expect(specResult.result.filename).toBe('orders-topic.asyncapi.yaml');
      }

      await rm(specFile);
      await writeFile(contractsFile, '{"asyncapi":"2.6.0","channels":{}}', 'utf8');
      const contractsProvider = new SnsProvider(createSnsClientStub(), tempDir);
      const contractsResult = await contractsProvider.resolveContract(createSnsCandidate());
      expect(contractsResult).toMatchObject({ resolved: true, origin: 'generated-asyncapi' });
      if (contractsResult.resolved) {
        expect(contractsResult.result.format).toBe('asyncapi-json');
        expect(contractsResult.result.filename).toBe('billing.asyncapi.json');
      }

      await rm(contractsFile);
      await writeFile(eventsFile, 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      const eventsProvider = new SnsProvider(createSnsClientStub(), tempDir);
      const eventsResult = await eventsProvider.resolveContract(createSnsCandidate());
      expect(eventsResult).toMatchObject({ resolved: true, origin: 'generated-asyncapi' });
      if (eventsResult.resolved) {
        expect(eventsResult.result.format).toBe('asyncapi-yaml');
        expect(eventsResult.result.filename).toBe('asyncapi.yml');
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract matches generated AsyncAPI extensions and rejects invalid asyncapi files', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await mkdir(path.join(tempDir, 'spec'), { recursive: true });
      await writeFile(path.join(tempDir, 'spec', 'invalid.asyncapi.yaml'), 'openapi: 3.0.0', 'utf8');
      await writeFile(path.join(tempDir, 'spec', 'invalid.asyncapi.yml'), '{"openapi":"3.0.0"}', 'utf8');
      await writeFile(path.join(tempDir, 'spec', 'payment.asyncapi.json'), '{"asyncapi":"2.6.0","channels":{}}', 'utf8');
      const provider = new SnsProvider(createSnsClientStub(), tempDir);

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toMatchObject({ resolved: true, origin: 'generated-asyncapi' });
      if (result.resolved) {
        expect(result.result.format).toBe('asyncapi-json');
        expect(result.result.filename).toBe('payment.asyncapi.json');
      }
      expect(result.evidence.some((line) => line.includes('invalid.asyncapi.yaml'))).toBe(true);
      expect(result.evidence.some((line) => line.includes('invalid.asyncapi.yml'))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract ranks generated AsyncAPI by topic-name affinity', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await mkdir(path.join(tempDir, 'spec'), { recursive: true });
      await writeFile(path.join(tempDir, 'spec', 'billing.asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      await writeFile(path.join(tempDir, 'spec', 'orders-topic.asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      const provider = new SnsProvider(createSnsClientStub(), tempDir);

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toMatchObject({ resolved: true, origin: 'generated-asyncapi' });
      if (result.resolved) {
        expect(result.result.filename).toBe('orders-topic.asyncapi.yaml');
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract keeps precedence: repo-local AsyncAPI and JSON Schema outrank generated AsyncAPI', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await mkdir(path.join(tempDir, 'spec'), { recursive: true });
      await writeFile(path.join(tempDir, 'spec', 'orders-topic.asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      await writeFile(path.join(tempDir, 'asyncapi.yaml'), 'asyncapi: 2.6.0\ninfo:\n  title: Repo\nchannels: {}', 'utf8');
      await writeFile(path.join(tempDir, 'schema.json'), '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}', 'utf8');

      const asyncApiProvider = new SnsProvider(createSnsClientStub(), tempDir);
      const asyncApiResult = await asyncApiProvider.resolveContract(createSnsCandidate());
      expect(asyncApiResult).toMatchObject({ resolved: true, origin: 'repo-asyncapi' });

      await rm(path.join(tempDir, 'asyncapi.yaml'));
      const schemaProvider = new SnsProvider(createSnsClientStub(), tempDir);
      const schemaResult = await schemaProvider.resolveContract(createSnsCandidate());
      expect(schemaResult).toMatchObject({ resolved: true, origin: 'repo-json-schema' });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract keeps precedence: generated AsyncAPI outranks SSM content', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await mkdir(path.join(tempDir, 'spec'), { recursive: true });
      await writeFile(path.join(tempDir, 'spec', 'orders-topic.asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      const ssmClient = createSsmClientStub({
        listSpecParameters: vi.fn().mockResolvedValue([
          { serviceName: 'orders-topic', key: 'content', value: '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}' }
        ])
      });
      const provider = new SnsProvider(createSnsClientStub(), tempDir, ssmClient);

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toMatchObject({ resolved: true, origin: 'generated-asyncapi' });
      expect(ssmClient.listSpecParameters).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract discovers generated AsyncAPI in repo-tracked framework output directories', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await mkdir(path.join(tempDir, 'build', 'generated'), { recursive: true });
      await writeFile(path.join(tempDir, 'build', 'generated', 'orders.asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      let provider = new SnsProvider(createSnsClientStub(), tempDir);
      let result = await provider.resolveContract(createSnsCandidate());
      expect(result).toMatchObject({ resolved: true, origin: 'generated-asyncapi' });

      await rm(path.join(tempDir, 'build'), { recursive: true, force: true });
      await mkdir(path.join(tempDir, '.build', 'generated'), { recursive: true });
      await writeFile(path.join(tempDir, '.build', 'generated', 'orders.asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      provider = new SnsProvider(createSnsClientStub(), tempDir);
      result = await provider.resolveContract(createSnsCandidate());
      expect(result).toMatchObject({ resolved: true, origin: 'generated-asyncapi' });

      await rm(path.join(tempDir, '.build'), { recursive: true, force: true });
      await mkdir(path.join(tempDir, 'out', 'generated'), { recursive: true });
      await writeFile(path.join(tempDir, 'out', 'generated', 'orders.asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      provider = new SnsProvider(createSnsClientStub(), tempDir);
      result = await provider.resolveContract(createSnsCandidate());
      expect(result).toMatchObject({ resolved: true, origin: 'generated-asyncapi' });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract excludes generated AsyncAPI files in gitignored output directories', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, '.gitignore'), 'build/\nout/\n', 'utf8');
      await mkdir(path.join(tempDir, 'build', 'generated'), { recursive: true });
      await writeFile(path.join(tempDir, 'build', 'generated', 'orders.asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      await mkdir(path.join(tempDir, 'spec'), { recursive: true });
      await writeFile(path.join(tempDir, 'spec', 'ignored.asyncapi.yaml'), 'openapi: 3.0.0', 'utf8');
      const provider = new SnsProvider(createSnsClientStub(), tempDir, undefined, {
        gitIgnoreChecker: vi.fn().mockResolvedValue(true)
      });

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toEqual(expect.objectContaining({ resolved: false }));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract allows git-tracked generated AsyncAPI in ignored framework directories', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      childProcess.execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
      childProcess.execFileSync('git', ['config', 'user.name', 'test-user'], { cwd: tempDir, stdio: 'ignore' });
      childProcess.execFileSync('git', ['config', 'user.email', 'test-user@example.com'], { cwd: tempDir, stdio: 'ignore' });
      await mkdir(path.join(tempDir, 'build', 'generated'), { recursive: true });
      await writeFile(path.join(tempDir, 'build', 'generated', 'orders.asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      childProcess.execFileSync('git', ['add', '--', 'build/generated/orders.asyncapi.yaml'], { cwd: tempDir, stdio: 'ignore' });
      childProcess.execFileSync('git', ['commit', '-m', 'track generated asyncapi fixture'], { cwd: tempDir, stdio: 'ignore' });
      await writeFile(path.join(tempDir, '.gitignore'), 'build/\n', 'utf8');

      const provider = new SnsProvider(createSnsClientStub(), tempDir);
      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toMatchObject({ resolved: true, origin: 'generated-asyncapi' });
      if (result.resolved) {
        expect(result.result.filename).toBe('orders.asyncapi.yaml');
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract uses git check-ignore for framework output directories', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await mkdir(path.join(tempDir, 'build', 'generated'), { recursive: true });
      await writeFile(path.join(tempDir, 'build', 'generated', 'orders.asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      await mkdir(path.join(tempDir, 'spec'), { recursive: true });
      await writeFile(path.join(tempDir, 'spec', 'orders-topic.asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      const gitIgnoreChecker = vi.fn().mockResolvedValue(false);

      const provider = new SnsProvider(createSnsClientStub(), tempDir, undefined, { gitIgnoreChecker });
      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toMatchObject({ resolved: true, origin: 'generated-asyncapi' });
      expect(gitIgnoreChecker).toHaveBeenCalledTimes(1);
      expect(gitIgnoreChecker).toHaveBeenCalledWith(tempDir, path.join(tempDir, 'build', 'generated', 'orders.asyncapi.yaml'));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract returns ssm-content origin for explicit and auto-detected formats', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const explicit = new SnsProvider(
        createSnsClientStub(),
        tempDir,
        createSsmClientStub({
          listSpecParameters: vi.fn().mockResolvedValue([
            { serviceName: 'orders-topic', key: 'content', value: '{"asyncapi":"2.6.0","channels":{}}' },
            { serviceName: 'orders-topic', key: 'format', value: 'asyncapi-json' }
          ])
        })
      );
      const explicitSchema = new SnsProvider(
        createSnsClientStub(),
        tempDir,
        createSsmClientStub({
          listSpecParameters: vi.fn().mockResolvedValue([
            { serviceName: 'orders-topic', key: 'content', value: '{"type":"object","properties":{}}' },
            { serviceName: 'orders-topic', key: 'format', value: 'json-schema' }
          ])
        })
      );
      const auto = new SnsProvider(
        createSnsClientStub(),
        tempDir,
        createSsmClientStub({
          listSpecParameters: vi.fn().mockResolvedValue([
            { serviceName: 'orders-topic', key: 'content', value: 'asyncapi: 2.6.0\nchannels: {}' }
          ])
        })
      );

      const explicitResult = await explicit.resolveContract(createSnsCandidate());
      const explicitSchemaResult = await explicitSchema.resolveContract(createSnsCandidate());
      const autoResult = await auto.resolveContract(createSnsCandidate());

      expect(explicitResult).toMatchObject({ resolved: true, origin: 'ssm-content' });
      expect(explicitSchemaResult).toMatchObject({ resolved: true, origin: 'ssm-content' });
      expect(autoResult).toMatchObject({ resolved: true, origin: 'ssm-content' });
      if (explicitResult.resolved) expect(explicitResult.result.format).toBe('asyncapi-json');
      if (explicitSchemaResult.resolved) expect(explicitSchemaResult.result.format).toBe('json-schema');
      if (autoResult.resolved) expect(autoResult.result.format).toBe('asyncapi-yaml');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract enforces precedence and falls through malformed files with evidence', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'asyncapi.yaml'), 'not: asyncapi', 'utf8');
      await writeFile(path.join(tempDir, 'schema.json'), '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}', 'utf8');
      const ssmClient = createSsmClientStub({
        listSpecParameters: vi.fn().mockResolvedValue([
          { serviceName: 'orders-topic', key: 'content', value: '{"asyncapi":"2.6.0","channels":{}}' }
        ])
      });
      const provider = new SnsProvider(createSnsClientStub(), tempDir, ssmClient);

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toMatchObject({ resolved: true, origin: 'repo-json-schema' });
      expect(ssmClient.listSpecParameters).not.toHaveBeenCalled();
      if (result.resolved) {
        expect(result.evidence.some((line) => line.includes('Skipped malformed AsyncAPI file'))).toBe(true);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract falls through malformed AsyncAPI and malformed JSON Schema to SSM', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'asyncapi.yaml'), 'asyncapi: [', 'utf8');
      await writeFile(path.join(tempDir, 'schema.json'), '{"type":', 'utf8');
      const provider = new SnsProvider(
        createSnsClientStub(),
        tempDir,
        createSsmClientStub({
          listSpecParameters: vi.fn().mockResolvedValue([
            { serviceName: 'orders-topic', key: 'content', value: '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}' }
          ])
        })
      );

      const result = await provider.resolveContract(createSnsCandidate());
      expect(result).toMatchObject({ resolved: true, origin: 'ssm-content' });
      expect(result.evidence.some((line) => line.includes('Skipped malformed AsyncAPI file'))).toBe(true);
      expect(result.evidence.some((line) => line.includes('Skipped malformed JSON Schema file'))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract returns unresolved for no sources, url-only SSM, and missing SSM client', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const withoutSsm = new SnsProvider(createSnsClientStub(), tempDir);
      const urlOnly = new SnsProvider(
        createSnsClientStub(),
        tempDir,
        createSsmClientStub({
          listSpecParameters: vi.fn().mockResolvedValue([
            { serviceName: 'orders-topic', key: 'url', value: 'https://example.com/asyncapi.yaml' }
          ])
        })
      );

      const withoutSsmResult = await withoutSsm.resolveContract(createSnsCandidate());
      const urlOnlyResult = await urlOnly.resolveContract(createSnsCandidate());

      expect(withoutSsmResult).toEqual(expect.objectContaining({ resolved: false }));
      expect(urlOnlyResult).toEqual(expect.objectContaining({ resolved: false }));
      expect(urlOnlyResult.evidence.some((line) => line.includes('manual review'))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract keeps SSM inline content precedence over url and spec-url', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const fetchMock = vi.fn();
      const provider = new SnsProvider(
        createSnsClientStub(),
        tempDir,
        createSsmClientStub({
          listSpecParameters: vi.fn().mockResolvedValue([
            { serviceName: 'orders-topic', key: 'content', value: '{"asyncapi":"2.6.0","channels":{}}' },
            { serviceName: 'orders-topic', key: 'url', value: 'https://example.com/contract.yaml' },
            { serviceName: 'orders-topic', key: 'spec-url', value: 'https://example.com/contract.json' }
          ])
        }),
        fetchMock as unknown as typeof import('../src/lib/fetch/spec-fetcher.js').fetchSpecFromUrl
      );

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toMatchObject({ resolved: true, origin: 'ssm-content' });
      expect(fetchMock).not.toHaveBeenCalled();
      if (result.resolved) {
        expect(result.result.content).toContain('"asyncapi":"2.6.0"');
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract fetches SSM url/spec-url and detects asyncapi and json-schema formats', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const urlFetcher = vi
        .fn()
        .mockResolvedValueOnce({ content: 'asyncapi: 2.6.0\nchannels: {}', contentType: 'application/yaml' })
        .mockResolvedValueOnce({ content: '{"asyncapi":"2.6.0","channels":{}}', contentType: 'application/json' })
        .mockResolvedValueOnce({ content: '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}', contentType: 'application/json' });

      const urlProvider = new SnsProvider(
        createSnsClientStub(),
        tempDir,
        createSsmClientStub({
          listSpecParameters: vi.fn().mockResolvedValue([
            { serviceName: 'orders-topic', key: 'url', value: 'https://example.com/orders.asyncapi.yaml' }
          ])
        }),
        urlFetcher as unknown as typeof import('../src/lib/fetch/spec-fetcher.js').fetchSpecFromUrl
      );
      const specUrlProvider = new SnsProvider(
        createSnsClientStub(),
        tempDir,
        createSsmClientStub({
          listSpecParameters: vi.fn().mockResolvedValue([
            { serviceName: 'orders-topic', key: 'spec-url', value: 'https://example.com/orders.asyncapi.json' }
          ])
        }),
        urlFetcher as unknown as typeof import('../src/lib/fetch/spec-fetcher.js').fetchSpecFromUrl
      );
      const jsonSchemaProvider = new SnsProvider(
        createSnsClientStub(),
        tempDir,
        createSsmClientStub({
          listSpecParameters: vi.fn().mockResolvedValue([
            { serviceName: 'orders-topic', key: 'url', value: 'https://example.com/orders.schema.json' }
          ])
        }),
        urlFetcher as unknown as typeof import('../src/lib/fetch/spec-fetcher.js').fetchSpecFromUrl
      );

      const urlResult = await urlProvider.resolveContract(createSnsCandidate());
      const specUrlResult = await specUrlProvider.resolveContract(createSnsCandidate());
      const jsonSchemaResult = await jsonSchemaProvider.resolveContract(createSnsCandidate());

      expect(urlResult).toMatchObject({ resolved: true, origin: 'ssm-url' });
      expect(specUrlResult).toMatchObject({ resolved: true, origin: 'ssm-url' });
      expect(jsonSchemaResult).toMatchObject({ resolved: true, origin: 'ssm-url' });
      if (urlResult.resolved) expect(urlResult.result.format).toBe('asyncapi-yaml');
      if (specUrlResult.resolved) expect(specUrlResult.result.format).toBe('asyncapi-json');
      if (jsonSchemaResult.resolved) expect(jsonSchemaResult.result.format).toBe('json-schema');
      expect(urlFetcher).toHaveBeenNthCalledWith(1, 'https://example.com/orders.asyncapi.yaml', { timeoutMs: 15000 });
      expect(urlFetcher).toHaveBeenNthCalledWith(2, 'https://example.com/orders.asyncapi.json', { timeoutMs: 15000 });
      expect(urlFetcher).toHaveBeenNthCalledWith(3, 'https://example.com/orders.schema.json', { timeoutMs: 15000 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract records pointer-style evidence when SSM URL fetch fails', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const provider = new SnsProvider(
        createSnsClientStub(),
        tempDir,
        createSsmClientStub({
          listSpecParameters: vi.fn().mockResolvedValue([
            { serviceName: 'orders-topic', key: 'url', value: 'https://example.com/orders.asyncapi.yaml' }
          ])
        }),
        vi.fn().mockRejectedValue(new Error('HTTP 503 fetching https://example.com/orders.asyncapi.yaml')) as unknown as typeof import('../src/lib/fetch/spec-fetcher.js').fetchSpecFromUrl
      );

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toEqual(expect.objectContaining({ resolved: false }));
      expect(result.evidence.some((line) => line.includes('spec-pointer.json'))).toBe(true);
      expect(result.evidence.some((line) => line.includes('"specUrl": "https://example.com/orders.asyncapi.yaml"'))).toBe(true);
      expect(result.evidence.some((line) => line.includes('"fetchError": "HTTP 503 fetching https://example.com/orders.asyncapi.yaml"'))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('exportSpec emits spec-pointer.json sidecar when SSM URL fetch fails', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const provider = new SnsProvider(
        createSnsClientStub(),
        tempDir,
        createSsmClientStub({
          listSpecParameters: vi.fn().mockResolvedValue([
            { serviceName: 'orders-topic', key: 'url', value: 'https://example.com/orders.asyncapi.yaml' }
          ])
        }),
        vi.fn().mockRejectedValue(new Error('HTTP 503 fetching https://example.com/orders.asyncapi.yaml')) as never
      );

      const result = await provider.exportSpec(createSnsCandidate(), {});
      const pointer = result.sidecars?.find((entry) => entry.filename === 'spec-pointer.json');

      expect(result.filename).toBe('manual-review.json');
      expect(pointer).toBeDefined();
      expect(pointer?.content).toContain('"specUrl": "https://example.com/orders.asyncapi.yaml"');
      expect(pointer?.content).toContain('"fetchError": "HTTP 503 fetching https://example.com/orders.asyncapi.yaml"');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract records HTTPS enforcement errors for HTTP SSM URLs', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const provider = new SnsProvider(
        createSnsClientStub(),
        tempDir,
        createSsmClientStub({
          listSpecParameters: vi.fn().mockResolvedValue([
            { serviceName: 'orders-topic', key: 'url', value: 'http://example.com/orders.asyncapi.yaml' }
          ])
        })
      );

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toEqual(expect.objectContaining({ resolved: false }));
      expect(result.evidence.some((line) => line.includes('Only HTTPS URLs are supported'))).toBe(true);
      expect(result.evidence.some((line) => line.includes('"specUrl": "http://example.com/orders.asyncapi.yaml"'))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract falls through when fetched SSM URL content is unsupported format', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const provider = new SnsProvider(
        createSnsClientStub(),
        tempDir,
        createSsmClientStub({
          listSpecParameters: vi.fn().mockResolvedValue([
            { serviceName: 'orders-topic', key: 'url', value: 'https://example.com/openapi.yaml' }
          ])
        }),
        vi.fn().mockResolvedValue({
          content: 'openapi: 3.1.0\ninfo:\n  title: Orders API\n  version: "1.0.0"\npaths: {}',
          contentType: 'application/yaml'
        }) as unknown as typeof import('../src/lib/fetch/spec-fetcher.js').fetchSpecFromUrl
      );

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toEqual(expect.objectContaining({ resolved: false }));
      expect(result.evidence.some((line) => line.includes('unsupported format'))).toBe(true);
      expect(result.evidence.some((line) => line.includes('manual review'))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract resolves Backstage catalog URL with topic affinity as catalog-url origin', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'catalog-info.yaml'),
        [
          'apiVersion: backstage.io/v1alpha1',
          'kind: API',
          'metadata:',
          '  name: orders-api',
          'spec:',
          '  definition: https://example.com/orders.asyncapi.yaml'
        ].join('\n'),
        'utf8'
      );
      const fetchMock = vi.fn().mockResolvedValue({
        content: 'asyncapi: 2.6.0\nchannels: {}',
        contentType: 'application/yaml'
      });
      const provider = new SnsProvider(createSnsClientStub(), tempDir, createSsmClientStub(), fetchMock as never);

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toMatchObject({ resolved: true, origin: 'catalog-url' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith('https://example.com/orders.asyncapi.yaml', { timeoutMs: 15000 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract resolves repo-tracked contract registry URL mapping as catalog-url origin', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await mkdir(path.join(tempDir, '.postman'), { recursive: true });
      await writeFile(
        path.join(tempDir, '.postman', 'contracts.yaml'),
        ['contracts:', '  orders-topic:', '    url: https://example.com/orders.registry.asyncapi.yaml'].join('\n'),
        'utf8'
      );
      const fetchMock = vi.fn().mockResolvedValue({
        content: '{"asyncapi":"2.6.0","channels":{}}',
        contentType: 'application/json'
      });
      const provider = new SnsProvider(createSnsClientStub(), tempDir, createSsmClientStub(), fetchMock as never);

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toMatchObject({ resolved: true, origin: 'catalog-url' });
      if (result.resolved) {
        expect(result.result.format).toBe('asyncapi-json');
      }
      expect(fetchMock).toHaveBeenCalledWith('https://example.com/orders.registry.asyncapi.yaml', { timeoutMs: 15000 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract records catalog URL fetch failure evidence and falls through to manual-review', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'catalog-info.yaml'),
        [
          'apiVersion: backstage.io/v1alpha1',
          'kind: API',
          'metadata:',
          '  name: orders-api',
          'spec:',
          '  definition: https://example.com/orders.asyncapi.yaml'
        ].join('\n'),
        'utf8'
      );
      const fetchMock = vi.fn().mockRejectedValue(new Error('HTTP 503 fetching https://example.com/orders.asyncapi.yaml'));
      const provider = new SnsProvider(createSnsClientStub(), tempDir, createSsmClientStub(), fetchMock as never);

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toEqual(expect.objectContaining({ resolved: false }));
      expect(result.evidence.some((line) => line.includes('Backstage catalog API'))).toBe(true);
      expect(result.evidence.some((line) => line.includes('HTTP 503'))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract keeps precedence: SSM content and generated AsyncAPI outrank catalog URLs', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'catalog-info.yaml'),
        [
          'apiVersion: backstage.io/v1alpha1',
          'kind: API',
          'metadata:',
          '  name: orders-api',
          'spec:',
          '  definition: https://example.com/orders.asyncapi.yaml'
        ].join('\n'),
        'utf8'
      );
      await mkdir(path.join(tempDir, 'spec'), { recursive: true });
      await writeFile(path.join(tempDir, 'spec', 'orders-topic.asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      const generatedProvider = new SnsProvider(
        createSnsClientStub(),
        tempDir,
        createSsmClientStub({
          listSpecParameters: vi.fn().mockResolvedValue([
            { serviceName: 'orders-topic', key: 'content', value: '{"asyncapi":"2.6.0","channels":{}}' }
          ])
        }),
        vi.fn().mockResolvedValue({ content: 'asyncapi: 2.6.0\nchannels: {}', contentType: 'application/yaml' }) as never
      );

      const generatedResult = await generatedProvider.resolveContract(createSnsCandidate());
      expect(generatedResult).toMatchObject({ resolved: true, origin: 'generated-asyncapi' });

      await rm(path.join(tempDir, 'spec'), { recursive: true, force: true });
      const ssmProvider = new SnsProvider(
        createSnsClientStub(),
        tempDir,
        createSsmClientStub({
          listSpecParameters: vi.fn().mockResolvedValue([
            { serviceName: 'orders-topic', key: 'content', value: '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}' }
          ])
        }),
        vi.fn().mockResolvedValue({ content: 'asyncapi: 2.6.0\nchannels: {}', contentType: 'application/yaml' }) as never
      );

      const ssmResult = await ssmProvider.resolveContract(createSnsCandidate());
      expect(ssmResult).toMatchObject({ resolved: true, origin: 'ssm-content' });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract enforces deterministic 9-level precedence waterfall from highest to lowest', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const ssmState: { content?: string; url?: string } = {};
      const eventBridgeState = { enabled: true };
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes('ssm')) {
          return { content: '{"asyncapi":"2.6.0","channels":{}}', contentType: 'application/json' };
        }
        if (url.includes('catalog')) {
          return { content: '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}', contentType: 'application/json' };
        }
        throw new Error(`unexpected url ${url}`);
      });
      const listSpecParametersMock = vi.fn().mockImplementation(async () => {
        const entries: Array<{ serviceName: string; key: string; value: string }> = [];
        if (ssmState.content) {
          entries.push({ serviceName: 'orders-topic', key: 'content', value: ssmState.content });
        }
        if (ssmState.url) {
          entries.push({ serviceName: 'orders-topic', key: 'url', value: ssmState.url });
        }
        return entries;
      });
      const listRegistriesMock = vi.fn().mockImplementation(async () => (eventBridgeState.enabled ? [{ name: 'custom-registry', arn: 'arn:registry' }] : []));
      const listSchemasMock = vi.fn().mockResolvedValue([{ name: 'orders-topic-events', arn: 'arn:schema', registryName: 'custom-registry', versionCount: 1 }]);
      const describeSchemaMock = vi.fn().mockResolvedValue({
        content: JSON.stringify({
          type: 'object',
          properties: { Message: { type: 'string' }, MessageId: { type: 'string' }, TopicArn: { type: 'string' }, Type: { type: 'string' } }
        }),
        schemaVersion: '1'
      });
      const codeDerivedMock = vi.fn(resolveCodeDerivedContract);
      const provider = new SnsProvider(
        createSnsClientStub(),
        tempDir,
        createSsmClientStub({
          listSpecParameters: listSpecParametersMock
        }),
        {
          fetchSpecFromUrl: fetchMock as never,
          eventBridgeClient: createSchemasClientStub({
            listRegistries: listRegistriesMock,
            listSchemas: listSchemasMock,
            describeSchema: describeSchemaMock
          }),
          codeDerivedResolver: codeDerivedMock
        }
      );

      const resolveOrigin = async (): Promise<string> => {
        const result = await provider.resolveContract(createSnsCandidate(), {
          bridgeEvidence: ['Detected SNS/EventBridge bridge pattern in template.yaml']
        });
        return result.resolved ? result.origin : 'manual-review';
      };

      await mkdir(path.join(tempDir, 'spec'), { recursive: true });
      await mkdir(path.join(tempDir, 'schemas'), { recursive: true });
      await writeFile(path.join(tempDir, 'asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      await writeFile(path.join(tempDir, 'schema.json'), '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}', 'utf8');
      await writeFile(path.join(tempDir, 'spec', 'orders-topic.asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      await writeFile(
        path.join(tempDir, 'publisher.ts'),
        [
          "import payloadSchema from './schemas/order-payload.json';",
          "const topicArn = 'arn:aws:sns:us-east-1:123456789012:orders-topic';",
          'await sns.send(new PublishCommand({ TopicArn: topicArn, Message: JSON.stringify(payloadSchema) }));'
        ].join('\n'),
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'schemas', 'order-payload.json'),
        JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' }, null, 2),
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'catalog-info.yaml'),
        ['apiVersion: backstage.io/v1alpha1', 'kind: API', 'metadata:', '  name: orders-api', 'spec:', '  definition: https://example.com/catalog.asyncapi.json'].join('\n'),
        'utf8'
      );
      ssmState.content = '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}';
      ssmState.url = 'https://example.com/ssm.asyncapi.json';

      expect(await resolveOrigin()).toBe('repo-asyncapi');
      expect(listSpecParametersMock).toHaveBeenCalledTimes(0);
      expect(fetchMock).toHaveBeenCalledTimes(0);
      expect(listRegistriesMock).toHaveBeenCalledTimes(0);
      expect(codeDerivedMock).toHaveBeenCalledTimes(0);

      await rm(path.join(tempDir, 'asyncapi.yaml'), { force: true });
      expect(await resolveOrigin()).toBe('repo-json-schema');
      expect(listSpecParametersMock).toHaveBeenCalledTimes(0);
      expect(fetchMock).toHaveBeenCalledTimes(0);
      expect(listRegistriesMock).toHaveBeenCalledTimes(0);
      expect(codeDerivedMock).toHaveBeenCalledTimes(0);

      await rm(path.join(tempDir, 'schema.json'), { force: true });
      expect(await resolveOrigin()).toBe('generated-asyncapi');
      expect(listSpecParametersMock).toHaveBeenCalledTimes(0);
      expect(fetchMock).toHaveBeenCalledTimes(0);
      expect(listRegistriesMock).toHaveBeenCalledTimes(0);
      expect(codeDerivedMock).toHaveBeenCalledTimes(0);

      await rm(path.join(tempDir, 'spec'), { recursive: true, force: true });
      expect(await resolveOrigin()).toBe('ssm-content');
      expect(listSpecParametersMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(0);
      expect(listRegistriesMock).toHaveBeenCalledTimes(0);
      expect(codeDerivedMock).toHaveBeenCalledTimes(0);

      ssmState.content = undefined;
      expect(await resolveOrigin()).toBe('ssm-url');
      expect(fetchMock).toHaveBeenCalledWith('https://example.com/ssm.asyncapi.json', { timeoutMs: 15000 });
      expect(listRegistriesMock).toHaveBeenCalledTimes(0);
      expect(codeDerivedMock).toHaveBeenCalledTimes(0);

      ssmState.url = undefined;
      expect(await resolveOrigin()).toBe('catalog-url');
      expect(fetchMock).toHaveBeenCalledWith('https://example.com/catalog.asyncapi.json', { timeoutMs: 15000 });
      expect(listRegistriesMock).toHaveBeenCalledTimes(0);
      expect(codeDerivedMock).toHaveBeenCalledTimes(0);

      await rm(path.join(tempDir, 'catalog-info.yaml'), { force: true });
      expect(await resolveOrigin()).toBe('eventbridge-derived');
      expect(listRegistriesMock).toHaveBeenCalledTimes(1);
      expect(listSchemasMock).toHaveBeenCalledTimes(1);
      expect(describeSchemaMock).toHaveBeenCalledTimes(1);
      expect(codeDerivedMock).toHaveBeenCalledTimes(0);

      eventBridgeState.enabled = false;
      expect(await resolveOrigin()).toBe('code-derived');
      expect(listRegistriesMock).toHaveBeenCalledTimes(2);
      expect(codeDerivedMock).toHaveBeenCalledTimes(1);

      await rm(path.join(tempDir, 'publisher.ts'), { force: true });
      await rm(path.join(tempDir, 'schemas'), { recursive: true, force: true });
      expect(await resolveOrigin()).toBe('manual-review');
      expect(listRegistriesMock).toHaveBeenCalledTimes(3);
      expect(codeDerivedMock).toHaveBeenCalledTimes(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    { higher: 'repo-asyncapi', lower: 'repo-json-schema' },
    { higher: 'repo-json-schema', lower: 'generated-asyncapi' },
    { higher: 'generated-asyncapi', lower: 'ssm-content' },
    { higher: 'ssm-content', lower: 'ssm-url' },
    { higher: 'ssm-url', lower: 'catalog-url' },
    { higher: 'catalog-url', lower: 'eventbridge-derived' },
    { higher: 'eventbridge-derived', lower: 'code-derived' },
    { higher: 'code-derived', lower: 'manual-review' }
  ])('resolveContract prefers $higher over adjacent lower-precedence $lower', async ({ higher, lower }) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-transition-'));
    try {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes('ssm')) {
          return { content: '{"asyncapi":"2.6.0","channels":{}}', contentType: 'application/json' };
        }
        if (url.includes('catalog')) {
          return { content: '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}', contentType: 'application/json' };
        }
        throw new Error(`unexpected url ${url}`);
      });
      const ssmEntries: Array<{ serviceName: string; key: string; value: string }> = [];
      const listSpecParametersMock = vi.fn().mockImplementation(async () => ssmEntries);
      const eventBridgeClient = createSchemasClientStub({
        listRegistries: vi.fn().mockResolvedValue([{ name: 'custom-registry', arn: 'arn:registry' }]),
        listSchemas: vi.fn().mockResolvedValue([{ name: 'orders-topic-events', arn: 'arn:schema', registryName: 'custom-registry', versionCount: 1 }]),
        describeSchema: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            type: 'object',
            properties: { Message: { type: 'string' }, MessageId: { type: 'string' }, TopicArn: { type: 'string' }, Type: { type: 'string' } }
          }),
          schemaVersion: '1'
        })
      });
      const codeDerivedMock = vi.fn(resolveCodeDerivedContract);
      const provider = new SnsProvider(
        createSnsClientStub(),
        tempDir,
        createSsmClientStub({
          listSpecParameters: listSpecParametersMock
        }),
        { fetchSpecFromUrl: fetchMock as never, eventBridgeClient, codeDerivedResolver: codeDerivedMock }
      );

      const enableSource = async (source: string): Promise<void> => {
        switch (source) {
          case 'repo-asyncapi':
            await writeFile(path.join(tempDir, 'asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
            break;
          case 'repo-json-schema':
            await writeFile(path.join(tempDir, 'schema.json'), '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}', 'utf8');
            break;
          case 'generated-asyncapi':
            await mkdir(path.join(tempDir, 'spec'), { recursive: true });
            await writeFile(path.join(tempDir, 'spec', 'orders-topic.asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
            break;
          case 'ssm-content':
            ssmEntries.push({ serviceName: 'orders-topic', key: 'content', value: '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}' });
            break;
          case 'ssm-url':
            ssmEntries.push({ serviceName: 'orders-topic', key: 'url', value: 'https://example.com/ssm.asyncapi.json' });
            break;
          case 'catalog-url':
            await writeFile(
              path.join(tempDir, 'catalog-info.yaml'),
              ['apiVersion: backstage.io/v1alpha1', 'kind: API', 'metadata:', '  name: orders-api', 'spec:', '  definition: https://example.com/catalog.asyncapi.json'].join('\n'),
              'utf8'
            );
            break;
          case 'eventbridge-derived':
            break;
          case 'code-derived':
            await mkdir(path.join(tempDir, 'schemas'), { recursive: true });
            await writeFile(path.join(tempDir, 'publisher.ts'), "import payloadSchema from './schemas/order-payload.json';\nawait sns.publish({ TopicArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic', Message: JSON.stringify(payloadSchema) });", 'utf8');
            await writeFile(path.join(tempDir, 'schemas', 'order-payload.json'), '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}', 'utf8');
            break;
          case 'manual-review':
            break;
          default:
            throw new Error(`unsupported source ${source}`);
        }
      };

      await enableSource(lower);
      await enableSource(higher);

      const bridgeEvidence = higher === 'eventbridge-derived' || lower === 'eventbridge-derived'
        ? ['Detected SNS/EventBridge bridge pattern in template.yaml']
        : [];
      const result = await provider.resolveContract(createSnsCandidate(), { bridgeEvidence });

      const resolvedOrigin = result.resolved ? result.origin : 'manual-review';
      expect(resolvedOrigin).toBe(higher);
      if (['repo-asyncapi', 'repo-json-schema', 'generated-asyncapi'].includes(higher)) {
        expect(listSpecParametersMock).toHaveBeenCalledTimes(0);
      }
      if (lower === 'ssm-url') {
        expect(fetchMock).not.toHaveBeenCalledWith('https://example.com/ssm.asyncapi.json', { timeoutMs: 15000 });
      }
      if (lower === 'catalog-url') {
        expect(fetchMock).not.toHaveBeenCalledWith('https://example.com/catalog.asyncapi.json', { timeoutMs: 15000 });
      }
      if (lower === 'eventbridge-derived') {
        expect(eventBridgeClient.listRegistries).toHaveBeenCalledTimes(0);
        expect(eventBridgeClient.listSchemas).toHaveBeenCalledTimes(0);
        expect(eventBridgeClient.describeSchema).toHaveBeenCalledTimes(0);
      }
      if (lower === 'code-derived') {
        expect(codeDerivedMock).toHaveBeenCalledTimes(0);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('accumulates evidence across failed levels before resolving with code-derived fallback', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-evidence-'));
    try {
      await mkdir(path.join(tempDir, 'spec'), { recursive: true });
      await mkdir(path.join(tempDir, 'schemas'), { recursive: true });
      await writeFile(path.join(tempDir, 'asyncapi.yaml'), 'openapi: 3.0.1', 'utf8');
      await writeFile(path.join(tempDir, 'schema.json'), '{"openapi":"3.0.1"}', 'utf8');
      await writeFile(path.join(tempDir, 'spec', 'orders-topic.asyncapi.yaml'), 'openapi: 3.0.1', 'utf8');
      await writeFile(
        path.join(tempDir, 'publisher.ts'),
        [
          "import payloadSchema from './schemas/order-payload.json';",
          "const topicArn = 'arn:aws:sns:us-east-1:123456789012:orders-topic';",
          'await sns.send(new PublishCommand({ TopicArn: topicArn, Message: JSON.stringify(payloadSchema) }));'
        ].join('\n'),
        'utf8'
      );
      await writeFile(path.join(tempDir, 'schemas', 'order-payload.json'), '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}', 'utf8');
      await writeFile(
        path.join(tempDir, 'catalog-info.yaml'),
        ['apiVersion: backstage.io/v1alpha1', 'kind: API', 'metadata:', '  name: orders-api', 'spec:', '  definition: https://example.com/catalog.asyncapi.json'].join('\n'),
        'utf8'
      );

      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes('ssm')) {
          return { content: '{"openapi":"3.0.1"}', contentType: 'application/json' };
        }
        throw new Error(`catalog fetch failed for ${url}`);
      });
      const provider = new SnsProvider(
        createSnsClientStub(),
        tempDir,
        createSsmClientStub({
          listSpecParameters: vi.fn().mockResolvedValue([{ serviceName: 'orders-topic', key: 'url', value: 'https://example.com/ssm.contract.json' }])
        }),
        {
          fetchSpecFromUrl: fetchMock as never,
          eventBridgeClient: createSchemasClientStub({
            listRegistries: vi.fn().mockResolvedValue([{ name: 'custom-registry', arn: 'arn:registry' }]),
            listSchemas: vi.fn().mockResolvedValue([{ name: 'orders-topic-events', arn: 'arn:schema', registryName: 'custom-registry', versionCount: 1 }]),
            describeSchema: vi.fn().mockResolvedValue({
              content: JSON.stringify({ type: 'object', properties: { detail: { type: 'object', properties: { id: { type: 'string' } } } } }),
              schemaVersion: '1'
            })
          })
        }
      );

      const result = await provider.resolveContract(createSnsCandidate(), {
        bridgeEvidence: ['Detected SNS/EventBridge bridge pattern in template.yaml']
      });

      expect(result).toMatchObject({ resolved: true, origin: 'code-derived' });
      expect(result.evidence.some((line) => line.includes('asyncapi.yaml'))).toBe(true);
      expect(result.evidence.some((line) => line.includes('schema.json'))).toBe(true);
      expect(result.evidence.some((line) => line.includes('spec/orders-topic.asyncapi.yaml'))).toBe(true);
      expect(result.evidence.some((line) => line.includes('SSM URL'))).toBe(true);
      expect(result.evidence.some((line) => line.includes('catalog'))).toBe(true);
      expect(result.evidence.some((line) => line.includes('EventBridge schema'))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps repo-local contract as canonical while still enriching subscriptions and webhook sidecars across all milestones', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-cross-milestone-'));
    try {
      await writeFile(path.join(tempDir, 'asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      const listSpecParameters = vi.fn().mockResolvedValue([
        { serviceName: 'orders-topic', key: 'content', value: '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}' }
      ]);
      const eventBridgeClient = createSchemasClientStub({
        listRegistries: vi.fn().mockResolvedValue([{ name: 'custom-registry', arn: 'arn:registry' }]),
        listSchemas: vi.fn(),
        describeSchema: vi.fn()
      });
      const codeDerivedResolver = vi.fn().mockResolvedValue({ resolved: undefined, evidence: [] });
      const snsClient = createSnsClientStub({
        listSubscriptionsByTopic: vi.fn().mockResolvedValue([
          {
            subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-sqs',
            protocol: 'sqs',
            endpoint: 'arn:aws:sqs:us-east-1:123456789012:orders-queue',
            topicArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic',
            owner: '123456789012'
          },
          {
            subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-http',
            protocol: 'https',
            endpoint: 'https://example.com/orders',
            topicArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic',
            owner: '123456789012'
          }
        ]),
        getSubscriptionAttributes: vi.fn().mockResolvedValue({
          RawMessageDelivery: 'false',
          FilterPolicy: '{"eventType":["order.created"]}',
          FilterPolicyScope: 'MessageAttributes'
        })
      });
      const provider = new SnsProvider(
        snsClient,
        tempDir,
        createSsmClientStub({ listSpecParameters }),
        { eventBridgeClient, codeDerivedResolver }
      );

      const result = await provider.resolveContract(createSnsCandidate(), {
        bridgeEvidence: ['Detected SNS/EventBridge bridge pattern in template.yaml']
      });

      expect(result).toMatchObject({ resolved: true, origin: 'repo-asyncapi' });
      expect(snsClient.listSubscriptionsByTopic).toHaveBeenCalledTimes(1);
      expect(snsClient.getSubscriptionAttributes).toHaveBeenCalledTimes(2);
      expect(result.metadata.subscriptions).toHaveLength(2);
      expect(result.sidecars?.some((sidecar) => sidecar.filename === 'webhook.openapi.json')).toBe(true);
      expect(listSpecParameters).not.toHaveBeenCalled();
      expect(eventBridgeClient.listRegistries).not.toHaveBeenCalled();
      expect(codeDerivedResolver).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract does not fetch remote contracts when no catalog or registry URL matches', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'catalog-info.yaml'),
        [
          'apiVersion: backstage.io/v1alpha1',
          'kind: API',
          'metadata:',
          '  name: billing-api',
          'spec:',
          '  definition: https://example.com/billing.asyncapi.yaml'
        ].join('\n'),
        'utf8'
      );
      const fetchMock = vi.fn().mockResolvedValue({
        content: 'asyncapi: 2.6.0\nchannels: {}',
        contentType: 'application/yaml'
      });
      const provider = new SnsProvider(createSnsClientStub(), tempDir, createSsmClientStub(), fetchMock as never);

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toEqual(expect.objectContaining({ resolved: false }));
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract normalizes SSM service names and keeps auditable evidence', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const provider = new SnsProvider(
        createSnsClientStub(),
        tempDir,
        createSsmClientStub({
          listSpecParameters: vi.fn().mockResolvedValue([
            { serviceName: 'orders-events-topic', key: 'content', value: '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}' }
          ])
        })
      );

      const result = await provider.resolveContract(
        createSnsCandidate({
          id: 'arn:aws:sns:us-east-1:123456789012:OrdersEventsTopic.fifo',
          name: 'OrdersEventsTopic.fifo',
          meta: { topicArn: 'arn:aws:sns:us-east-1:123456789012:OrdersEventsTopic.fifo' }
        })
      );

      expect(result).toMatchObject({ resolved: true, origin: 'ssm-content' });
      expect(result.evidence.some((line) => line.includes('/postman/specs/orders-events-topic/'))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract evidence includes repo file paths and accumulated fallback trail', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await mkdir(path.join(tempDir, 'contracts'), { recursive: true });
      await writeFile(path.join(tempDir, 'asyncapi.yaml'), 'title: missing asyncapi key', 'utf8');
      await writeFile(path.join(tempDir, 'contracts', 'orders.schema.json'), '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}', 'utf8');
      const provider = new SnsProvider(createSnsClientStub(), tempDir);

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toMatchObject({ resolved: true, origin: 'repo-json-schema' });
      expect(result.evidence.some((line) => line.includes('asyncapi.yaml'))).toBe(true);
      expect(result.evidence.some((line) => line.includes('contracts/orders.schema.json'))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract enforces path sandboxing for unsafe topic names', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const provider = new SnsProvider(createSnsClientStub(), tempDir);

      await expect(
        provider.resolveContract(
          createSnsCandidate({
            id: 'arn:aws:sns:us-east-1:123456789012:../../escape',
            name: '../../escape',
            meta: { topicArn: 'arn:aws:sns:us-east-1:123456789012:../../escape' }
          })
        )
      ).rejects.toThrow(/must stay within repo-root\/workspace/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract inspects subscriptions and models required metadata fields', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      const listSubscriptionsByTopic = vi.fn().mockResolvedValue([
        {
          subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-1',
          protocol: 'sqs',
          endpoint: 'arn:aws:sqs:us-east-1:123456789012:orders-queue'
        }
      ]);
      const getSubscriptionAttributes = vi.fn().mockResolvedValue({
        RawMessageDelivery: 'true',
        FilterPolicy: '{"eventType":["order.created"]}',
        FilterPolicyScope: 'MessageBody',
        RedrivePolicy: '{"deadLetterTargetArn":"arn:aws:sqs:us-east-1:123456789012:dlq"}',
        DeliveryPolicy: '{"healthyRetryPolicy":{"numRetries":3}}'
      });
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic,
          getSubscriptionAttributes
        }),
        tempDir
      );

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toMatchObject({ resolved: true, origin: 'repo-asyncapi' });
      expect(listSubscriptionsByTopic).toHaveBeenCalledWith('arn:aws:sns:us-east-1:123456789012:orders-topic');
      expect(getSubscriptionAttributes).toHaveBeenCalledWith('arn:aws:sns:us-east-1:123456789012:orders-topic:sub-1');
      expect(result.metadata.contractOrigin).toBe('repo-asyncapi');
      expect(result.metadata.subscriptions).toEqual([
        {
          subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-1',
          protocol: 'sqs',
          endpoint: 'arn:aws:sqs:us-east-1:123456789012:orders-queue',
          variant: 'raw-payload',
          RawMessageDelivery: 'true',
          FilterPolicy: '{"eventType":["order.created"]}',
          FilterPolicyScope: 'MessageBody',
          filterPolicyScope: 'MessageBody',
          filterPolicyRaw: '{"eventType":["order.created"]}',
          RedrivePolicy: '{"deadLetterTargetArn":"arn:aws:sqs:us-east-1:123456789012:dlq"}',
          DeliveryPolicy: '{"healthyRetryPolicy":{"numRetries":3}}'
        }
      ]);
      expect(result.metadata.messageAttributes).toEqual({});
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract derives structured messageAttributes metadata from filter policies', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-1', protocol: 'sqs', endpoint: 'queue-1' }
          ]),
          getSubscriptionAttributes: vi.fn().mockResolvedValue({
            Protocol: 'sqs',
            FilterPolicy: JSON.stringify({
              eventType: ['order.created'],
              attempt: [{ numeric: ['>', 3] }]
            })
          })
        }),
        tempDir
      );

      const result = await provider.resolveContract(createSnsCandidate());
      expect(result.metadata).toHaveProperty('messageAttributes');
      expect(result.metadata.messageAttributes).toEqual({
        eventType: { dataType: 'String' },
        attempt: { dataType: 'Number' }
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract derives AsyncAPI message headers when missing using known message attributes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'asyncapi.yaml'),
        [
          'asyncapi: 2.6.0',
          'channels:',
          '  orders:',
          '    publish:',
          '      message:',
          '        payload:',
          '          type: object',
          '          properties:',
          '            orderId:',
          '              type: string'
        ].join('\n'),
        'utf8'
      );
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-1', protocol: 'sqs', endpoint: 'queue-1' }
          ]),
          getSubscriptionAttributes: vi.fn().mockResolvedValue({
            Protocol: 'sqs',
            FilterPolicy: JSON.stringify({
              eventType: ['order.created'],
              retries: [{ numeric: ['>=', 1] }]
            })
          })
        }),
        tempDir
      );

      const result = await provider.resolveContract(createSnsCandidate());
      expect(result).toMatchObject({ resolved: true, origin: 'repo-asyncapi' });
      if (result.resolved) {
        expect(result.result.content).toContain('SnsDerivedHeaders');
        expect(result.result.content).toContain('eventType');
        expect(result.result.content).toContain('retries');
        expect(result.result.content).toContain('$ref: "#/components/schemas/SnsDerivedHeaders"');
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract does not modify AsyncAPI headers when existing headers are already defined', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    const asyncApiWithHeaders = [
      'asyncapi: 2.6.0',
      'components:',
      '  schemas:',
      '    ExistingHeaders:',
      '      type: object',
      '      properties:',
      '        existing:',
      '          type: string',
      'channels:',
      '  orders:',
      '    publish:',
      '      message:',
      '        headers:',
      '          $ref: "#/components/schemas/ExistingHeaders"',
      '        payload:',
      '          type: object',
      '          properties:',
      '            orderId:',
      '              type: string'
    ].join('\n');
    try {
      await writeFile(path.join(tempDir, 'asyncapi.yaml'), asyncApiWithHeaders, 'utf8');
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-1', protocol: 'sqs', endpoint: 'queue-1' }
          ]),
          getSubscriptionAttributes: vi.fn().mockResolvedValue({
            Protocol: 'sqs',
            FilterPolicy: JSON.stringify({
              eventType: ['order.created']
            })
          })
        }),
        tempDir
      );

      const result = await provider.resolveContract(createSnsCandidate());
      expect(result).toMatchObject({ resolved: true, origin: 'repo-asyncapi' });
      if (result.resolved) {
        expect(result.result.content).toContain('$ref: "#/components/schemas/ExistingHeaders"');
        expect(result.result.content).not.toContain('SnsDerivedHeaders');
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract records filter policy scope for MessageBody and defaults to MessageAttributes when absent', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'schema.json'), '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}', 'utf8');
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-body', protocol: 'sqs', endpoint: 'queue-1' },
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-default', protocol: 'sqs', endpoint: 'queue-2' }
          ]),
          getSubscriptionAttributes: vi
            .fn()
            .mockResolvedValueOnce({
              Protocol: 'sqs',
              FilterPolicy: '{"eventType":["order.created"]}',
              FilterPolicyScope: 'MessageBody'
            })
            .mockResolvedValueOnce({
              Protocol: 'sqs',
              FilterPolicy: '{"eventType":["order.updated"]}'
            })
        }),
        tempDir
      );

      const result = await provider.resolveContract(createSnsCandidate());
      expect(result.metadata.subscriptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-body', filterPolicyScope: 'MessageBody' }),
          expect.objectContaining({
            subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-default',
            filterPolicyScope: 'MessageAttributes'
          })
        ])
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract preserves raw filter policy JSON in sidecar without modifying payload schema', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    const contract = [
      'asyncapi: 2.6.0',
      'channels:',
      '  orders:',
      '    publish:',
      '      message:',
      '        payload:',
      '          type: object',
      '          properties:',
      '            orderId:',
      '              type: string'
    ].join('\n');
    try {
      await writeFile(path.join(tempDir, 'asyncapi.yaml'), contract, 'utf8');
      const rawFilterPolicy = '{"eventType":["order.created"],"priority":[{"numeric":[">",3]}]}';
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-1', protocol: 'sqs', endpoint: 'queue-1' }
          ]),
          getSubscriptionAttributes: vi.fn().mockResolvedValue({
            Protocol: 'sqs',
            FilterPolicy: rawFilterPolicy
          })
        }),
        tempDir
      );

      const result = await provider.resolveContract(createSnsCandidate());
      expect(result.metadata.subscriptions[0]?.filterPolicyRaw).toBe(rawFilterPolicy);
      if (result.resolved) {
        expect(result.result.content).toContain('orderId');
        expect(result.result.content).toContain('SnsDerivedHeaders');
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract classifies SQS RawMessageDelivery=true as raw-payload', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-1', protocol: 'sqs', endpoint: 'queue-1' }
          ]),
          getSubscriptionAttributes: vi.fn().mockResolvedValue({ Protocol: 'sqs', RawMessageDelivery: 'true' })
        }),
        tempDir
      );

      const result = await provider.resolveContract(createSnsCandidate());
      expect(result).toMatchObject({ resolved: true, variantCount: 1 });
      expect(result.metadata.subscriptions[0]?.variant).toBe('raw-payload');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract classifies SQS RawMessageDelivery=false as sns-envelope', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-1', protocol: 'sqs', endpoint: 'queue-1' }
          ]),
          getSubscriptionAttributes: vi.fn().mockResolvedValue({ Protocol: 'sqs', RawMessageDelivery: 'false' })
        }),
        tempDir
      );

      const result = await provider.resolveContract(createSnsCandidate());
      expect(result.metadata.subscriptions[0]?.variant).toBe('sns-envelope');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract classifies SQS with RawMessageDelivery unset as sns-envelope', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-1', protocol: 'sqs', endpoint: 'queue-1' }
          ]),
          getSubscriptionAttributes: vi.fn().mockResolvedValue({ Protocol: 'sqs' })
        }),
        tempDir
      );

      const result = await provider.resolveContract(createSnsCandidate());
      expect(result.metadata.subscriptions[0]?.variant).toBe('sns-envelope');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract always classifies lambda subscriptions as sns-envelope', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-1', protocol: 'lambda', endpoint: 'function-1' }
          ]),
          getSubscriptionAttributes: vi.fn().mockResolvedValue({ Protocol: 'lambda', RawMessageDelivery: 'true' })
        }),
        tempDir
      );

      const result = await provider.resolveContract(createSnsCandidate());
      expect(result.metadata.subscriptions[0]?.variant).toBe('sns-envelope');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract classifies HTTP subscriptions using RawMessageDelivery', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-1', protocol: 'https', endpoint: 'https://example.com/a' },
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-2', protocol: 'http', endpoint: 'http://example.com/b' }
          ]),
          getSubscriptionAttributes: vi
            .fn()
            .mockResolvedValueOnce({ Protocol: 'https', RawMessageDelivery: 'true' })
            .mockResolvedValueOnce({ Protocol: 'http', RawMessageDelivery: 'false' })
        }),
        tempDir
      );

      const result = await provider.resolveContract(createSnsCandidate());
      expect(result.metadata.subscriptions.map((subscription) => subscription.variant)).toEqual(['raw-payload', 'sns-envelope']);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract sets variantCount to count distinct delivery variants', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-1', protocol: 'sqs', endpoint: 'queue-1' },
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-2', protocol: 'https', endpoint: 'https://example.com' },
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-3', protocol: 'lambda', endpoint: 'function-1' }
          ]),
          getSubscriptionAttributes: vi
            .fn()
            .mockResolvedValueOnce({ Protocol: 'sqs', RawMessageDelivery: 'true' })
            .mockResolvedValueOnce({ Protocol: 'https', RawMessageDelivery: 'false' })
            .mockResolvedValueOnce({ Protocol: 'lambda', RawMessageDelivery: 'true' })
        }),
        tempDir
      );

      const result = await provider.resolveContract(createSnsCandidate());
      expect(result).toMatchObject({ resolved: true, variantCount: 2 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract delivery variant classification does not change canonical contract selection', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'schema.json'), '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}', 'utf8');
      const candidate = createSnsCandidate();
      const withoutSubscriptionsProvider = new SnsProvider(createSnsClientStub(), tempDir);
      const withSubscriptionsProvider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-1', protocol: 'sqs', endpoint: 'queue-1' }
          ]),
          getSubscriptionAttributes: vi.fn().mockResolvedValue({ Protocol: 'sqs', RawMessageDelivery: 'true' })
        }),
        tempDir
      );

      const withoutSubscriptions = await withoutSubscriptionsProvider.resolveContract(candidate);
      const withSubscriptions = await withSubscriptionsProvider.resolveContract(candidate);
      expect(withoutSubscriptions).toMatchObject({ resolved: true, origin: 'repo-json-schema' });
      expect(withSubscriptions).toMatchObject({ resolved: true, origin: 'repo-json-schema' });
      if (withoutSubscriptions.resolved && withSubscriptions.resolved) {
        expect(withSubscriptions.result.format).toBe(withoutSubscriptions.result.format);
        expect(withSubscriptions.result.filename).toBe(withoutSubscriptions.result.filename);
        expect(withSubscriptions.result.content).toBe(withoutSubscriptions.result.content);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract keeps subscription inspection non-fatal for per-subscription attribute failures', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'schema.json'), '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}', 'utf8');
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-1', protocol: 'sqs', endpoint: 'queue-1' },
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-2', protocol: 'lambda', endpoint: 'fn-1' }
          ]),
          getSubscriptionAttributes: vi
            .fn()
            .mockResolvedValueOnce({ RawMessageDelivery: 'false' })
            .mockRejectedValueOnce(new Error('InternalErrorException'))
        }),
        tempDir
      );

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toMatchObject({ resolved: true, origin: 'repo-json-schema' });
      expect(result.metadata.subscriptions).toHaveLength(2);
      expect(result.metadata.subscriptions[0]?.subscriptionArn).toContain('sub-1');
      expect(result.metadata.subscriptions[1]).toEqual(
        expect.objectContaining({
          subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-2',
          protocol: 'lambda',
          endpoint: 'fn-1',
          variant: 'sns-envelope'
        })
      );
      expect(result.metadata.subscriptionSummary.failed).toBe(1);
      expect(result.metadata.subscriptionSummary.errors).toEqual([
        { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-2', error: 'InternalErrorException' }
      ]);
      expect(result.evidence.some((line) => line.includes('sub-2'))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract generates webhook.openapi.json for HTTP/S subscriptions with OpenAPI 3.1 webhooks', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'schema.json'), '{"type":"object","properties":{"orderId":{"type":"string"}}}', 'utf8');
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            {
              subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-http',
              protocol: 'https',
              endpoint: 'https://subscriber.example.com/orders'
            }
          ]),
          getSubscriptionAttributes: vi.fn().mockResolvedValue({
            Protocol: 'https',
            Endpoint: 'https://subscriber.example.com/orders',
            RawMessageDelivery: 'true'
          })
        }),
        tempDir
      );

      const result = await provider.resolveContract(createSnsCandidate());
      expect(result).toMatchObject({ resolved: true, origin: 'repo-json-schema' });
      if (result.resolved) {
        const webhookSidecar = result.sidecars?.find((sidecar) => sidecar.filename === 'webhook.openapi.json');
        expect(webhookSidecar).toBeDefined();
        const webhookDoc = JSON.parse(webhookSidecar?.content ?? '{}') as Record<string, unknown>;
        expect(webhookDoc.openapi).toBe('3.1.0');
        expect(webhookDoc).toHaveProperty('webhooks');
        const entries = Object.values((webhookDoc.webhooks as Record<string, unknown>) ?? {});
        expect(entries.length).toBeGreaterThan(0);
        const firstWebhook = entries[0] as Record<string, unknown>;
        const post = firstWebhook.post as Record<string, unknown>;
        expect(post['x-sns-raw-delivery']).toBe(true);
        expect(post).toHaveProperty('requestBody.content.application/json.schema');
        const serialized = JSON.stringify(webhookDoc);
        expect(serialized).not.toContain('subscriber.example.com');
        expect(result.metadata.subscriptions[0]?.endpoint).toBe('https://subscriber.example.com/orders');
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract includes referenced AsyncAPI payload components in webhook sidecar', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'asyncapi.yaml'),
        [
          'asyncapi: 2.6.0',
          'components:',
          '  schemas:',
          '    OrderEvent:',
          '      type: object',
          '      properties:',
          '        orderId:',
          '          type: string',
          '        detail:',
          '          $ref: "#/components/schemas/OrderDetail"',
          '    OrderDetail:',
          '      type: object',
          '      properties:',
          '        amount:',
          '          type: number',
          'channels:',
          '  orders:',
          '    publish:',
          '      message:',
          '        payload:',
          '          $ref: "#/components/schemas/OrderEvent"'
        ].join('\n'),
        'utf8'
      );
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            {
              subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-http',
              protocol: 'https',
              endpoint: 'https://subscriber.example.com/orders'
            }
          ]),
          getSubscriptionAttributes: vi.fn().mockResolvedValue({
            Protocol: 'https',
            Endpoint: 'https://subscriber.example.com/orders',
            RawMessageDelivery: 'true'
          })
        }),
        tempDir
      );

      const result = await provider.resolveContract(createSnsCandidate());
      expect(result).toMatchObject({ resolved: true, origin: 'repo-asyncapi' });
      if (result.resolved) {
        const webhookSidecar = result.sidecars?.find((sidecar) => sidecar.filename === 'webhook.openapi.json');
        expect(webhookSidecar).toBeDefined();
        const webhookDoc = JSON.parse(webhookSidecar?.content ?? '{}') as Record<string, unknown>;
        expect(webhookDoc).toHaveProperty('components.schemas.OrderEvent');
        expect(webhookDoc).toHaveProperty('components.schemas.OrderDetail');
        expect(webhookDoc).toHaveProperty(
          'webhooks.snsMessageRaw.post.requestBody.content.application/json.schema.$ref',
          '#/components/schemas/OrderEvent'
        );
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract resolves message-level $ref entries to AsyncAPI components/messages definitions', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'asyncapi.yaml'),
        [
          'asyncapi: 2.6.0',
          'components:',
          '  messages:',
          '    OrderCreatedMessage:',
          '      payload:',
          '        $ref: "#/components/schemas/OrderEvent"',
          '  schemas:',
          '    OrderEvent:',
          '      type: object',
          '      properties:',
          '        orderId:',
          '          type: string',
          'channels:',
          '  orders:',
          '    publish:',
          '      message:',
          '        $ref: "#/components/messages/OrderCreatedMessage"'
        ].join('\n'),
        'utf8'
      );
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            {
              subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-http',
              protocol: 'https',
              endpoint: 'https://subscriber.example.com/orders'
            }
          ]),
          getSubscriptionAttributes: vi.fn().mockResolvedValue({ Protocol: 'https', RawMessageDelivery: 'true' })
        }),
        tempDir
      );

      const result = await provider.resolveContract(createSnsCandidate());
      expect(result).toMatchObject({ resolved: true, origin: 'repo-asyncapi' });
      if (result.resolved) {
        const webhookSidecar = result.sidecars?.find((sidecar) => sidecar.filename === 'webhook.openapi.json');
        const webhookDoc = JSON.parse(webhookSidecar?.content ?? '{}') as Record<string, unknown>;
        expect(webhookDoc).toHaveProperty(
          'webhooks.snsMessageRaw.post.requestBody.content.application/json.schema.$ref',
          '#/components/schemas/OrderEvent'
        );
        expect(webhookDoc).toHaveProperty('components.schemas.OrderEvent');
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract resolves all oneOf message members that are $ref entries', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'asyncapi.yaml'),
        [
          'asyncapi: 2.6.0',
          'components:',
          '  messages:',
          '    OrderCreatedMessage:',
          '      payload:',
          '        $ref: "#/components/schemas/OrderCreatedEvent"',
          '    OrderCancelledMessage:',
          '      payload:',
          '        $ref: "#/components/schemas/OrderCancelledEvent"',
          '  schemas:',
          '    OrderCreatedEvent:',
          '      type: object',
          '      properties:',
          '        orderId:',
          '          type: string',
          '    OrderCancelledEvent:',
          '      type: object',
          '      properties:',
          '        reason:',
          '          type: string',
          'channels:',
          '  orders:',
          '    publish:',
          '      message:',
          '        oneOf:',
          '          - $ref: "#/components/messages/OrderCreatedMessage"',
          '          - $ref: "#/components/messages/OrderCancelledMessage"'
        ].join('\n'),
        'utf8'
      );
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            {
              subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-http',
              protocol: 'https',
              endpoint: 'https://subscriber.example.com/orders'
            }
          ]),
          getSubscriptionAttributes: vi.fn().mockResolvedValue({ Protocol: 'https', RawMessageDelivery: 'true' })
        }),
        tempDir
      );

      const result = await provider.resolveContract(createSnsCandidate());
      expect(result).toMatchObject({ resolved: true, origin: 'repo-asyncapi' });
      if (result.resolved) {
        const webhookSidecar = result.sidecars?.find((sidecar) => sidecar.filename === 'webhook.openapi.json');
        const webhookDoc = JSON.parse(webhookSidecar?.content ?? '{}') as Record<string, unknown>;
        expect(webhookDoc).toHaveProperty('webhooks.snsMessageRaw.post.requestBody.content.application/json.schema.oneOf');
        expect(webhookDoc).toHaveProperty(
          'webhooks.snsMessageRaw.post.requestBody.content.application/json.schema.oneOf.0.$ref',
          '#/components/schemas/OrderCreatedEvent'
        );
        expect(webhookDoc).toHaveProperty(
          'webhooks.snsMessageRaw.post.requestBody.content.application/json.schema.oneOf.1.$ref',
          '#/components/schemas/OrderCancelledEvent'
        );
        expect(webhookDoc).toHaveProperty('components.schemas.OrderCreatedEvent');
        expect(webhookDoc).toHaveProperty('components.schemas.OrderCancelledEvent');
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract carries deeply nested AsyncAPI schema $ref chains into webhook components', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'asyncapi.yaml'),
        [
          'asyncapi: 2.6.0',
          'components:',
          '  messages:',
          '    OrderMessage:',
          '      payload:',
          '        $ref: "#/components/schemas/OrderEvent"',
          '  schemas:',
          '    OrderEvent:',
          '      type: object',
          '      properties:',
          '        detail:',
          '          $ref: "#/components/schemas/OrderDetail"',
          '    OrderDetail:',
          '      type: object',
          '      properties:',
          '        payment:',
          '          $ref: "#/components/schemas/PaymentDetail"',
          '    PaymentDetail:',
          '      type: object',
          '      properties:',
          '        cardLast4:',
          '          type: string',
          'channels:',
          '  orders:',
          '    publish:',
          '      message:',
          '        $ref: "#/components/messages/OrderMessage"'
        ].join('\n'),
        'utf8'
      );
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            {
              subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-http',
              protocol: 'https',
              endpoint: 'https://subscriber.example.com/orders'
            }
          ]),
          getSubscriptionAttributes: vi.fn().mockResolvedValue({ Protocol: 'https', RawMessageDelivery: 'true' })
        }),
        tempDir
      );

      const result = await provider.resolveContract(createSnsCandidate());
      expect(result).toMatchObject({ resolved: true, origin: 'repo-asyncapi' });
      if (result.resolved) {
        const webhookSidecar = result.sidecars?.find((sidecar) => sidecar.filename === 'webhook.openapi.json');
        const webhookDoc = JSON.parse(webhookSidecar?.content ?? '{}') as Record<string, unknown>;
        expect(webhookDoc).toHaveProperty('components.schemas.OrderEvent');
        expect(webhookDoc).toHaveProperty('components.schemas.OrderDetail');
        expect(webhookDoc).toHaveProperty('components.schemas.PaymentDetail');
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract does not generate webhook sidecar for non-http subscriptions', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'schema.json'), '{"type":"object"}', 'utf8');
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-sqs', protocol: 'sqs', endpoint: 'queue' },
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-lambda', protocol: 'lambda', endpoint: 'fn' }
          ]),
          getSubscriptionAttributes: vi
            .fn()
            .mockResolvedValueOnce({ Protocol: 'sqs', RawMessageDelivery: 'true' })
            .mockResolvedValueOnce({ Protocol: 'lambda' })
        }),
        tempDir
      );

      const result = await provider.resolveContract(createSnsCandidate());
      expect(result).toMatchObject({ resolved: true, origin: 'repo-json-schema' });
      if (result.resolved) {
        expect(result.sidecars?.some((sidecar) => sidecar.filename === 'webhook.openapi.json') ?? false).toBe(false);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract emits a single webhook sidecar for multiple HTTP/S subscriptions and both variants', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'schema.json'), '{"type":"object"}', 'utf8');
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-http', protocol: 'http', endpoint: 'http://a.example.com' },
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-https', protocol: 'https', endpoint: 'https://b.example.com' }
          ]),
          getSubscriptionAttributes: vi
            .fn()
            .mockResolvedValueOnce({ Protocol: 'http', RawMessageDelivery: 'false' })
            .mockResolvedValueOnce({ Protocol: 'https', RawMessageDelivery: 'true' })
        }),
        tempDir
      );

      const result = await provider.resolveContract(createSnsCandidate());
      expect(result).toMatchObject({ resolved: true, origin: 'repo-json-schema' });
      if (result.resolved) {
        const webhookSidecars = (result.sidecars ?? []).filter((sidecar) => sidecar.filename === 'webhook.openapi.json');
        expect(webhookSidecars).toHaveLength(1);
        const doc = JSON.parse(webhookSidecars[0]?.content ?? '{}') as Record<string, unknown>;
        const webhookEntries = Object.values((doc.webhooks as Record<string, unknown>) ?? {}) as Array<Record<string, unknown>>;
        const rawFlags = webhookEntries.map((entry) => ((entry.post as Record<string, unknown>)['x-sns-raw-delivery'] as boolean));
        expect(rawFlags.sort()).toEqual([false, true]);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('exportSpec keeps canonical contract as primary while adding webhook sidecar', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'schema.json'), '{"type":"object"}', 'utf8');
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-https', protocol: 'https', endpoint: 'https://a.example.com' }
          ]),
          getSubscriptionAttributes: vi.fn().mockResolvedValue({ Protocol: 'https', RawMessageDelivery: 'false' })
        }),
        tempDir
      );

      const exported = await provider.exportSpec(createSnsCandidate(), {});
      expect(exported.filename).toBe('schema.json');
      expect(exported.format).toBe('json-schema');
      expect(exported.sidecars?.some((sidecar) => sidecar.filename === 'webhook.openapi.json')).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract records webhook generation failures without failing canonical resolution', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'schema.json'), '{"type":"object"}', 'utf8');
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            { subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-https', protocol: 'https', endpoint: 'https://a.example.com' }
          ]),
          getSubscriptionAttributes: vi.fn().mockResolvedValue({ Protocol: 'https', RawMessageDelivery: 'false' })
        }),
        tempDir,
        undefined,
        {
          webhookSidecarBuilder: () => {
            throw new Error('webhook generation blew up');
          }
        }
      );

      const result = await provider.resolveContract(createSnsCandidate());
      expect(result).toMatchObject({ resolved: true, origin: 'repo-json-schema' });
      if (result.resolved) {
        expect(result.sidecars?.some((sidecar) => sidecar.filename === 'webhook.openapi.json') ?? false).toBe(false);
      }
      expect(result.evidence.some((line) => line.includes('Failed to generate webhook sidecar'))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract retains subscription summaries when attribute fetch fails and still generates webhook sidecar', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'schema.json'), '{"type":"object"}', 'utf8');
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([
            {
              subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-https',
              protocol: 'https',
              endpoint: 'https://subscriber.example.com/orders'
            }
          ]),
          getSubscriptionAttributes: vi.fn().mockRejectedValue(new Error('InternalErrorException'))
        }),
        tempDir
      );

      const result = await provider.resolveContract(createSnsCandidate());
      expect(result).toMatchObject({ resolved: true, origin: 'repo-json-schema' });
      expect(result.metadata.subscriptions).toEqual([
        expect.objectContaining({
          subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-https',
          protocol: 'https',
          endpoint: 'https://subscriber.example.com/orders',
          variant: 'sns-envelope'
        })
      ]);
      if (result.resolved) {
        const webhookSidecar = result.sidecars?.find((sidecar) => sidecar.filename === 'webhook.openapi.json');
        expect(webhookSidecar).toBeDefined();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract records AccessDenied subscription list failure as evidence and still returns metadata', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockRejectedValue(new Error('AccessDeniedException: not authorized')),
          getSubscriptionAttributes: vi.fn()
        }),
        tempDir
      );

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toMatchObject({ resolved: true, origin: 'repo-asyncapi' });
      expect(result.metadata.subscriptions).toEqual([]);
      expect(result.metadata.subscriptionSummary.errors).toEqual([{ error: 'AccessDeniedException: not authorized' }]);
      expect(result.evidence.some((line) => line.includes('AccessDeniedException'))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('resolveContract returns metadata sidecar payload for manual-review with empty subscriptions array', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const provider = new SnsProvider(
        createSnsClientStub({
          listSubscriptionsByTopic: vi.fn().mockResolvedValue([])
        }),
        tempDir,
        createSsmClientStub()
      );

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toEqual(expect.objectContaining({ resolved: false }));
      expect(result.metadata.contractOrigin).toBe('manual-review');
      expect(result.metadata.subscriptions).toEqual([]);
      expect(result.metadata.subscriptionSummary.total).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('exportSpec emits sns-resolution-metadata.json sidecar for resolved and manual-review results', async () => {
    const resolvedDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    const unresolvedDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(resolvedDir, 'asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      const resolvedProvider = new SnsProvider(createSnsClientStub(), resolvedDir);
      const resolved = await resolvedProvider.exportSpec(createSnsCandidate(), {});
      const resolvedSidecar = resolved.sidecars?.find((entry) => entry.filename === 'sns-resolution-metadata.json');
      expect(resolvedSidecar).toBeDefined();
      expect(() => JSON.parse(resolvedSidecar?.content ?? '')).not.toThrow();

      const unresolvedProvider = new SnsProvider(createSnsClientStub(), unresolvedDir, createSsmClientStub());
      const unresolved = await unresolvedProvider.exportSpec(createSnsCandidate(), {});
      expect(unresolved.filename).toBe('manual-review.json');
      const unresolvedSidecar = unresolved.sidecars?.find((entry) => entry.filename === 'sns-resolution-metadata.json');
      expect(unresolvedSidecar).toBeDefined();
      expect(JSON.parse(unresolvedSidecar?.content ?? '{}')).toMatchObject({ contractOrigin: 'manual-review', subscriptions: [] });
    } finally {
      await rm(resolvedDir, { recursive: true, force: true });
      await rm(unresolvedDir, { recursive: true, force: true });
    }
  });

  it('exportSpec delegates to resolveContract result', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      const provider = new SnsProvider(createSnsClientStub(), tempDir);
      const candidate = createSnsCandidate();

      const resolved = await provider.resolveContract(candidate);
      const exported = await provider.exportSpec(candidate, {});

      expect(resolved).toEqual(expect.objectContaining({ resolved: true }));
      if (resolved.resolved) {
        expect(exported.content).toBe(resolved.result.content);
        expect(exported.format).toBe(resolved.result.format);
        expect(exported.filename).toBe(resolved.result.filename);
        expect(exported.evidence).toEqual(resolved.result.evidence);
        expect(exported.sidecars?.some((sidecar) => sidecar.filename === 'sns-resolution-metadata.json')).toBe(true);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not query EventBridge bridge fallback when stronger SNS sources resolve', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(path.join(tempDir, 'asyncapi.yaml'), 'asyncapi: 2.6.0\nchannels: {}', 'utf8');
      const eventBridgeClient = createSchemasClientStub({
        listRegistries: vi.fn().mockResolvedValue([{ name: 'custom-registry', arn: 'arn:registry' }]),
        listSchemas: vi.fn().mockResolvedValue([{ name: 'orders-topic', arn: 'arn:schema', registryName: 'custom-registry', versionCount: 1 }]),
        describeSchema: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            type: 'object',
            properties: { Message: { type: 'string' }, MessageId: { type: 'string' }, TopicArn: { type: 'string' }, Type: { type: 'string' } }
          }),
          schemaVersion: '1'
        })
      });
      const provider = new SnsProvider(createSnsClientStub(), tempDir, undefined, { eventBridgeClient });

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toMatchObject({ resolved: true, origin: 'repo-asyncapi' });
      expect(eventBridgeClient.listRegistries).not.toHaveBeenCalled();
      expect(eventBridgeClient.listSchemas).not.toHaveBeenCalled();
      expect(eventBridgeClient.describeSchema).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('queries EventBridge schema registry fallback when stronger SNS sources fail and resolves SNS envelope shape', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const eventBridgeClient = createSchemasClientStub({
        listRegistries: vi.fn().mockResolvedValue([{ name: 'custom-registry', arn: 'arn:registry' }]),
        listSchemas: vi.fn().mockResolvedValue([
          { name: 'unrelated-events', arn: 'arn:schema:1', registryName: 'custom-registry', versionCount: 1 },
          { name: 'orders-topic-events', arn: 'arn:schema:2', registryName: 'custom-registry', versionCount: 1 }
        ]),
        describeSchema: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            type: 'object',
            properties: {
              Message: { type: 'string' },
              MessageId: { type: 'string' },
              TopicArn: { type: 'string' },
              Type: { type: 'string' }
            }
          }),
          schemaVersion: '1'
        })
      });
      const provider = new SnsProvider(createSnsClientStub(), tempDir, createSsmClientStub(), { eventBridgeClient });

      const result = await provider.resolveContract(createSnsCandidate(), {
        bridgeEvidence: ['Detected SNS/EventBridge bridge pattern in template.yaml']
      });

      expect(result).toMatchObject({ resolved: true, origin: 'eventbridge-derived' });
      if (result.resolved) {
        expect(result.result.format).toBe('json-schema');
        expect(result.metadata.contractOrigin).toBe('eventbridge-derived');
      }
      expect(eventBridgeClient.listRegistries).toHaveBeenCalledTimes(1);
      expect(eventBridgeClient.listSchemas).toHaveBeenCalledWith('custom-registry');
      expect(eventBridgeClient.describeSchema).toHaveBeenCalledTimes(1);
      expect(eventBridgeClient.describeSchema).toHaveBeenCalledWith('custom-registry', 'orders-topic-events');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('flags transformed metadata for EventBridge wrapper schemas with SNS payload under detail', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const eventBridgeClient = createSchemasClientStub({
        listRegistries: vi.fn().mockResolvedValue([{ name: 'custom-registry', arn: 'arn:registry' }]),
        listSchemas: vi.fn().mockResolvedValue([{ name: 'orders-topic', arn: 'arn:schema', registryName: 'custom-registry', versionCount: 1 }]),
        describeSchema: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            type: 'object',
            properties: {
              detail: {
                type: 'object',
                properties: {
                  Message: { type: 'string' },
                  MessageId: { type: 'string' },
                  TopicArn: { type: 'string' },
                  Type: { type: 'string' }
                }
              }
            }
          }),
          schemaVersion: '1'
        })
      });
      const provider = new SnsProvider(createSnsClientStub(), tempDir, createSsmClientStub(), { eventBridgeClient });

      const result = await provider.resolveContract(createSnsCandidate(), {
        bridgeEvidence: ['Detected SNS/EventBridge bridge pattern in template.yaml']
      });

      expect(result).toMatchObject({ resolved: true, origin: 'eventbridge-derived' });
      expect(result.metadata).toEqual(expect.objectContaining({ transformed: true }));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('degrades gracefully when EventBridge schemas permissions are missing', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const eventBridgeClient = createSchemasClientStub({
        listRegistries: vi.fn().mockRejectedValue(Object.assign(new Error('no access'), { name: 'AccessDeniedException' })),
        listSchemas: vi.fn(),
        describeSchema: vi.fn()
      });
      const provider = new SnsProvider(createSnsClientStub(), tempDir, createSsmClientStub(), { eventBridgeClient });

      const result = await provider.resolveContract(createSnsCandidate(), {
        bridgeEvidence: ['Detected SNS/EventBridge bridge pattern in template.yaml']
      });

      expect(result).toEqual(expect.objectContaining({ resolved: false }));
      expect(result.metadata.contractOrigin).toBe('manual-review');
      expect(result.evidence.some((entry) => entry.includes('EventBridge'))).toBe(true);
      expect(eventBridgeClient.listRegistries).toHaveBeenCalledTimes(1);
      expect(eventBridgeClient.listSchemas).not.toHaveBeenCalled();
      expect(eventBridgeClient.describeSchema).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps precedence: SSM URL resolves before EventBridge-derived fallback', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const fetchMock = vi.fn().mockResolvedValue({ content: '{"asyncapi":"2.6.0","channels":{}}', contentType: 'application/json' });
      const eventBridgeClient = createSchemasClientStub({
        listRegistries: vi.fn().mockResolvedValue([{ name: 'custom-registry', arn: 'arn:registry' }]),
        listSchemas: vi.fn().mockResolvedValue([{ name: 'orders-topic', arn: 'arn:schema', registryName: 'custom-registry', versionCount: 1 }]),
        describeSchema: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            type: 'object',
            properties: { Message: { type: 'string' }, MessageId: { type: 'string' }, TopicArn: { type: 'string' }, Type: { type: 'string' } }
          }),
          schemaVersion: '1'
        })
      });
      const provider = new SnsProvider(
        createSnsClientStub(),
        tempDir,
        createSsmClientStub({
          listSpecParameters: vi.fn().mockResolvedValue([{ serviceName: 'orders-topic', key: 'url', value: 'https://example.com/orders.asyncapi.json' }])
        }),
        { fetchSpecFromUrl: fetchMock as never, eventBridgeClient }
      );

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toMatchObject({ resolved: true, origin: 'ssm-url' });
      expect(eventBridgeClient.listRegistries).not.toHaveBeenCalled();
      expect(eventBridgeClient.describeSchema).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('skips EventBridge fallback without bridge evidence even when client is available', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const eventBridgeClient = createSchemasClientStub({
        listRegistries: vi.fn().mockResolvedValue([{ name: 'custom-registry', arn: 'arn:registry' }]),
        listSchemas: vi.fn().mockResolvedValue([{ name: 'orders-topic', arn: 'arn:schema', registryName: 'custom-registry', versionCount: 1 }]),
        describeSchema: vi.fn()
      });
      const provider = new SnsProvider(createSnsClientStub(), tempDir, createSsmClientStub(), { eventBridgeClient });

      const result = await provider.resolveContract(createSnsCandidate(), { serviceHints: ['orders-service'] });

      expect(result).toEqual(expect.objectContaining({ resolved: false }));
      expect(result.evidence.some((entry) => entry.includes('Skipped EventBridge-derived fallback'))).toBe(true);
      expect(eventBridgeClient.listRegistries).not.toHaveBeenCalled();
      expect(eventBridgeClient.listSchemas).not.toHaveBeenCalled();
      expect(eventBridgeClient.describeSchema).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses serviceHints for EventBridge schema name matching', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      const eventBridgeClient = createSchemasClientStub({
        listRegistries: vi.fn().mockResolvedValue([{ name: 'custom-registry', arn: 'arn:registry' }]),
        listSchemas: vi.fn().mockResolvedValue([
          { name: 'orders-service-events', arn: 'arn:schema:service', registryName: 'custom-registry', versionCount: 1 }
        ]),
        describeSchema: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            type: 'object',
            properties: {
              Message: { type: 'string' },
              MessageId: { type: 'string' },
              TopicArn: { type: 'string' },
              Type: { type: 'string' }
            }
          }),
          schemaVersion: '1'
        })
      });
      const provider = new SnsProvider(
        createSnsClientStub(),
        tempDir,
        createSsmClientStub(),
        { eventBridgeClient }
      );

      const result = await provider.resolveContract(
        createSnsCandidate({ name: 'billing-topic' }),
        {
          serviceHints: ['orders-service'],
          bridgeEvidence: ['Detected SNS/EventBridge bridge pattern in template.yaml']
        }
      );

      expect(result).toMatchObject({ resolved: true, origin: 'eventbridge-derived' });
      expect(eventBridgeClient.describeSchema).toHaveBeenCalledWith('custom-registry', 'orders-service-events');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('runs code-derived fallback only after eventbridge-derived fallback fails', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'publisher.ts'),
        [
          "import payloadSchema from './schemas/order-payload.json';",
          "const topicArn = 'arn:aws:sns:us-east-1:123456789012:orders-topic';",
          'await sns.send(new PublishCommand({',
          '  TopicArn: topicArn,',
          '  Message: JSON.stringify(payloadSchema)',
          '}));'
        ].join('\n'),
        'utf8'
      );
      await mkdir(path.join(tempDir, 'schemas'), { recursive: true });
      await writeFile(
        path.join(tempDir, 'schemas', 'order-payload.json'),
        JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' }, null, 2),
        'utf8'
      );
      const eventBridgeClient = createSchemasClientStub({
        listRegistries: vi.fn().mockResolvedValue([{ name: 'custom-registry', arn: 'arn:registry' }]),
        listSchemas: vi.fn().mockResolvedValue([{ name: 'orders-topic-events', arn: 'arn:schema', registryName: 'custom-registry', versionCount: 1 }]),
        describeSchema: vi.fn().mockRejectedValue(new Error('schema unavailable'))
      });
      const provider = new SnsProvider(createSnsClientStub(), tempDir, createSsmClientStub(), { eventBridgeClient });

      const result = await provider.resolveContract(createSnsCandidate(), {
        bridgeEvidence: ['Detected SNS/EventBridge bridge pattern in template.yaml']
      });

      expect(result).toMatchObject({ resolved: true, origin: 'code-derived' });
      expect(eventBridgeClient.describeSchema).toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('detects JS/TS JSON Schema references near SNS publisher calls as code-derived', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await mkdir(path.join(tempDir, 'src', 'schemas'), { recursive: true });
      await writeFile(
        path.join(tempDir, 'src', 'publisher.ts'),
        [
          "import payloadSchema from './schemas/order-payload.json';",
          "const topicArn = 'arn:aws:sns:us-east-1:123456789012:orders-topic';",
          'await sns.send(new PublishCommand({ TopicArn: topicArn, Message: JSON.stringify(payloadSchema) }));'
        ].join('\n'),
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'src', 'schemas', 'order-payload.json'),
        JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' }, null, 2),
        'utf8'
      );
      const provider = new SnsProvider(createSnsClientStub(), tempDir, createSsmClientStub());

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toMatchObject({ resolved: true, origin: 'code-derived' });
      if (result.resolved) {
        expect(result.result.format).toBe('json-schema');
        expect(result.result.content).toContain('"$schema"');
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects code-derived JSON schema imports that resolve outside repo-root', async () => {
    const parentDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-outside-parent-'));
    const tempDir = path.join(parentDir, 'repo');
    const outsideSchemaPath = path.join(parentDir, 'outside-schema.json');
    try {
      await mkdir(tempDir, { recursive: true });
      await writeFile(
        path.join(tempDir, 'publisher.ts'),
        [
          "import payloadSchema from '../outside-schema.json';",
          "const topicArn = 'arn:aws:sns:us-east-1:123456789012:orders-topic';",
          'await sns.send(new PublishCommand({ TopicArn: topicArn, Message: JSON.stringify(payloadSchema) }));'
        ].join('\n'),
        'utf8'
      );
      await writeFile(
        outsideSchemaPath,
        JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' }, null, 2),
        'utf8'
      );
      const provider = new SnsProvider(createSnsClientStub(), tempDir, createSsmClientStub());

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toEqual(expect.objectContaining({ resolved: false }));
      expect(result.evidence.some((line) => line.includes('resolves outside repo-root'))).toBe(true);
    } finally {
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  it('requires payload linkage for imported JSON schema candidates', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await mkdir(path.join(tempDir, 'schemas'), { recursive: true });
      await writeFile(
        path.join(tempDir, 'publisher.ts'),
        [
          "import payloadSchema from './schemas/order-payload.json';",
          "const topicArn = 'arn:aws:sns:us-east-1:123456789012:orders-topic';",
          'const eventPayload = { id: "1" };',
          'await sns.send(new PublishCommand({ TopicArn: topicArn, Message: JSON.stringify(eventPayload) }));'
        ].join('\n'),
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'schemas', 'order-payload.json'),
        JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' }, null, 2),
        'utf8'
      );
      const provider = new SnsProvider(createSnsClientStub(), tempDir, createSsmClientStub());

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toEqual(expect.objectContaining({ resolved: false }));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('detects Zod schemas tied to SNS topic constants as code-derived', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'publisher.ts'),
        [
          "import { z } from 'zod';",
          "const topicArn = 'arn:aws:sns:us-east-1:123456789012:orders-topic';",
          'const OrderEvent = z.object({ orderId: z.string() });',
          'await sns.send(new PublishCommand({ TopicArn: topicArn, Message: JSON.stringify(OrderEvent.parse(event)) }));'
        ].join('\n'),
        'utf8'
      );
      const provider = new SnsProvider(createSnsClientStub(), tempDir, createSsmClientStub());

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toMatchObject({ resolved: true, origin: 'code-derived' });
      if (result.resolved) {
        expect(result.result.content).toContain('zod');
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('detects TypeBox schemas tied to SNS topic constants as code-derived', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'publisher.ts'),
        [
          "import { Type } from '@sinclair/typebox';",
          "const topicArn = 'arn:aws:sns:us-east-1:123456789012:orders-topic';",
          'const OrderEvent = Type.Object({ orderId: Type.String() });',
          'await sns.publish({ TopicArn: topicArn, Message: JSON.stringify(OrderEvent) });'
        ].join('\n'),
        'utf8'
      );
      const provider = new SnsProvider(createSnsClientStub(), tempDir, createSsmClientStub());

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toMatchObject({ resolved: true, origin: 'code-derived' });
      if (result.resolved) {
        expect(result.result.content).toContain('typebox');
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('detects Springwolf AsyncAPI artifacts as code-derived', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await mkdir(path.join(tempDir, 'target', 'springwolf'), { recursive: true });
      await writeFile(
        path.join(tempDir, 'target', 'springwolf', 'asyncapi.json'),
        JSON.stringify({ asyncapi: '2.6.0', channels: {} }, null, 2),
        'utf8'
      );
      const provider = new SnsProvider(createSnsClientStub(), tempDir, createSsmClientStub());

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toMatchObject({ resolved: true, origin: 'code-derived' });
      if (result.resolved) {
        expect(result.result.format).toBe('asyncapi-json');
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('accepts Java SNS publish annotations only when topic and payload are statically recoverable', async () => {
    const acceptedDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    const rejectedDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(
        path.join(acceptedDir, 'Publisher.java'),
        [
          '@SnsPublish(topicName = "orders-topic", payloadType = OrderEvent.class)',
          'class Publisher {}'
        ].join('\n'),
        'utf8'
      );
      await writeFile(
        path.join(rejectedDir, 'Publisher.java'),
        [
          '@SnsPublish(topicName = "${topicName}", payloadType = OrderEvent.class)',
          'class Publisher {}'
        ].join('\n'),
        'utf8'
      );
      const acceptedProvider = new SnsProvider(createSnsClientStub(), acceptedDir, createSsmClientStub());
      const rejectedProvider = new SnsProvider(createSnsClientStub(), rejectedDir, createSsmClientStub());

      const acceptedResult = await acceptedProvider.resolveContract(createSnsCandidate());
      const rejectedResult = await rejectedProvider.resolveContract(createSnsCandidate());

      expect(acceptedResult).toMatchObject({ resolved: true, origin: 'code-derived' });
      expect(rejectedResult).toEqual(expect.objectContaining({ resolved: false }));
    } finally {
      await rm(acceptedDir, { recursive: true, force: true });
      await rm(rejectedDir, { recursive: true, force: true });
    }
  });

  it('does not infer code-derived contracts from unlinked DTOs or business logic', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'OrderEvent.ts'),
        [
          'export interface OrderEvent {',
          '  orderId: string;',
          '  amount: number;',
          '}'
        ].join('\n'),
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'publisher.ts'),
        [
          "const topicArn = 'arn:aws:sns:us-east-1:123456789012:orders-topic';",
          'const payload = { orderId, amount };',
          'await sns.publish({ TopicArn: topicArn, Message: JSON.stringify(payload) });'
        ].join('\n'),
        'utf8'
      );
      const provider = new SnsProvider(createSnsClientStub(), tempDir, createSsmClientStub());

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toEqual(expect.objectContaining({ resolved: false }));
      expect(result.evidence.some((line) => line.includes('manual review'))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns manual-review when multiple code-derived candidates are ambiguous', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sns-provider-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'publisher-one.ts'),
        [
          "import { z } from 'zod';",
          "const topicArn = 'arn:aws:sns:us-east-1:123456789012:orders-topic';",
          'const SchemaOne = z.object({ orderId: z.string() });',
          'await sns.publish({ TopicArn: topicArn, Message: JSON.stringify(SchemaOne.parse(event)) });'
        ].join('\n'),
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'publisher-two.ts'),
        [
          "import { z } from 'zod';",
          "const topicArn = 'arn:aws:sns:us-east-1:123456789012:orders-topic';",
          'const SchemaTwo = z.object({ id: z.string() });',
          'await sns.publish({ TopicArn: topicArn, Message: JSON.stringify(SchemaTwo.parse(event)) });'
        ].join('\n'),
        'utf8'
      );
      const provider = new SnsProvider(createSnsClientStub(), tempDir, createSsmClientStub());

      const result = await provider.resolveContract(createSnsCandidate());

      expect(result).toEqual(expect.objectContaining({ resolved: false }));
      expect(result.evidence.some((line) => line.includes('Ambiguous code-derived candidates'))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('SnsSdkClient', () => {
  it('probe succeeds', async () => {
    snsSendMock.mockReset();
    snsSendMock.mockResolvedValueOnce({ Topics: [] });
    const client = new SnsSdkClient('us-east-1');

    await expect(client.probe()).resolves.toBe(true);
    expect(snsSendMock).toHaveBeenCalledTimes(1);
    expect(snsSendMock.mock.calls[0]?.[0]).toBeInstanceOf(ListTopicsCommand);
    expect((snsSendMock.mock.calls[0]?.[0] as ListTopicsCommand).input).toEqual({});
  });

  it('probe fails gracefully for IAM denial', async () => {
    snsSendMock.mockReset();
    snsSendMock.mockRejectedValueOnce(new Error('AccessDeniedException'));
    const client = new SnsSdkClient('us-east-1');

    await expect(client.probe()).resolves.toBe(false);
  });

  it('probe handles network failure', async () => {
    snsSendMock.mockReset();
    snsSendMock.mockRejectedValueOnce(new Error('ENOTFOUND sns.us-east-1.amazonaws.com'));
    const client = new SnsSdkClient('us-east-1');

    await expect(client.probe()).resolves.toBe(false);
  });

  it('listTopics returns topics across pages', async () => {
    snsSendMock.mockReset();
    snsSendMock
      .mockResolvedValueOnce({
        Topics: [{ TopicArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic' }],
        NextToken: 'next-1'
      })
      .mockResolvedValueOnce({
        Topics: [{ TopicArn: 'arn:aws:sns:us-east-1:123456789012:billing-topic.fifo' }]
      });
    const client = new SnsSdkClient('us-east-1');

    await expect(client.listTopics()).resolves.toEqual([
      { topicArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic', name: 'orders-topic' },
      { topicArn: 'arn:aws:sns:us-east-1:123456789012:billing-topic.fifo', name: 'billing-topic.fifo' }
    ]);
    expect(snsSendMock).toHaveBeenCalledTimes(2);
    expect((snsSendMock.mock.calls[0]?.[0] as ListTopicsCommand).input).toEqual({ NextToken: undefined });
    expect((snsSendMock.mock.calls[1]?.[0] as ListTopicsCommand).input).toEqual({ NextToken: 'next-1' });
  });

  it('getTopicAttributes returns attributes', async () => {
    snsSendMock.mockReset();
    snsSendMock.mockResolvedValueOnce({
      Attributes: {
        DisplayName: 'Orders Topic',
        Policy: '{"Version":"2012-10-17"}'
      }
    });
    const client = new SnsSdkClient('us-east-1');

    await expect(client.getTopicAttributes('arn:aws:sns:us-east-1:123456789012:orders-topic')).resolves.toEqual({
      DisplayName: 'Orders Topic',
      Policy: '{"Version":"2012-10-17"}'
    });
    expect((snsSendMock.mock.calls[0]?.[0] as GetTopicAttributesCommand).input).toEqual({
      TopicArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic'
    });
  });

  it('listTagsForResource returns tags', async () => {
    snsSendMock.mockReset();
    snsSendMock.mockResolvedValueOnce({
      Tags: [
        { Key: 'environment', Value: 'prod' },
        { Key: 'team', Value: 'platform' }
      ]
    });
    const client = new SnsSdkClient('us-east-1');

    await expect(client.listTagsForResource('arn:aws:sns:us-east-1:123456789012:orders-topic')).resolves.toEqual({
      environment: 'prod',
      team: 'platform'
    });
    expect((snsSendMock.mock.calls[0]?.[0] as ListTagsForResourceCommand).input).toEqual({
      ResourceArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic'
    });
  });

  it('listSubscriptionsByTopic returns subscriptions across pages', async () => {
    snsSendMock.mockReset();
    snsSendMock
      .mockResolvedValueOnce({
        Subscriptions: [
          {
            SubscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-1',
            Protocol: 'sqs',
            Endpoint: 'arn:aws:sqs:us-east-1:123456789012:orders-queue',
            TopicArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic',
            Owner: '123456789012'
          }
        ],
        NextToken: 'next-1'
      })
      .mockResolvedValueOnce({
        Subscriptions: [
          {
            SubscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-2',
            Protocol: 'lambda',
            Endpoint: 'arn:aws:lambda:us-east-1:123456789012:function:orders-handler',
            TopicArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic',
            Owner: '123456789012'
          }
        ]
      });
    const client = new SnsSdkClient('us-east-1');
    const topicArn = 'arn:aws:sns:us-east-1:123456789012:orders-topic';

    await expect(client.listSubscriptionsByTopic(topicArn)).resolves.toEqual([
      {
        subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-1',
        protocol: 'sqs',
        endpoint: 'arn:aws:sqs:us-east-1:123456789012:orders-queue',
        topicArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic',
        owner: '123456789012'
      },
      {
        subscriptionArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-2',
        protocol: 'lambda',
        endpoint: 'arn:aws:lambda:us-east-1:123456789012:function:orders-handler',
        topicArn: 'arn:aws:sns:us-east-1:123456789012:orders-topic',
        owner: '123456789012'
      }
    ]);
    expect(snsSendMock).toHaveBeenCalledTimes(2);
    expect((snsSendMock.mock.calls[0]?.[0] as ListSubscriptionsByTopicCommand).input).toEqual({
      TopicArn: topicArn,
      NextToken: undefined
    });
    expect((snsSendMock.mock.calls[1]?.[0] as ListSubscriptionsByTopicCommand).input).toEqual({
      TopicArn: topicArn,
      NextToken: 'next-1'
    });
  });

  it('getSubscriptionAttributes returns full attributes map', async () => {
    snsSendMock.mockReset();
    snsSendMock.mockResolvedValueOnce({
      Attributes: {
        RawMessageDelivery: 'true',
        FilterPolicyScope: 'MessageBody'
      }
    });
    const client = new SnsSdkClient('us-east-1');
    const subscriptionArn = 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-1';

    await expect(client.getSubscriptionAttributes(subscriptionArn)).resolves.toEqual({
      RawMessageDelivery: 'true',
      FilterPolicyScope: 'MessageBody'
    });
    expect((snsSendMock.mock.calls[0]?.[0] as GetSubscriptionAttributesCommand).input).toEqual({
      SubscriptionArn: subscriptionArn
    });
  });

  it('subscription reads handle AccessDeniedException gracefully', async () => {
    snsSendMock.mockReset();
    snsSendMock.mockRejectedValueOnce(Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' }));
    snsSendMock.mockRejectedValueOnce(Object.assign(new Error('not authorized'), { __type: 'AccessDeniedException' }));
    const client = new SnsSdkClient('us-east-1');
    const topicArn = 'arn:aws:sns:us-east-1:123456789012:orders-topic';
    const subscriptionArn = 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-1';

    await expect(client.listSubscriptionsByTopic(topicArn)).resolves.toEqual([]);
    await expect(client.getSubscriptionAttributes(subscriptionArn)).resolves.toEqual({});
  });

  it('subscription reads handle AuthorizationErrorException gracefully', async () => {
    snsSendMock.mockReset();
    snsSendMock.mockRejectedValueOnce(Object.assign(new Error('missing permission'), { name: 'AuthorizationErrorException' }));
    snsSendMock.mockRejectedValueOnce(Object.assign(new Error('missing permission'), { __type: 'AuthorizationErrorException' }));
    const client = new SnsSdkClient('us-east-1');
    const topicArn = 'arn:aws:sns:us-east-1:123456789012:orders-topic';
    const subscriptionArn = 'arn:aws:sns:us-east-1:123456789012:orders-topic:sub-1';

    await expect(client.listSubscriptionsByTopic(topicArn)).resolves.toEqual([]);
    await expect(client.getSubscriptionAttributes(subscriptionArn)).resolves.toEqual({});
  });
});

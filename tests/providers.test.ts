import { describe, expect, it, vi } from 'vitest';

import { ProviderRegistry } from '../src/lib/providers/registry.js';
import { ApiGatewayProvider } from '../src/lib/providers/api-gateway.js';
import { AppSyncProvider } from '../src/lib/providers/appsync.js';
import { EventBridgeSchemasProvider } from '../src/lib/providers/eventbridge-schemas.js';
import { CloudFormationProvider } from '../src/lib/providers/cloudformation.js';
import { GlueSchemaProvider } from '../src/lib/providers/glue.js';
import type { AwsGatewayClient } from '../src/lib/aws/client.js';
import type { AppSyncSpecClient } from '../src/lib/aws/appsync-client.js';
import type { EventBridgeSchemasSpecClient } from '../src/lib/aws/schemas-client.js';
import type { CloudFormationSpecClient } from '../src/lib/aws/cloudformation-client.js';
import type { GlueSchemaSpecClient } from '../src/lib/aws/glue-client.js';

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
  it('lists REST and HTTP candidates including WebSocket', async () => {
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
    expect(result.format).toBe('json-schema');
    expect(result.filename).toBe('index.json');
    expect(result.content).toContain('openapi');
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
    ).rejects.toThrow(/No embedded OpenAPI spec/);
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

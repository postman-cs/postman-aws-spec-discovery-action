import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  actionContract,
  contractInputNames,
  contractOutputNames,
  type DiscoveredService,
  type ResolutionResult
} from '../src/contracts.js';
import { resolveInputs } from '../src/index.js';

const repoRoot = resolve(import.meta.dirname, '..');
const contractsSource = readFileSync(resolve(repoRoot, 'src/contracts.ts'), 'utf8');
const actionManifest = parse(
  readFileSync(resolve(repoRoot, 'action.yml'), 'utf8')
) as {
  inputs: Record<string, { required?: boolean; default?: string }>;
  outputs: Record<string, unknown>;
};

describe('action contract', () => {
  const expectedExistingInputRequirements = {
    'aws-region': true,
    'gateway-id': false,
    stage: false,
    'output-dir': false
  } as const;
  const expectedExistingOutputDescriptions = {
    'resolution-json': 'JSON resolution result describing status, source type, confidence, and evidence.',
    'resolution-status': 'Resolution status: resolved or unresolved.',
    'source-type':
      'Resolved source type: repo-spec, gateway-export, appsync-schema, eventbridge-schema, cfn-embedded, glue-schema, sns-contract, ssm-registry, lambda-url-export, manual-review, or discover-many.',
    'mapping-confidence': 'Numeric confidence score for selected service candidate.',
    'spec-path': 'Path to resolved or generated specification when available.',
    'gateway-id': 'Resolved API Gateway ID when available.',
    'service-name': 'Resolved service name.',
    'services-json': 'Legacy discover-many output: JSON array of exported services.',
    'service-count': 'Legacy discover-many output: number of exported services.',
    'export-summary-json': 'discover-many summary JSON containing attempted, exported, failed, and skipped counts.',
    'candidates-json':
      'JSON array of top candidates when resolution is ambiguous. Useful for downstream decision-making or Job Summary rendering.',
    'provider-type':
      'Provider that resolved the spec: api-gateway, appsync, eventbridge-schemas, cloudformation, glue, sns, ssm, or lambda-url.',
    'spec-format':
      'Format of the resolved spec: openapi-yaml, openapi-json, graphql-sdl, asyncapi-yaml, asyncapi-json, json-schema, postman-collection, smithy, avro, or protobuf.'
  } as const;

  it('keeps action.yml aligned with declared contract', () => {
    expect(Object.keys(actionManifest.inputs)).toEqual(contractInputNames);
    expect(Object.keys(actionManifest.outputs)).toEqual(contractOutputNames);
  });

  it('keeps existing required inputs unchanged and introduces no new required inputs', () => {
    expect(Object.keys(actionContract.inputs)).toEqual(Object.keys(expectedExistingInputRequirements));
    for (const [inputName, isRequired] of Object.entries(expectedExistingInputRequirements)) {
      expect(actionContract.inputs[inputName]?.required).toBe(isRequired);
      expect(actionManifest.inputs[inputName]?.required).toBe(isRequired);
    }
    expect(Object.values(actionContract.inputs).filter((input) => input.required)).toHaveLength(1);
  });

  it('keeps existing output descriptions unchanged while adding SNS metadata outputs', () => {
    for (const [outputName, description] of Object.entries(expectedExistingOutputDescriptions)) {
      expect(actionContract.outputs[outputName]?.description).toBe(description);
      expect((actionManifest.outputs as Record<string, { description: string }>)[outputName]?.description.length).toBeGreaterThan(0);
    }
  });

  it('keeps expected defaults for optional inputs', () => {
    expect(actionContract.inputs['gateway-id'].default).toBe('');
    expect(actionContract.inputs['output-dir'].default).toBe('discovered-specs');
    expect(actionManifest.inputs['gateway-id'].default).toBe('');
    expect(actionManifest.inputs['output-dir'].default).toBe('discovered-specs');
  });

  it('parses simple and advanced env-driven values', () => {
    const parsed = resolveInputs({
      INPUT_AWS_REGION: 'us-east-1',
      INPUT_MODE: 'discover-many',
      INPUT_GATEWAY_ID: 'abc123def0',
      INPUT_INCLUDE_V2: 'false',
      INPUT_SERVICE_MAPPING_JSON: '{"a1":"payments"}',
      INPUT_OUTPUT_DIR: 'custom-dir',
      INPUT_EXPECTED_GATEWAY_IDS_JSON: '["def456ghi7"]',
      INPUT_REPO_ROOT: '.'
    });

    expect(parsed.awsRegion).toBe('us-east-1');
    expect(parsed.mode).toBe('discover-many');
    expect(parsed.includeV2).toBe(false);
    expect(parsed.serviceMapping).toEqual({ a1: 'payments' });
    expect(parsed.expectedGatewayIds).toEqual(['abc123def0', 'def456ghi7']);
    expect(parsed.outputDir).toBe('custom-dir');
  });

  it('supports sns values in type unions', () => {
    expect(contractsSource).toContain("| 'sns'");
    expect(contractsSource).toContain("| 'sns-contract'");
    expect(contractsSource).toContain("| 'asyncapi-yaml'");
    expect(contractsSource).toContain("| 'asyncapi-json'");
  });

  it('includes sns values in output descriptions', () => {
    expect(actionContract.outputs['provider-type'].description).toContain('sns');
    expect(actionContract.outputs['source-type'].description).toContain('sns-contract');
    expect(actionContract.outputs['spec-format'].description).toContain('asyncapi-yaml');
    expect(actionContract.outputs['spec-format'].description).toContain('asyncapi-json');

    const actionOutputs = actionManifest.outputs as Record<string, { description: string }>;
    expect(actionOutputs['provider-type'].description).toContain('sns');
    expect(actionOutputs['source-type'].description).toContain('sns-contract');
    expect(actionOutputs['spec-format'].description).toContain('asyncapi-yaml');
    expect(actionOutputs['spec-format'].description).toContain('asyncapi-json');
    expect(actionOutputs['contract-origin'].description).toContain('ssm-content');
    expect(actionOutputs['contract-metadata-path'].description.length).toBeGreaterThan(0);
    expect(actionOutputs['variant-count'].description.length).toBeGreaterThan(0);
  });

  it('typechecks discovered service and resolution result for sns', () => {
    const discoveredService = {
      serviceName: 'orders-topic',
      specPath: 'discovered-specs/orders-topic/asyncapi.yaml',
      gatewayId: 'arn:aws:sns:us-east-1:123456789012:orders-topic',
      gatewayType: 'SNS',
      stage: '',
      providerType: 'sns',
      specFormat: 'asyncapi-yaml',
      contractOrigin: 'repo-asyncapi',
      metadataPath: 'discovered-specs/orders-topic/sns-resolution-metadata.json',
      variantCount: 2
    } satisfies DiscoveredService;

    const resolution = {
      status: 'resolved',
      sourceType: 'sns-contract',
      serviceName: 'orders-topic',
      confidence: 100,
      gatewayId: 'arn:aws:sns:us-east-1:123456789012:orders-topic',
      gatewayType: 'SNS',
      providerType: 'sns',
      specFormat: 'asyncapi-yaml',
      contractOrigin: 'repo-asyncapi',
      metadataPath: 'discovered-specs/orders-topic/sns-resolution-metadata.json',
      variantCount: 2,
      evidence: ['Resolved SNS contract']
    } satisfies ResolutionResult;

    expect(discoveredService.providerType).toBe('sns');
    expect(resolution.providerType).toBe('sns');
    expect(resolution.specFormat).toBe('asyncapi-yaml');
  });
});

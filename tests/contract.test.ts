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
const readmeSource = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
const providersSource = readFileSync(resolve(repoRoot, 'docs/providers.md'), 'utf8');
const liveRunbookSource = readFileSync(resolve(repoRoot, 'docs/LIVE_TESTING_RUNBOOK.md'), 'utf8');
const securitySource = readFileSync(resolve(repoRoot, 'SECURITY.md'), 'utf8');
const supportSource = readFileSync(resolve(repoRoot, 'SUPPORT.md'), 'utf8');
const releasePolicySource = readFileSync(resolve(repoRoot, 'RELEASE_POLICY.md'), 'utf8');
const marketplaceDocs = [
  readmeSource,
  providersSource,
  liveRunbookSource,
  securitySource,
  supportSource,
  releasePolicySource
].join('\n');
const actionManifest = parse(
  readFileSync(resolve(repoRoot, 'action.yml'), 'utf8')
) as {
  description: string;
  inputs: Record<string, { required?: boolean; default?: string }>;
  outputs: Record<string, unknown>;
};

describe('action contract', () => {
  const expectedExistingInputRequirements = {
    'aws-region': true,
    'gateway-id': false,
    stage: false,
    'expected-account-id': false,
    'expected-partition': false,
    'expected-region': false,
    'spec-path': false,
    'service-root': false,
    'remote-fetch-allowlist-json': false,
    'terraform-state-paths-json': false,
    'output-dir': false,
    'postman-api-key': false,
    'postman-access-token': false
  } as const;
  const expectedExistingOutputDescriptions = {
    'resolution-json': 'JSON resolution result describing status, source type, confidence, and evidence.',
    'resolution-status': 'Resolution status: resolved or unresolved.',
    'source-type':
      'Resolved source type: repo-spec, gateway-export, appsync-schema, appsync-event-api, eventbridge-schema, eventbridge-surface, cfn-embedded, glue-schema, bedrock-action-group, alb-listener-rule, sns-contract, ssm-registry, lambda-url-export, lambda-event-source, verified-permissions-schema, step-functions-asl, manual-review, or discover-many.',
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
      'Provider that resolved the spec: api-gateway, appsync, appsync-events, eventbridge-schemas, eventbridge, cloudformation, glue, bedrock-action-group, alb-listener-rule, sns, ssm, lambda-url, lambda-event-source, verified-permissions, or step-functions.',
    'spec-format':
      'Format of the resolved spec: openapi-yaml, openapi-json, graphql-sdl, asyncapi-yaml, asyncapi-json, json-schema, postman-collection, smithy, avro, or protobuf.'
  } as const;
  const expectedDerivedOpenApiOutputs = [
    'derived-openapi-path',
    'derived-openapi-version',
    'derived-openapi-completeness',
    'derived-openapi-format',
    'derived-openapi-evidence-json'
  ];

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
    expect(actionContract.inputs['expected-account-id'].default).toBe('');
    expect(actionContract.inputs['expected-partition'].default).toBe('');
    expect(actionContract.inputs['spec-path'].default).toBe('');
    expect(actionContract.inputs['service-root'].default).toBe('');
    expect(actionContract.inputs['remote-fetch-allowlist-json'].default).toBe('');
    expect(actionContract.inputs['terraform-state-paths-json'].default).toBe('[]');
    expect(actionContract.inputs['output-dir'].default).toBe('discovered-specs');
    expect(actionManifest.inputs['gateway-id'].default).toBe('');
    expect(actionManifest.inputs['expected-account-id'].default).toBe('');
    expect(actionManifest.inputs['expected-partition'].default).toBe('');
    expect(actionManifest.inputs['spec-path'].default).toBe('');
    expect(actionManifest.inputs['service-root'].default).toBe('');
    expect(actionManifest.inputs['remote-fetch-allowlist-json'].default).toBe('');
    expect(actionManifest.inputs['terraform-state-paths-json'].default).toBe('[]');
    expect(actionManifest.inputs['output-dir'].default).toBe('discovered-specs');
  });

  it('parses terraform-state-paths-json as an explicit path array', () => {
    const parsed = resolveInputs({
      INPUT_AWS_REGION: 'us-east-1',
      INPUT_REPO_ROOT: '.',
      INPUT_TERRAFORM_STATE_PATHS_JSON: JSON.stringify(['terraform.tfstate', 'env/prod.tfstate'])
    });
    expect(parsed.terraformStatePaths).toEqual(['terraform.tfstate', 'env/prod.tfstate']);
    const empty = resolveInputs({
      INPUT_AWS_REGION: 'us-east-1',
      INPUT_REPO_ROOT: '.'
    });
    expect(empty.terraformStatePaths).toEqual([]);
    expect(() =>
      resolveInputs({
        INPUT_AWS_REGION: 'us-east-1',
        INPUT_REPO_ROOT: '.',
        INPUT_TERRAFORM_STATE_PATHS_JSON: '{"path":"terraform.tfstate"}'
      })
    ).toThrow(/terraform-state-paths-json must be a JSON array/);
  });

  it('parses explicit selectors and remote-fetch allowlist policy', () => {
    const parsed = resolveInputs({
      INPUT_AWS_REGION: 'us-east-1',
      INPUT_REPO_ROOT: '.',
      INPUT_SPEC_PATH: 'openapi.yaml',
      INPUT_SERVICE_ROOT: 'packages/orders',
      INPUT_REMOTE_FETCH_ALLOWLIST_JSON: JSON.stringify([
        { host: 'specs.example.com', path: '/catalog/' },
        { hostname: 'backstage.example.com', pathPrefix: '/api/' }
      ])
    });
    expect(parsed.specPath).toBe('openapi.yaml');
    expect(parsed.serviceRoot).toBe('packages/orders');
    expect(parsed.remoteFetchPolicy).toMatchObject({
      enabled: true,
      allowlist: [
        { hostname: 'specs.example.com', pathPrefix: '/catalog/' },
        { hostname: 'backstage.example.com', pathPrefix: '/api/' }
      ]
    });
  });

  it('rejects path traversal for explicit selectors', () => {
    expect(() =>
      resolveInputs({
        INPUT_AWS_REGION: 'us-east-1',
        INPUT_REPO_ROOT: '.',
        INPUT_SPEC_PATH: '../outside.yaml'
      })
    ).toThrow(/spec-path/);
    expect(() =>
      resolveInputs({
        INPUT_AWS_REGION: 'us-east-1',
        INPUT_REPO_ROOT: '.',
        INPUT_SERVICE_ROOT: '../outside'
      })
    ).toThrow(/service-root/);
  });

  it('keeps marketplace docs centered on action selection, region, and Postman handoff', () => {
    expect(actionManifest.description).toContain('Postman onboarding');
    expect((actionManifest.inputs['aws-region'] as { description: string }).description).toContain('AWS region');
    expect((actionManifest.inputs['aws-region'] as { description: string }).description).toContain('discovery providers');
    expect(actionContract.inputs['aws-region']?.description).toBe(
      (actionManifest.inputs['aws-region'] as { description: string }).description
    );
    expect(actionContract.inputs['aws-region']?.description).toContain('AppSync');
    expect(actionContract.inputs['aws-region']?.description).toContain('EventBridge');
    expect(readmeSource).toContain('Postman API Onboarding suite');
    expect(readmeSource).toContain('## Region and Postman handoff');
    expect(readmeSource).toContain('postman-cs/postman-resolve-service-token-action@v2');
    expect(readmeSource).toContain('postman-cs/postman-api-onboarding-action@v2');
    expect(readmeSource).toContain('postman-cs/postman-bootstrap-action@v2');
    expect(readmeSource).toContain('postman-access-token: ${{ steps.postman_token.outputs.token }}');
    expect(readmeSource).toContain('postman-team-id: ${{ steps.postman_token.outputs.team-id }}');
    expect(readmeSource).toContain('credential-preflight: warn');
    expect(readmeSource).toContain('credential-preflight: enforce');
  });

  it('documents OIDC IAM setup and avoids placeholder spec URLs in paste-runnable examples', () => {
    const publicFixtureUrl = 'https://raw.githubusercontent.com/postman-cs/postman-aws-spec-discovery-action/main/examples/core-payments-openapi.yaml';

    expect(readmeSource).toContain('id-token: write');
    expect(providersSource).toContain('sts:AssumeRoleWithWebIdentity');
    expect(providersSource).toContain('token.actions.githubusercontent.com:sub');
    expect(providersSource).toContain(publicFixtureUrl);
    expect(liveRunbookSource).toContain('[Provider Discovery](providers.md#security-and-iam)');
    expect(providersSource).not.toContain('payments.example.com/openapi');
    expect(providersSource).not.toContain('api.example.com/openapi');
  });

  it('keeps credential docs on the service-token path with no public preflight opt-out', () => {
    expect(securitySource).toContain('postman-resolve-service-token-action');
    expect(securitySource).toContain('Postman CLI credential store created by `postman login`');
    expect(marketplaceDocs).toContain('Downstream Postman credential preflight accepts `warn` and `enforce`');
    expect(marketplaceDocs).not.toMatch(/credential-preflight[^.\n]*(off|disable|skip)/i);
    expect(marketplaceDocs).not.toMatch(/browser[- ]token/i);
    expect(marketplaceDocs).not.toMatch(/\bcustomer preview\b/i);
    expect(marketplaceDocs).not.toMatch(/\binternal\b/i);
  });

  it('publishes support, security, and release policy guidance for the standalone listing', () => {
    expect(readmeSource).toContain('[SUPPORT.md](SUPPORT.md)');
    expect(readmeSource).toContain('[SECURITY.md](SECURITY.md)');
    expect(readmeSource).toContain('[RELEASE_POLICY.md](RELEASE_POLICY.md)');
    expect(supportSource).toContain('What to include');
    expect(supportSource).toContain('providerProbes');
    expect(supportSource).toMatch(/typed reason \(denial, error, or timeout\)/);
    expect(supportSource).not.toMatch(/silently skips providers/i);
    expect(securitySource).toContain('Credential Matrix');
    expect(releasePolicySource).toContain('Release checks');
    expect(releasePolicySource).toContain('Git tags and GitHub releases are the public release identifiers');
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
    expect(contractsSource).toContain("| 'lambda-url'");
    expect(contractsSource).toContain("| 'lambda-url-export'");
    expect(contractsSource).toContain("| 'LAMBDA_URL'");
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
    expect(actionOutputs['provider-type'].description).toContain('lambda-url');
    expect(actionOutputs['source-type'].description).toContain('lambda-url-export');
  });

  it('declares additive derived OpenAPI outputs in the contract and action manifest', () => {
    for (const outputName of expectedDerivedOpenApiOutputs) {
      expect(actionContract.outputs[outputName]?.description.length).toBeGreaterThan(0);
      expect((actionManifest.outputs as Record<string, { description: string }>)[outputName]?.description.length).toBeGreaterThan(0);
      expect(readmeSource).toContain(`\`${outputName}\``);
    }
  });

  it('typechecks discovered service and resolution result for lambda-url', () => {
    const discoveredService = {
      serviceName: 'orders-api',
      specPath: 'discovered-specs/orders-api/index.yaml',
      gatewayId: 'orders-fn',
      gatewayType: 'LAMBDA_URL',
      stage: '',
      providerType: 'lambda-url',
      specFormat: 'openapi-yaml',
      derivedOpenApiPath: 'discovered-specs/orders-api/openapi.derived.json',
      derivedOpenApiVersion: '3.0.3',
      derivedOpenApiCompleteness: 'partial',
      derivedOpenApiFormat: 'openapi-json',
      derivedOpenApiEvidence: ['Synthesized Lambda Function URL catch-all OpenAPI sidecar']
    } satisfies DiscoveredService;

    const resolution = {
      status: 'resolved',
      sourceType: 'lambda-url-export',
      serviceName: 'orders-api',
      confidence: 90,
      specPath: 'discovered-specs/orders-api/index.yaml',
      gatewayId: 'orders-fn',
      gatewayType: 'LAMBDA_URL',
      providerType: 'lambda-url',
      specFormat: 'openapi-yaml',
      derivedOpenApiPath: 'discovered-specs/orders-api/openapi.derived.json',
      derivedOpenApiVersion: '3.0.3',
      derivedOpenApiCompleteness: 'partial',
      derivedOpenApiFormat: 'openapi-json',
      derivedOpenApiEvidence: ['Synthesized Lambda Function URL catch-all OpenAPI sidecar'],
      evidence: ['Resolved Lambda Function URL']
    } satisfies ResolutionResult;

    expect(discoveredService.providerType).toBe('lambda-url');
    expect(resolution.sourceType).toBe('lambda-url-export');
    expect(resolution.derivedOpenApiFormat).toBe('openapi-json');
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

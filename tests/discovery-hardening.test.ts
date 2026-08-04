import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { parseCliArgs, toDotenv } from '../src/cli.js';
import { detectCatalogApis } from '../src/lib/repo/catalog.js';
import { findExistingRepoSpec, findExistingRepoSpecTyped } from '../src/lib/repo/specs.js';
import { collectRepoSignals } from '../src/lib/repo/signals.js';
import { resolveServiceCandidate } from '../src/lib/resolve/service-resolver.js';
import { chooseSource } from '../src/lib/resolve/source-selector.js';
import { ProviderRegistry } from '../src/lib/providers/registry.js';
import type { SpecProvider } from '../src/lib/providers/types.js';
import { buildExecutionOutputs, runResolution } from '../src/runtime.js';
import { createAwsClientStub, createCoreStub } from './helpers/discovery-fixtures.js';

describe('hardening helpers', () => {
  it('marks equal-confidence candidates as ambiguous', () => {
    const candidate = resolveServiceCandidate(
      [
        { id: 'aaaaabbbbb', name: 'payments-api', gatewayType: 'REST', tags: {} },
        { id: 'ccccdddddd', name: 'payments-api-copy', gatewayType: 'REST', tags: {} }
      ],
      {
        serviceHints: ['payments'],
        explicitGatewayIdHints: [],
        inferredGatewayIdHints: [],
        evidence: []
      }
    );

    expect(candidate?.ambiguous).toBe(true);
  });

  it('routes ambiguous candidates to manual review', () => {
    const result = chooseSource({
      fallbackServiceName: 'payments',
      candidate: {
        serviceName: 'payments',
        gatewayId: 'aaaaabbbbb',
        gatewayType: 'REST',
        confidence: 50,
        ambiguous: true,
        evidence: ['ambiguous']
      }
    });

    expect(result.status).toBe('unresolved');
    expect(result.sourceType).toBe('manual-review');
  });

  it('U1.7 cap-after-partition: 250 candidates narrow to one-candidate intersection then cap keeps 1+49 prefix', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-cap-partition-'));
    try {
      const enumerated = Array.from({ length: 249 }, (_, index) => ({ id: `rest-${String(index + 1).padStart(3, '0')}`, name: `unrelated-${index + 1}` }));
      enumerated.splice(120, 0, { id: 'rest-payments', name: 'payments-api' });
      expect(enumerated).toHaveLength(250);
      const taggedIds: string[] = [];
      const aws = createAwsClientStub({
        listRestApis: vi.fn().mockResolvedValue(enumerated),
        getRestTags: vi.fn().mockImplementation(async (id: string) => {
          taggedIds.push(id);
          return {};
        })
      });
      const { core, infos, warnings } = createCoreStub();
      const resolution = await runResolution(
        {
          mode: 'resolve-one',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'github', repoSlug: 'org/payments' },
          expectedServiceName: 'payments',
          expectedGatewayIds: [],
          stage: undefined,
          apiFilter: undefined,
          serviceMapping: {},
          outputDir: 'discovered-specs',
          maxCandidates: 50,
          dryRun: true,
          preflightChecks: false,
          preflightPermissionProbe: false,
          requestTimeoutMs: 30000,
          maxAttempts: 3,
          includeV2: false
        },
        aws,
        core,
        vi.fn().mockResolvedValue(undefined),
        { narrowingClients: {} }
      );

      // Narrowing saw the FULL 250 (no pre-partition cap) and demoted 249, not deleted.
      expect(infos.join(' ')).toContain('ranked 1 of 250 candidates first and demoted 249 (not deleted)');
      // Cap runs only after partitioning: warning fired, exactly 50 survive.
      expect(warnings.join(' ')).toContain('250 candidates after narrowing still exceeds limit (50). Using top 50');
      expect(taggedIds).toHaveLength(50);
      // Prefix composition: intersecting candidate first, then exactly 49 remainders in enumeration order.
      expect(taggedIds[0]).toBe('rest-payments');
      const expectedRemainder = enumerated.filter((candidate) => candidate.id !== 'rest-payments').slice(0, 49).map((candidate) => candidate.id);
      expect(taggedIds.slice(1)).toEqual(expectedRemainder);
      expect(resolution.narrowing).toEqual({ tier: 'naming-heuristic', mode: 'narrow', droppedCount: 249 });
      expect(resolution.serviceName).toBe('payments');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('U3.3 populates candidates-json with ranked candidate views for ambiguous resolve-one', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-ambiguity-'));
    try {
      const aws = createAwsClientStub({
        listRestApis: vi.fn().mockResolvedValue([
          { id: 'ccccdddddd', name: 'payments-api-copy' },
          { id: 'aaaaabbbbb', name: 'payments-api' }
        ])
      });
      const resolution = await runResolution(
        {
          mode: 'resolve-one',
          awsRegion: 'us-east-1',
          repoRoot: tempDir,
          repoContext: { provider: 'github', repoSlug: 'postman/payments' },
          expectedServiceName: 'payments',
          expectedGatewayIds: [],
          stage: undefined,
          apiFilter: undefined,
          serviceMapping: {},
          outputDir: 'discovered-specs',
          maxCandidates: 50,
          dryRun: true,
          preflightChecks: false,
          preflightPermissionProbe: false,
          requestTimeoutMs: 30000,
          maxAttempts: 3,
          includeV2: false
        },
        aws,
        createCoreStub().core,
        vi.fn().mockResolvedValue(undefined)
      );

      expect(resolution.status).toBe('unresolved');
      expect(resolution.sourceType).toBe('manual-review');
      expect(resolution.rankedCandidates).toBeDefined();

      const outputs = buildExecutionOutputs({ mode: 'resolve-one', discovered: [], resolution });
      expect(outputs['resolution-status']).toBe('unresolved');
      expect(outputs['source-type']).toBe('manual-review');
      const parsed = JSON.parse(outputs['candidates-json'] ?? '') as Array<Record<string, unknown>>;
      expect(parsed).toHaveLength(2);
      expect(parsed.map((candidate) => candidate.rank)).toEqual([1, 2]);
      for (const candidate of parsed) {
        expect(Object.keys(candidate).sort()).toEqual(['confidence', 'evidence', 'gatewayId', 'gatewayType', 'rank', 'serviceName']);
      }
      expect(parsed[0]?.gatewayId).toBe('aaaaabbbbb');
      expect(parsed[1]?.gatewayId).toBe('ccccdddddd');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('finds only valid OpenAPI repo specs', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-spec-test-'));
    try {
      await writeFile(path.join(tempDir, 'swagger.yml'), 'not actually yaml for openapi', 'utf8');
      await writeFile(path.join(tempDir, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'x', version: '1.0.0' } }), 'utf8');

      const result = await findExistingRepoSpec(tempDir);

      expect(result).toBe('openapi.json');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('finds common non-OpenAPI repo spec artifacts with formats', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-spec-test-'));
    try {
      await mkdir(path.join(tempDir, 'packages', 'orders'), { recursive: true });
      await writeFile(
        path.join(tempDir, 'packages', 'orders', 'asyncapi.yaml'),
        'asyncapi: "2.6.0"\ninfo:\n  title: Orders\n  version: "1.0.0"\nchannels: {}',
        'utf8'
      );

      const result = await findExistingRepoSpecTyped(tempDir);

      expect(result?.path).toBe('packages/orders/asyncapi.yaml');
      expect(result?.type).toBe('asyncapi');
      expect(result?.format).toBe('asyncapi-yaml');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('finds versioned and alternate OpenAPI spec filenames in reference docs', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-spec-test-'));
    try {
      await mkdir(path.join(tempDir, 'docs', 'reference'), { recursive: true });
      await writeFile(
        path.join(tempDir, 'docs', 'reference', 'openapi.v1.yaml'),
        'openapi: 3.0.3\ninfo:\n  title: Reference\n  version: "1.0.0"\npaths: {}',
        'utf8'
      );

      const result = await findExistingRepoSpecTyped(tempDir);

      expect(result?.path).toBe('docs/reference/openapi.v1.yaml');
      expect(result?.format).toBe('openapi-yaml');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('collects provider hints from non-deploy workflow and serverless config files', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-signal-test-'));
    try {
      await mkdir(path.join(tempDir, '.github', 'workflows'), { recursive: true });
      await writeFile(
        path.join(tempDir, '.github', 'workflows', 'release.yml'),
        'env:\n  API_URL: https://abc123def4.execute-api.us-east-1.amazonaws.com/prod\n  CUSTOM_DOMAIN: api.orders.example.test\n',
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'serverless.ts'),
        [
          'export default {',
          '  functions: { handler: { events: [{ sns: "orders-topic" }] } },',
          '  resources: { Resources: { Url: { Type: "AWS::Lambda::Url" } } }',
          '};'
        ].join('\n'),
        'utf8'
      );

      const signals = await collectRepoSignals(tempDir, 'postman/orders', undefined, []);

      expect(signals.inferredGatewayIdHints).toContain('abc123def4');
      expect(signals.customDomainHints).toContain('api.orders.example.test');
      expect(signals.providerHints).toEqual(expect.arrayContaining(['sns', 'lambda-url']));
      expect(signals.evidence).toEqual(expect.arrayContaining([
        expect.stringContaining('.github/workflows/release.yml'),
        expect.stringContaining('serverless.ts')
      ]));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('detects nested Backstage catalog API references within bounded service directories', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-catalog-test-'));
    try {
      await mkdir(path.join(tempDir, 'services', 'orders'), { recursive: true });
      await writeFile(
        path.join(tempDir, 'services', 'orders', 'catalog-info.yaml'),
        [
          'apiVersion: backstage.io/v1alpha1',
          'kind: API',
          'metadata:',
          '  name: orders-api',
          'spec:',
          '  type: openapi',
          '  definition:',
          '    $text: ./openapi.yaml'
        ].join('\n'),
        'utf8'
      );

      const apis = await detectCatalogApis(tempDir);

      expect(apis?.[0]).toEqual({
        name: 'orders-api',
        type: 'openapi',
        specPath: 'services/orders/openapi.yaml',
        specUrl: undefined,
        catalogPath: 'services/orders/catalog-info.yaml'
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('collects provider hints from deployment configs and CDK/Pulumi language variants', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-expanded-signal-test-'));
    try {
      await mkdir(path.join(tempDir, 'helm', 'orders', 'templates'), { recursive: true });
      await mkdir(path.join(tempDir, 'k8s'), { recursive: true });
      await mkdir(path.join(tempDir, 'ecs'), { recursive: true });
      await mkdir(path.join(tempDir, 'src', 'main', 'resources'), { recursive: true });
      await mkdir(path.join(tempDir, 'src', 'Orders'), { recursive: true });
      await mkdir(path.join(tempDir, 'lib'), { recursive: true });
      await writeFile(path.join(tempDir, 'cdk.json'), '{"app":"python app.py"}', 'utf8');
      await writeFile(path.join(tempDir, 'Pulumi.yaml'), 'name: orders\nruntime: yaml\n', 'utf8');
      await writeFile(
        path.join(tempDir, 'helm', 'orders', 'templates', 'ingress.yaml'),
        'kind: Ingress\nspec:\n  rules:\n    - host: api.orders.example.test\n',
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'k8s', 'ingress.yaml'),
        'apiVersion: networking.k8s.io/v1\nkind: Ingress\nspec:\n  rules:\n    - host: orders.internal.example.test\n',
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'docker-compose.yml'),
        'services:\n  api:\n    environment:\n      API_URL: https://abc123def4.execute-api.us-east-1.amazonaws.com/prod\n',
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'ecs', 'task-definition.json'),
        '{"containerDefinitions":[{"environment":[{"name":"PUBLIC_API_URL","value":"https://bcdef12345.execute-api.us-east-1.amazonaws.com/prod"}]}]}',
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'src', 'main', 'resources', 'application.yml'),
        'service:\n  callback-url: https://orders-lambda.lambda-url.us-east-1.on.aws/\n',
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'src', 'Orders', 'appsettings.json'),
        '{"ApiGateway":{"Url":"https://cdef123456.execute-api.us-east-1.amazonaws.com/prod"}}',
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'lib', 'app.py'),
        'from aws_cdk import aws_apigatewayv2 as apigatewayv2\napi = apigatewayv2.CfnApi(self, "Api", protocol_type="HTTP")\n',
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'Pulumi.yaml'),
        'name: orders\nruntime: yaml\nresources:\n  api:\n    type: aws:apigatewayv2/api:Api\n',
        'utf8'
      );

      const signals = await collectRepoSignals(tempDir, 'postman/orders', undefined, []);

      expect(signals.providerHints).toContain('api-gateway');
      expect(signals.inferredGatewayIdHints).toEqual(expect.arrayContaining(['abc123def4', 'bcdef12345', 'cdef123456']));
      expect(signals.customDomainHints).toEqual(expect.arrayContaining(['api.orders.example.test', 'orders.internal.example.test']));
      expect(signals.lambdaUrlHints).toContain('orders-lambda.lambda-url.us-east-1.on.aws');
      expect((signals.evidence as string[]).map((e) => e.replace(/\\/g, '/'))).toEqual(expect.arrayContaining([
        expect.stringContaining('helm/orders/templates/ingress.yaml'),
        expect.stringContaining('docker-compose.yml'),
        expect.stringContaining('ecs/task-definition.json'),
        expect.stringContaining('application.yml'),
        expect.stringContaining('appsettings.json'),
        expect.stringContaining('lib/app.py'),
        expect.stringContaining('Pulumi.yaml')
      ]));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('extracts only contextual gateway IDs from repo files', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-signal-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'README.md'),
        'URL https://abc123def4.execute-api.us-east-1.amazonaws.com/prod and random token qwerty1234',
        'utf8'
      );

      const signals = await collectRepoSignals(tempDir, 'postman/payments', undefined, []);

      expect(signals.inferredGatewayIdHints).toEqual(['abc123def4']);
      expect(signals.inferredGatewayIdHints).not.toContain('qwerty1234');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('parses CLI flags into action-style input env', () => {
    const parsed = parseCliArgs(['--aws-region', 'us-east-1', '--repo-root', '/tmp/repo', '--result-json', '/tmp/out.json']);

    expect(parsed.kind).toBe('run');
    if (parsed.kind !== 'run') {
      return;
    }
    expect(parsed.inputEnv.INPUT_AWS_REGION).toBe('us-east-1');
    expect(parsed.inputEnv.INPUT_REPO_ROOT).toBe('/tmp/repo');
    expect(parsed.resultJsonPath).toBe('/tmp/out.json');
  });

  it('formats CLI dotenv output for downstream jobs', () => {
    const dotenv = toDotenv({
      'resolution-json': '{"status":"resolved"}',
      'resolution-status': 'resolved',
      'source-type': 'gateway-export',
      'mapping-confidence': '100',
      'spec-path': 'discovered-specs/payments/index.yaml',
      'gateway-id': 'abc123def4',
      'service-name': 'payments',
      'services-json': '[]',
      'service-count': '0',
      'contract-origin': 'repo-asyncapi',
      'contract-metadata-path': 'discovered-specs/payments/sns-resolution-metadata.json',
      'variant-count': '2',
      'derived-openapi-path': 'discovered-specs/payments/openapi.derived.json',
      'derived-openapi-version': '3.0.3',
      'derived-openapi-completeness': 'full',
      'derived-openapi-format': 'openapi-json',
      'derived-openapi-evidence-json': '["Source artifact is already OpenAPI 3.x"]'
    });

    expect(dotenv).toContain('POSTMAN_AWS_SPEC_RESOLUTION_STATUS=');
    expect(dotenv).toContain('POSTMAN_AWS_SPEC_SERVICE_NAME=');
    expect(dotenv).toContain('POSTMAN_AWS_SPEC_CONTRACT_ORIGIN=');
    expect(dotenv).toContain('POSTMAN_AWS_SPEC_CONTRACT_METADATA_PATH=');
    expect(dotenv).toContain('POSTMAN_AWS_SPEC_VARIANT_COUNT=');
    expect(dotenv).toContain('POSTMAN_AWS_SPEC_DERIVED_OPENAPI_PATH=');
    expect(dotenv).toContain('POSTMAN_AWS_SPEC_DERIVED_OPENAPI_VERSION=');
    expect(dotenv).toContain('POSTMAN_AWS_SPEC_DERIVED_OPENAPI_COMPLETENESS=');
    expect(dotenv).toContain('POSTMAN_AWS_SPEC_DERIVED_OPENAPI_FORMAT=');
    expect(dotenv).toContain('POSTMAN_AWS_SPEC_DERIVED_OPENAPI_EVIDENCE_JSON=');
  });
});


// ---------------------------------------------------------------------------
// U2.x: narrowing-strategy output (v2.1)
// ---------------------------------------------------------------------------
describe('U2 narrowing-strategy output', () => {
  const baseResolution = {
    status: 'resolved' as const,
    sourceType: 'gateway-export' as const,
    serviceName: 'orders-api',
    confidence: 100,
    gatewayId: 'rest-1',
    gatewayType: 'REST' as const,
    evidence: ['x']
  };

  it('U2.1 applied narrowing scalar and JSON object', () => {
    const outputs = buildExecutionOutputs({
      mode: 'resolve-one',
      discovered: [],
      resolution: {
        ...baseResolution,
        narrowing: { tier: 'iac-fingerprint', mode: 'narrow', droppedCount: 3 }
      }
    });
    expect(outputs['narrowing-strategy']).toBe('iac-fingerprint');
    const parsed = JSON.parse(outputs['resolution-json'] ?? '{}') as { narrowing?: unknown };
    expect(parsed.narrowing).toEqual({ tier: 'iac-fingerprint', mode: 'narrow', droppedCount: 3 });
  });

  it('U2.2 none and absent JSON object when no tier ran', () => {
    const outputs = buildExecutionOutputs({ mode: 'resolve-one', discovered: [], resolution: baseResolution });
    expect(outputs['narrowing-strategy']).toBe('none');
    const parsed = JSON.parse(outputs['resolution-json'] ?? '{}') as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, 'narrowing')).toBe(false);
  });

  it('U2.2b discover-many always emits none and no narrowing member', () => {
    const outputs = buildExecutionOutputs({ mode: 'discover-many', discovered: [] });
    expect(outputs['narrowing-strategy']).toBe('none');
    const parsed = JSON.parse(outputs['resolution-json'] ?? '{}') as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, 'narrowing')).toBe(false);
  });

  it('U2.4 prior output fields unchanged when narrowing present', () => {
    const outputs = buildExecutionOutputs({
      mode: 'resolve-one',
      discovered: [],
      resolution: { ...baseResolution, narrowing: { tier: 'naming-heuristic', mode: 'narrow', droppedCount: 1 } }
    });
    expect(outputs['resolution-status']).toBe('resolved');
    expect(outputs['source-type']).toBe('gateway-export');
    expect(outputs['service-name']).toBe('orders-api');
    expect(outputs['gateway-id']).toBe('rest-1');
    expect(outputs['mapping-confidence']).toBe('100');
  });

  it('U2.3 toDotenv exposes POSTMAN_AWS_SPEC_NARROWING_STRATEGY', () => {
    const dotenv = toDotenv({
      'resolution-json': '{}',
      'resolution-status': 'resolved',
      'source-type': 'gateway-export',
      'mapping-confidence': '100',
      'narrowing-strategy': 'tag-prefilter'
    });
    const line = dotenv.split('\n').find((l) => l.startsWith('POSTMAN_AWS_SPEC_NARROWING_STRATEGY='));
    expect(line).toBe('POSTMAN_AWS_SPEC_NARROWING_STRATEGY="tag-prefilter"');
  });
});

// ---------------------------------------------------------------------------
// U4.4: providerProbes JSON propagation (v2.1)
// ---------------------------------------------------------------------------
describe('U4.4 providerProbes propagation', () => {
  const baseResolution = {
    status: 'resolved' as const,
    sourceType: 'gateway-export' as const,
    serviceName: 'orders-api',
    confidence: 100,
    gatewayId: 'rest-1',
    gatewayType: 'REST' as const,
    evidence: ['x']
  };

  it('U4.4 injected (unprobed) registry path emits providerProbes: [] in resolve-one', () => {
    const outputs = buildExecutionOutputs({ mode: 'resolve-one', discovered: [], resolution: baseResolution });
    const parsed = JSON.parse(outputs['resolution-json'] ?? '{}') as { providerProbes?: unknown };
    expect(parsed.providerProbes).toEqual([]);
  });

  it('U4.4 resolve-one carries typed probe results into resolution-json', () => {
    const outputs = buildExecutionOutputs({
      mode: 'resolve-one',
      discovered: [],
      resolution: {
        ...baseResolution,
        providerProbes: [
          { provider: 'api-gateway', status: 'available' },
          { provider: 'appsync', status: 'skipped', reason: 'iam' }
        ]
      }
    });
    const parsed = JSON.parse(outputs['resolution-json'] ?? '{}') as { providerProbes?: unknown };
    expect(parsed.providerProbes).toEqual([
      { provider: 'api-gateway', status: 'available' },
      { provider: 'appsync', status: 'skipped', reason: 'iam' }
    ]);
  });

  it('U4.4 discover-many carries typed probe results into resolution-json and defaults to []', () => {
    const probes = [
      { provider: 'api-gateway' as const, status: 'available' as const },
      { provider: 'appsync' as const, status: 'skipped' as const, reason: 'timeout' as const }
    ];
    const withProbes = buildExecutionOutputs({ mode: 'discover-many', discovered: [], providerProbes: probes });
    expect(JSON.parse(withProbes['resolution-json'] ?? '{}').providerProbes).toEqual(probes);
    const without = buildExecutionOutputs({ mode: 'discover-many', discovered: [] });
    expect(JSON.parse(without['resolution-json'] ?? '{}').providerProbes).toEqual([]);
  });

  it('U4.4 registry probeAvailableDetailed ordering matches registration order', async () => {
    const registry = new ProviderRegistry();
    const fake = (type: string, probe: () => Promise<boolean>): SpecProvider =>
      ({ type, probe, listCandidates: async () => [], exportSpec: async () => { throw new Error('unused'); } }) as unknown as SpecProvider;
    registry.register(fake('appsync', () => Promise.resolve(true)));
    registry.register(fake('eventbridge-schemas', () => Promise.resolve(false)));
    registry.register(fake('glue', () => Promise.reject(Object.assign(new Error('x'), { name: 'AccessDeniedException' }))));
    const { probes } = await registry.probeAvailableDetailed();
    expect(probes.map((p) => p.provider)).toEqual(['appsync', 'eventbridge-schemas', 'glue']);
    expect(probes[2]).toEqual({ provider: 'glue', status: 'skipped', reason: 'iam' });
  });
});

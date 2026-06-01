#!/usr/bin/env node
/* global console, process */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { updateEvidenceReadmeSection } from './lib/evidence-readme.mjs';

const repoRoot = process.cwd();
const distEntry = path.join(repoRoot, 'dist', 'index.cjs');
const { collectRepoSignals, deriveOpenApiDocument, detectCatalogApis } = await import(distEntry);

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  const inline = process.argv.find((value) => value.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : fallback;
}

const evidenceJsonPath = arg('evidence-json', 'validation/evidence/iac-repo-signals-matrix.local.json');
const summaryPath = arg('summary', 'validation/evidence/README.md');

async function copyFixture(workspace, source, target = path.basename(source)) {
  const destination = path.join(workspace, target);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(repoRoot, source), destination);
}

const cases = [
  {
    name: 'cloudformation-sam',
    setup: async (workspace) => {
      await copyFixture(workspace, 'validation/fixtures/iac/cloudformation/template.yaml', 'template.yaml');
      await copyFixture(workspace, 'validation/fixtures/repo-spec/asyncapi.yaml', 'asyncapi.yaml');
    },
    expectedProviders: ['api-gateway', 'appsync', 'eventbridge-schemas', 'glue', 'sns', 'lambda-url'],
    expectedEvidence: ['Found SNS event contract file'],
    expectedOasDerivations: [{ path: 'asyncapi.yaml', format: 'asyncapi-yaml' }]
  },
  {
    name: 'terraform',
    setup: async (workspace) => {
      await copyFixture(workspace, 'validation/fixtures/iac/terraform/main.tf', 'main.tf');
    },
    expectedProviders: ['api-gateway', 'appsync', 'eventbridge-schemas', 'glue', 'sns', 'lambda-url'],
    expectedEvidence: ['Detected SNS/EventBridge bridge pattern']
  },
  {
    name: 'cdk',
    setup: async (workspace) => {
      await copyFixture(workspace, 'validation/fixtures/iac/cdk/cdk.json', 'cdk.json');
      await copyFixture(workspace, 'validation/fixtures/iac/cdk/lib/app.ts', 'lib/app.ts');
    },
    expectedProviders: ['api-gateway', 'appsync', 'eventbridge-schemas', 'sns', 'lambda-url'],
    expectedEvidence: ['Detected SNS/EventBridge bridge pattern']
  },
  {
    name: 'pulumi',
    setup: async (workspace) => {
      await copyFixture(workspace, 'validation/fixtures/iac/pulumi/Pulumi.yaml', 'Pulumi.yaml');
      await copyFixture(workspace, 'validation/fixtures/iac/pulumi/index.ts', 'index.ts');
    },
    expectedProviders: ['api-gateway', 'appsync', 'sns', 'lambda-url'],
    expectedEvidence: []
  },
  {
    name: 'workflow-readme-graphql',
    setup: async (workspace) => {
      await mkdir(path.join(workspace, '.github/workflows'), { recursive: true });
      await copyFixture(workspace, 'validation/fixtures/iac/workflow/deploy.yml', '.github/workflows/deploy.yml');
      await copyFixture(workspace, 'validation/fixtures/iac/readme/README.md', 'README.md');
      await copyFixture(workspace, 'validation/fixtures/iac/graphql/schema.graphql', 'schema.graphql');
    },
    expectedProviders: ['appsync', 'lambda-url'],
    expectedGatewayIds: ['abcdef1234'],
    expectedCustomDomains: ['api.validation.example.test'],
    expectedLambdaUrlHosts: ['abcdefghij.lambda-url.us-east-1.on.aws'],
    expectedEvidence: ['Detected SNS/EventBridge bridge pattern', 'Found GraphQL schema file'],
    expectedOasDerivations: [{ path: 'schema.graphql', format: 'graphql-sdl' }]
  },
  {
    name: 'expanded-configs',
    setup: async (workspace) => {
      await mkdir(path.join(workspace, '.github/workflows'), { recursive: true });
      await writeFile(
        path.join(workspace, '.github/workflows/release.yml'),
        'env:\n  API_URL: https://abc123def4.execute-api.us-east-1.amazonaws.com/prod\n  CUSTOM_DOMAIN: api.orders.example.test\n',
        'utf8'
      );
      await writeFile(
        path.join(workspace, 'serverless.ts'),
        [
          'export default {',
          '  functions: { handler: { events: [{ sns: "orders-topic" }] } },',
          '  resources: { Resources: { Url: { Type: "AWS::Lambda::Url" } } }',
          '};'
        ].join('\n'),
        'utf8'
      );
    },
    expectedProviders: ['sns', 'lambda-url'],
    expectedGatewayIds: ['abc123def4'],
    expectedCustomDomains: ['api.orders.example.test'],
    expectedEvidence: ['.github/workflows/release.yml', 'serverless.ts']
  },
  {
    name: 'nested-backstage',
    setup: async (workspace) => {
      await copyFixture(workspace, 'validation/fixtures/iac/backstage/services/orders/catalog-info.yaml', 'services/orders/catalog-info.yaml');
      await copyFixture(workspace, 'validation/fixtures/iac/backstage/services/orders/openapi.yaml', 'services/orders/openapi.yaml');
    },
    expectedCatalogRefs: [{ name: 'orders-api', specPath: 'services/orders/openapi.yaml' }],
    expectedEvidence: []
  },
  {
    name: 'deployment-configs',
    setup: async (workspace) => {
      await copyFixture(workspace, 'validation/fixtures/iac/deployment/helm/orders/templates/ingress.yaml', 'helm/orders/templates/ingress.yaml');
      await copyFixture(workspace, 'validation/fixtures/iac/deployment/k8s/ingress.yaml', 'k8s/ingress.yaml');
      await copyFixture(workspace, 'validation/fixtures/iac/deployment/docker-compose.yml', 'docker-compose.yml');
      await copyFixture(workspace, 'validation/fixtures/iac/deployment/ecs/task-definition.json', 'ecs/task-definition.json');
      await copyFixture(workspace, 'validation/fixtures/iac/deployment/spring/application.yml', 'src/main/resources/application.yml');
      await copyFixture(workspace, 'validation/fixtures/iac/deployment/dotnet/appsettings.json', 'src/Orders/appsettings.json');
      await copyFixture(workspace, 'validation/fixtures/iac/cdk/cdk.json', 'cdk.json');
      await copyFixture(workspace, 'validation/fixtures/iac/cdk/lib/app.py', 'lib/app.py');
      await copyFixture(workspace, 'validation/fixtures/iac/pulumi/Pulumi.yaml', 'Pulumi.yaml');
    },
    expectedProviders: ['api-gateway', 'lambda-url'],
    expectedGatewayIds: ['abc123def4', 'bcdef12345', 'cdef123456'],
    expectedCustomDomains: ['api.orders.example.test', 'orders.internal.example.test'],
    expectedLambdaUrlHosts: ['orders-lambda.lambda-url.us-east-1.on.aws'],
    expectedEvidence: ['helm/orders/templates/ingress.yaml', 'docker-compose.yml', 'ecs/task-definition.json', 'application.yml', 'appsettings.json', 'lib/app.py', 'Pulumi.yaml']
  }
];

function containsAll(actual = [], expected = []) {
  return expected.every((value) => actual.includes(value));
}

function evidenceContains(actual = [], expected = []) {
  return expected.every((value) => actual.some((entry) => entry.includes(value)));
}

async function runCase(testCase) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), `spec-discovery-iac-${testCase.name}-`));
  try {
    await testCase.setup(workspace);
    const signals = await collectRepoSignals(workspace, 'validation/service', undefined, []);
    const catalogRefs = await detectCatalogApis(workspace) ?? [];
    const checks = [
      { name: 'provider hints', passed: containsAll(signals.providerHints ?? [], testCase.expectedProviders ?? []) },
      { name: 'gateway id hints', passed: containsAll(signals.inferredGatewayIdHints ?? [], testCase.expectedGatewayIds ?? []) },
      { name: 'custom domain hints', passed: containsAll(signals.customDomainHints ?? [], testCase.expectedCustomDomains ?? []) },
      { name: 'lambda url hosts', passed: containsAll(signals.lambdaUrlHints ?? [], testCase.expectedLambdaUrlHosts ?? []) },
      { name: 'evidence markers', passed: evidenceContains(signals.evidence ?? [], testCase.expectedEvidence ?? []) },
      {
        name: 'catalog refs',
        passed: (testCase.expectedCatalogRefs ?? []).every((expected) =>
          catalogRefs.some((actual) => actual.name === expected.name && actual.specPath === expected.specPath)
        )
      }
    ];
    for (const derivation of testCase.expectedOasDerivations ?? []) {
      const content = await readFile(path.join(workspace, derivation.path), 'utf8');
      const oas = deriveOpenApiDocument({ content, format: derivation.format, title: `${testCase.name}-${derivation.path}` });
      checks.push({
        name: `OAS derivation ${derivation.path}`,
        passed: oas.content.includes('"openapi": "3.') || oas.content.includes('openapi: 3.')
      });
    }

    return {
      name: testCase.name,
      providerHints: signals.providerHints ?? [],
      inferredGatewayIdHints: signals.inferredGatewayIdHints ?? [],
      customDomainHints: signals.customDomainHints ?? [],
      lambdaUrlHints: signals.lambdaUrlHints ?? [],
      catalogRefs,
      evidence: signals.evidence ?? [],
      checks,
      passed: checks.every((check) => check.passed)
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

const results = [];
for (const testCase of cases) {
  results.push(await runCase(testCase));
}

const failed = results.filter((result) => !result.passed);
await mkdir(path.dirname(evidenceJsonPath), { recursive: true });
await writeFile(evidenceJsonPath, `${JSON.stringify({ capturedAt: new Date().toISOString(), results }, null, 2)}\n`, 'utf8');

const summary = [
  '## IaC and Repo Signal Matrix Evidence',
  '',
  `- Captured at: ${new Date().toISOString()}`,
  `- Cases: ${results.length}`,
  `- Passed: ${results.length - failed.length}`,
  `- Failed: ${failed.length}`,
  '',
  '| Case | Provider hints | Other checks | Result |',
  '| --- | --- | ---: | --- |',
  ...results.map((result) => {
    const otherChecks = result.checks.filter((check) => check.name !== 'provider hints').length;
    return `| ${result.name} | ${result.providerHints.join(', ')} | ${otherChecks} | ${result.passed ? 'pass' : 'fail'} |`;
  })
].join('\n');

await updateEvidenceReadmeSection(summaryPath, 'iac-repo-signals-matrix', summary);

if (failed.length > 0) {
  console.error(JSON.stringify({ failed }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: 'ok', cases: results.length }, null, 2));
}

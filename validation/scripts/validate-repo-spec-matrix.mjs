#!/usr/bin/env node
/* global console, process */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { updateEvidenceReadmeSection } from './lib/evidence-readme.mjs';

const repoRoot = process.cwd();
const distEntry = path.join(repoRoot, 'dist', 'index.cjs');
const { deriveOpenApiDocument, execute, resolveInputs } = await import(distEntry);

const cases = [
  {
    name: 'openapi-3.0-yaml',
    source: 'validation/fixtures/repo-spec/openapi-3.0.yaml',
    target: 'openapi.yaml',
    expectedFormat: 'openapi-yaml'
  },
  {
    name: 'openapi-3.1-json',
    source: 'validation/fixtures/repo-spec/openapi-3.1.json',
    target: 'openapi.json',
    expectedFormat: 'openapi-json'
  },
  {
    name: 'swagger-2.0-yaml',
    source: 'validation/fixtures/repo-spec/swagger-2.0.yaml',
    target: 'swagger.yaml',
    expectedFormat: 'openapi-yaml'
  },
  {
    name: 'graphql-sdl',
    source: 'validation/fixtures/repo-spec/schema.graphql',
    target: 'schema.graphql',
    expectedFormat: 'graphql-sdl'
  },
  {
    name: 'asyncapi-yaml',
    source: 'validation/fixtures/repo-spec/asyncapi.yaml',
    target: 'asyncapi.yaml',
    expectedFormat: 'asyncapi-yaml'
  },
  {
    name: 'postman-collection',
    source: 'validation/fixtures/repo-spec/collection.postman_collection.json',
    target: 'collection.postman_collection.json',
    expectedFormat: 'postman-collection'
  },
  {
    name: 'protobuf',
    source: 'validation/fixtures/repo-spec/service.proto',
    target: 'service.proto',
    expectedFormat: 'protobuf'
  },
  {
    name: 'smithy',
    source: 'validation/fixtures/repo-spec/model.smithy',
    target: 'model.smithy',
    expectedFormat: 'smithy'
  },
  {
    name: 'smithy-build',
    source: 'validation/fixtures/repo-spec/smithy-build.json',
    target: 'smithy-build.json',
    expectedFormat: 'smithy'
  },
  {
    name: 'backstage-yaml-local-openapi',
    source: 'validation/fixtures/repo-spec/openapi-3.0.yaml',
    target: 'openapi.yaml',
    catalog: 'catalog-info.yaml',
    catalogContent: [
      'apiVersion: backstage.io/v1alpha1',
      'kind: API',
      'metadata:',
      '  name: validation-backstage-yaml',
      'spec:',
      '  type: openapi',
      '  definition: ./openapi.yaml'
    ].join('\n'),
    expectedFormat: 'openapi-yaml',
    expectedEvidence: 'Backstage catalog local openapi definition'
  },
  {
    name: 'backstage-yml-local-graphql',
    source: 'validation/fixtures/repo-spec/schema.graphql',
    target: 'schema.graphql',
    catalog: 'catalog-info.yml',
    catalogContent: [
      'apiVersion: backstage.io/v1alpha1',
      'kind: API',
      'metadata:',
      '  name: validation-backstage-yml',
      'spec:',
      '  type: graphql',
      '  definition:',
      '    $text: ./schema.graphql'
    ].join('\n'),
    expectedFormat: 'graphql-sdl',
    expectedEvidence: 'Backstage catalog local graphql definition'
  },
  {
    name: 'backstage-remote-openapi',
    catalog: 'catalog-info.yaml',
    catalogContent: [
      'apiVersion: backstage.io/v1alpha1',
      'kind: API',
      'metadata:',
      '  name: validation-backstage-remote',
      'spec:',
      '  type: openapi',
      '  definition:',
      '    $text: https://raw.githubusercontent.com/swagger-api/swagger-petstore/master/src/main/resources/openapi.yaml'
    ].join('\n'),
    expectedFormat: 'openapi-yaml',
    expectedEvidence: 'Backstage catalog remote openapi definition'
  }
];

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  const inline = process.argv.find((value) => value.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : fallback;
}

const evidenceJsonPath = arg('evidence-json', 'validation/evidence/repo-spec-matrix.local.json');
const summaryPath = arg('summary', 'validation/evidence/README.md');

const emptyProviderRegistry = {
  all: () => [],
  get: () => undefined,
  register: () => undefined,
  probeAvailable: async () => []
};

const stubAws = {
  listRestApis: async () => [],
  listHttpApis: async () => [],
  getRestApi: async () => undefined,
  getHttpApi: async () => undefined,
  listRestStages: async () => [],
  listHttpStages: async () => [],
  getRestTags: async () => ({}),
  getHttpTags: async () => ({}),
  exportRestApi: async () => '',
  exportHttpApi: async () => '',
  exportWebSocketApi: async () => '',
  getCallerIdentity: async () => ({ accountId: '000000000000', arn: 'arn:aws:iam::000000000000:user/validation' }),
  probeApiGatewayReadAccess: async () => undefined
};

const quietCore = {
  async group(_name, fn) {
    return await fn();
  },
  info() {},
  warning(message) {
    console.error(`warning: ${message}`);
  }
};

async function runCase(testCase) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), `spec-discovery-validation-${testCase.name}-`));
  try {
    if (testCase.source) {
      await cp(path.join(repoRoot, testCase.source), path.join(workspace, testCase.target));
    }
    if (testCase.catalog) {
      await writeFile(path.join(workspace, testCase.catalog), `${testCase.catalogContent}\n`, 'utf8');
    }

    const inputs = resolveInputs({
      INPUT_AWS_REGION: 'us-east-1',
      INPUT_REPO_ROOT: workspace,
      INPUT_OUTPUT_DIR: 'discovered-specs',
      INPUT_PREFLIGHT_CHECKS: 'false',
      INPUT_INCLUDE_V2: 'false'
    });

    const result = await execute(inputs, {
      core: quietCore,
      aws: stubAws,
      writeSpecFile: async (outputPath, content) => {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, content, 'utf8');
      },
      providerRegistry: emptyProviderRegistry
    });

    const resolution = result.resolution;
    const evidence = resolution?.evidence ?? [];
    const specContent = resolution?.specPath
      ? await readFile(path.join(workspace, resolution.specPath), 'utf8').catch(() => '')
      : '';
    const oas = resolution?.specFormat && specContent
      ? deriveOpenApiDocument({ content: specContent, format: resolution.specFormat, title: testCase.name })
      : undefined;
    const passed =
      resolution?.status === 'resolved' &&
      resolution.sourceType === 'repo-spec' &&
      resolution.specFormat === testCase.expectedFormat &&
      Boolean(oas?.content.includes('"openapi": "3.') || oas?.content.includes('openapi: 3.')) &&
      (!testCase.expectedEvidence || evidence.some((entry) => entry.includes(testCase.expectedEvidence)));

    return {
      name: testCase.name,
      passed,
      status: resolution?.status,
      sourceType: resolution?.sourceType,
      specFormat: resolution?.specFormat,
      oasVersion: oas?.version,
      oasCompleteness: oas?.completeness,
      specPath: resolution?.specPath,
      evidence
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
  '## Repo Spec Matrix Evidence',
  '',
  `- Captured at: ${new Date().toISOString()}`,
  `- Cases: ${results.length}`,
  `- Passed: ${results.length - failed.length}`,
  `- Failed: ${failed.length}`,
  '',
  '| Case | Source Type | Spec Format | OAS | Result |',
  '| --- | --- | --- | --- | --- |',
  ...results.map((result) => `| ${result.name} | ${result.sourceType ?? ''} | ${result.specFormat ?? ''} | ${result.oasVersion ?? ''} ${result.oasCompleteness ?? ''} | ${result.passed ? 'pass' : 'fail'} |`)
].join('\n');

await updateEvidenceReadmeSection(summaryPath, 'repo-spec-matrix', summary);

if (failed.length > 0) {
  console.error(JSON.stringify({ failed }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: 'ok', cases: results.length }, null, 2));
}

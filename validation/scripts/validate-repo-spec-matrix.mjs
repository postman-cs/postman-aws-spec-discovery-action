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
    name: 'versioned-openapi-reference',
    source: 'validation/fixtures/repo-spec/openapi-3.0.yaml',
    target: 'docs/reference/openapi.v1.yaml',
    expectedFormat: 'openapi-yaml'
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
    expectedFormat: 'graphql-sdl',
    expectedDerivedGraphql: {
      operationName: 'item',
      requiredVariable: 'id',
      component: 'Item'
    }
  },
  {
    name: 'graphql-introspection-json',
    source: 'validation/fixtures/repo-spec/introspection.json',
    target: 'introspection.json',
    expectedFormat: 'graphql-introspection-json'
  },
  {
    name: 'wsdl',
    source: 'validation/fixtures/repo-spec/service.wsdl',
    target: 'service.wsdl',
    expectedFormat: 'wsdl'
  },
  {
    name: 'mcp-json',
    source: 'validation/fixtures/repo-spec/mcp.json',
    target: 'mcp.json',
    expectedFormat: 'mcp-json'
  },
  {
    name: 'asyncapi-yaml',
    source: 'validation/fixtures/repo-spec/asyncapi.yaml',
    target: 'asyncapi.yaml',
    expectedFormat: 'asyncapi-yaml',
    expectedDerivedWebhook: {
      name: 'validation_topic',
      channel: 'validation-topic',
      operation: 'subscribe',
      schemaRef: '#/components/schemas/ValidationEvent',
      example: 'sample-event'
    }
  },
  {
    name: 'postman-collection',
    source: 'validation/fixtures/repo-spec/collection.postman_collection.json',
    target: 'collection.postman_collection.json',
    expectedFormat: 'postman-collection',
    expectedDerivedPostman: {
      path: '/orders',
      method: 'post',
      query: 'status',
      header: 'X-Trace-Id',
      authType: 'bearer',
      responseCode: '201'
    }
  },
  {
    name: 'json-schema-repo-resolution',
    source: 'validation/fixtures/repo-spec/order.schema.json',
    target: 'order.schema.json',
    expectedFormat: 'json-schema',
    expectedDerivedSchema: {
      path: '/order-created',
      component: 'OrderCreated',
      property: 'id'
    }
  },
  {
    name: 'avro-repo-resolution',
    source: 'validation/fixtures/repo-spec/order.avsc',
    target: 'order.avsc',
    expectedFormat: 'avro',
    expectedDerivedSchema: {
      path: '/order-event',
      component: 'OrderEvent',
      property: 'total'
    }
  },
  {
    name: 'protobuf',
    source: 'validation/fixtures/repo-spec/service.proto',
    target: 'service.proto',
    expectedFormat: 'protobuf',
    expectedDerivedRpc: {
      path: '/ValidationService/GetItem',
      input: 'GetItemRequest',
      output: 'GetItemResponse',
      inputProperty: 'id'
    }
  },
  {
    name: 'smithy',
    source: 'validation/fixtures/repo-spec/model.smithy',
    target: 'model.smithy',
    expectedFormat: 'smithy',
    expectedDerivedRpc: {
      path: '/ValidationService/GetItem',
      input: 'GetItemInput',
      output: 'GetItemOutput',
      inputProperty: 'id'
    }
  },
  {
    name: 'smithy-build',
    source: 'validation/fixtures/repo-spec/smithy-build.json',
    target: 'smithy-build.json',
    companionSources: [{ source: 'validation/fixtures/repo-spec/model.smithy', target: 'model.smithy' }],
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
    expectedEvidence: 'Backstage catalog remote openapi definition',
    remoteFetchAllowlist: [
      { hostname: 'raw.githubusercontent.com', pathPrefix: '/swagger-api/swagger-petstore/' }
    ]
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
      await cp(path.join(repoRoot, testCase.source), path.join(workspace, testCase.target ?? path.basename(testCase.source)));
    }
    for (const companion of testCase.companionSources ?? []) {
      await cp(path.join(repoRoot, companion.source), path.join(workspace, companion.target));
    }
    if (testCase.derivationOnly) {
      const content = await readFile(path.join(repoRoot, testCase.source), 'utf8');
      const oas = deriveOpenApiDocument({ content, format: testCase.expectedFormat, title: testCase.name });
      const derivedDocument = JSON.parse(oas.content);
      const passed =
        Boolean(derivedDocument?.openapi) &&
        oas.format === 'openapi-json' &&
        oas.completeness === 'partial' &&
        matchesExpectedDerivedSchema(derivedDocument, testCase.expectedDerivedSchema);
      return {
        name: testCase.name,
        passed,
        status: 'resolved',
        sourceType: 'derivation-only',
        specFormat: testCase.expectedFormat,
        derivedOpenApiVersion: oas.version,
        derivedOpenApiCompleteness: oas.completeness,
        derivedOpenApiFormat: oas.format,
        specPath: testCase.source,
        evidence: oas.evidence
      };
    }
    if (testCase.catalog) {
      await writeFile(path.join(workspace, testCase.catalog), `${testCase.catalogContent}\n`, 'utf8');
    }

    const inputs = resolveInputs({
      INPUT_AWS_REGION: 'us-east-1',
      INPUT_REPO_ROOT: workspace,
      INPUT_OUTPUT_DIR: 'discovered-specs',
      INPUT_PREFLIGHT_CHECKS: 'false',
      INPUT_INCLUDE_V2: 'false',
      INPUT_REMOTE_FETCH_ALLOWLIST_JSON: testCase.remoteFetchAllowlist
        ? JSON.stringify(testCase.remoteFetchAllowlist)
        : undefined
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
    const derivedContent = resolution?.derivedOpenApiPath
      ? await readFile(path.join(workspace, resolution.derivedOpenApiPath), 'utf8').catch(() => '')
      : '';
    let derivedDocument;
    try {
      derivedDocument = derivedContent ? JSON.parse(derivedContent) : undefined;
    } catch {
      derivedDocument = undefined;
    }
    const oas = resolution?.specFormat && specContent
      ? deriveOpenApiDocument({ content: specContent, format: resolution.specFormat, title: testCase.name })
      : undefined;
    const passed =
      resolution?.status === 'resolved' &&
      resolution.sourceType === 'repo-spec' &&
      resolution.specFormat === testCase.expectedFormat &&
      Boolean(resolution.derivedOpenApiPath) &&
      resolution.derivedOpenApiFormat === 'openapi-json' &&
      resolution.derivedOpenApiVersion === oas?.version &&
      resolution.derivedOpenApiCompleteness === oas?.completeness &&
      Boolean(derivedDocument?.openapi) &&
      matchesExpectedDerivedWebhook(derivedDocument, testCase.expectedDerivedWebhook) &&
      matchesExpectedDerivedGraphql(derivedDocument, testCase.expectedDerivedGraphql) &&
      matchesExpectedDerivedPostman(derivedDocument, testCase.expectedDerivedPostman) &&
      matchesExpectedDerivedSchema(derivedDocument, testCase.expectedDerivedSchema) &&
      matchesExpectedDerivedRpc(derivedDocument, testCase.expectedDerivedRpc) &&
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
      derivedOpenApiPath: resolution?.derivedOpenApiPath,
      derivedOpenApiVersion: resolution?.derivedOpenApiVersion,
      derivedOpenApiCompleteness: resolution?.derivedOpenApiCompleteness,
      derivedOpenApiFormat: resolution?.derivedOpenApiFormat,
      specPath: resolution?.specPath,
      evidence
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function matchesExpectedDerivedWebhook(derivedDocument, expected) {
  if (!expected) return true;
  const operation = derivedDocument?.webhooks?.[expected.name]?.post;
  const media = operation?.requestBody?.content?.['application/json'];
  return (
    operation?.['x-asyncapi-channel'] === expected.channel &&
    operation?.['x-asyncapi-operation'] === expected.operation &&
    media?.schema?.$ref === expected.schemaRef &&
    Boolean(media?.examples?.[expected.example])
  );
}

function matchesExpectedDerivedGraphql(derivedDocument, expected) {
  if (!expected) return true;
  const operation = derivedDocument?.paths?.['/graphql']?.post;
  const schema = operation?.requestBody?.content?.['application/json']?.schema;
  const variables = schema?.properties?.variables?.oneOf?.[0];
  const operationNames = operation?.['x-graphql-operations']?.map((entry) => entry.name) ?? [];
  return (
    operationNames.includes(expected.operationName) &&
    schema?.properties?.operationName?.enum?.includes(expected.operationName) &&
    variables?.required?.includes(expected.requiredVariable) &&
    Boolean(derivedDocument?.components?.schemas?.[expected.component])
  );
}

function matchesExpectedDerivedPostman(derivedDocument, expected) {
  if (!expected) return true;
  const operation = derivedDocument?.paths?.[expected.path]?.[expected.method];
  const params = operation?.parameters ?? [];
  return (
    params.some((param) => param.name === expected.query && param.in === 'query') &&
    params.some((param) => param.name === expected.header && param.in === 'header') &&
    operation?.['x-postman-auth-type'] === expected.authType &&
    Boolean(operation?.requestBody?.content?.['application/json']?.example) &&
    Boolean(operation?.responses?.[expected.responseCode]?.content?.['application/json']?.example)
  );
}

function matchesExpectedDerivedSchema(derivedDocument, expected) {
  if (!expected) return true;
  return (
    derivedDocument?.paths?.[expected.path]?.post?.requestBody?.content?.['application/json']?.schema?.$ref ===
      `#/components/schemas/${expected.component}` &&
    Boolean(derivedDocument?.components?.schemas?.[expected.component]?.properties?.[expected.property])
  );
}

function matchesExpectedDerivedRpc(derivedDocument, expected) {
  if (!expected) return true;
  const operation = derivedDocument?.paths?.[expected.path]?.post;
  return (
    operation?.requestBody?.content?.['application/json']?.schema?.$ref === `#/components/schemas/${expected.input}` &&
    operation?.responses?.['200']?.content?.['application/json']?.schema?.$ref === `#/components/schemas/${expected.output}` &&
    Boolean(derivedDocument?.components?.schemas?.[expected.input]?.properties?.[expected.inputProperty]) &&
    Boolean(derivedDocument?.components?.schemas?.[expected.output])
  );
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
  '| Case | Source Type | Spec Format | Derived OAS | Result |',
  '| --- | --- | --- | --- | --- |',
  ...results.map((result) => `| ${result.name} | ${result.sourceType ?? ''} | ${result.specFormat ?? ''} | ${result.derivedOpenApiVersion ?? ''} ${result.derivedOpenApiCompleteness ?? ''} ${result.derivedOpenApiFormat ?? ''} | ${result.passed ? 'pass' : 'fail'} |`)
].join('\n');

await updateEvidenceReadmeSection(summaryPath, 'repo-spec-matrix', summary);

if (failed.length > 0) {
  console.error(JSON.stringify({ failed }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: 'ok', cases: results.length }, null, 2));
}

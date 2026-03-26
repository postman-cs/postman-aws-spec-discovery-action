import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { findIaCFiles } from '../src/lib/repo/scan.js';
import { collectRepoSignals } from '../src/lib/repo/signals.js';

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'scan-test-'));
}

describe('findIaCFiles', () => {
  it('finds .tf files in root', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'main.tf'), 'resource "aws_api_gateway_rest_api" "api" {}');
    await writeFile(path.join(root, 'variables.tf'), 'variable "region" {}');

    const files = await findIaCFiles(root, ['.tf']);
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith('.tf'))).toBe(true);
  });

  it('finds .tf files in subdirectories', async () => {
    const root = await makeTempDir();
    const sub = path.join(root, 'infra');
    await mkdir(sub);
    await writeFile(path.join(sub, 'main.tf'), '');

    const files = await findIaCFiles(root, ['.tf']);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('infra');
  });

  it('skips node_modules directory', async () => {
    const root = await makeTempDir();
    const nm = path.join(root, 'node_modules', 'some-pkg');
    await mkdir(nm, { recursive: true });
    await writeFile(path.join(nm, 'main.tf'), '');
    await writeFile(path.join(root, 'real.tf'), '');

    const files = await findIaCFiles(root, ['.tf']);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('real.tf');
  });

  it('skips .git directory', async () => {
    const root = await makeTempDir();
    const git = path.join(root, '.git');
    await mkdir(git);
    await writeFile(path.join(git, 'config.tf'), '');
    await writeFile(path.join(root, 'main.tf'), '');

    const files = await findIaCFiles(root, ['.tf']);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('main.tf');
  });

  it('skips .terraform directory', async () => {
    const root = await makeTempDir();
    const tfDir = path.join(root, '.terraform');
    await mkdir(tfDir);
    await writeFile(path.join(tfDir, 'provider.tf'), '');
    await writeFile(path.join(root, 'main.tf'), '');

    const files = await findIaCFiles(root, ['.tf']);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('main.tf');
  });

  it('skips vendor directory', async () => {
    const root = await makeTempDir();
    const vendor = path.join(root, 'vendor');
    await mkdir(vendor);
    await writeFile(path.join(vendor, 'module.tf'), '');
    await writeFile(path.join(root, 'main.tf'), '');

    const files = await findIaCFiles(root, ['.tf']);
    expect(files).toHaveLength(1);
  });

  it('respects MAX_FILES limit of 50', async () => {
    const root = await makeTempDir();
    for (let i = 0; i < 60; i++) {
      await writeFile(path.join(root, `file${i}.tf`), '');
    }

    const files = await findIaCFiles(root, ['.tf']);
    expect(files.length).toBeLessThanOrEqual(50);
  });

  it('respects MAX_DEPTH limit of 4', async () => {
    const root = await makeTempDir();
    let current = root;
    for (let i = 0; i <= 5; i++) {
      current = path.join(current, `level${i}`);
      await mkdir(current);
      await writeFile(path.join(current, 'main.tf'), '');
    }

    const files = await findIaCFiles(root, ['.tf']);
    const maxDepthFromRoot = Math.max(
      ...files.map((f) => f.replace(root, '').split(path.sep).filter(Boolean).length - 1),
    );
    expect(maxDepthFromRoot).toBeLessThanOrEqual(4);
  });

  it('enforces MAX_FILES globally across branches', async () => {
    const root = await makeTempDir();
    for (let branch = 0; branch < 3; branch++) {
      const dir = path.join(root, `branch${branch}`);
      await mkdir(dir);
      for (let i = 0; i < 20; i++) {
        await writeFile(path.join(dir, `file${i}.tf`), '');
      }
    }

    const files = await findIaCFiles(root, ['.tf']);
    expect(files.length).toBeLessThanOrEqual(50);
  });

  it('finds multiple extension types', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'index.ts'), '');
    await writeFile(path.join(root, 'main.py'), '');
    await writeFile(path.join(root, 'main.tf'), '');

    const files = await findIaCFiles(root, ['.ts', '.py']);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.endsWith('.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('.py'))).toBe(true);
    expect(files.some((f) => f.endsWith('.tf'))).toBe(false);
  });

  it('returns empty array for empty directory', async () => {
    const root = await makeTempDir();
    const files = await findIaCFiles(root, ['.tf']);
    expect(files).toHaveLength(0);
  });

  it('returns empty array for non-existent directory', async () => {
    const files = await findIaCFiles('/nonexistent/path/that/does/not/exist', ['.tf']);
    expect(files).toHaveLength(0);
  });
});

describe('Terraform provider patterns via collectRepoSignals', () => {
  it('detects api-gateway from aws_api_gateway_rest_api resource', async () => {
    const root = await makeTempDir();
    await writeFile(
      path.join(root, 'main.tf'),
      'resource "aws_api_gateway_rest_api" "my_api" { name = "MyAPI" }',
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('api-gateway');
  });

  it('detects api-gateway from aws_apigatewayv2_api resource', async () => {
    const root = await makeTempDir();
    await writeFile(
      path.join(root, 'main.tf'),
      'resource "aws_apigatewayv2_api" "http_api" { name = "MyHTTPAPI" protocol_type = "HTTP" }',
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('api-gateway');
  });

  it('detects appsync from aws_appsync_graphql_api resource', async () => {
    const root = await makeTempDir();
    await writeFile(
      path.join(root, 'main.tf'),
      'resource "aws_appsync_graphql_api" "gql" { name = "MyGraphQL" authentication_type = "API_KEY" }',
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('appsync');
  });

  it('detects eventbridge-schemas from aws_schemas_schema resource', async () => {
    const root = await makeTempDir();
    await writeFile(
      path.join(root, 'main.tf'),
      'resource "aws_schemas_schema" "order_schema" { name = "OrderCreated" registry_name = "my-registry" }',
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('eventbridge-schemas');
  });

  it('detects eventbridge-schemas from aws_cloudwatch_event_bus resource', async () => {
    const root = await makeTempDir();
    await writeFile(
      path.join(root, 'main.tf'),
      'resource "aws_cloudwatch_event_bus" "orders" { name = "orders" }',
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('eventbridge-schemas');
  });

  it('detects glue from aws_glue_schema resource', async () => {
    const root = await makeTempDir();
    await writeFile(
      path.join(root, 'main.tf'),
      'resource "aws_glue_schema" "product" { schema_name = "product" registry_arn = "arn:aws:glue:us-east-1:123456789012:registry/my-registry" data_format = "AVRO" compatibility = "NONE" schema_definition = "{}" }',
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('glue');
  });

  it('detects multiple providers from a single .tf file', async () => {
    const root = await makeTempDir();
    await writeFile(
      path.join(root, 'main.tf'),
      [
        'resource "aws_api_gateway_rest_api" "api" { name = "API" }',
        'resource "aws_appsync_graphql_api" "gql" { name = "GQL" authentication_type = "API_KEY" }',
      ].join('\n'),
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('api-gateway');
    expect(signals.providerHints).toContain('appsync');
  });

  it('detects providers from .tf files in subdirectories', async () => {
    const root = await makeTempDir();
    const infra = path.join(root, 'infra');
    await mkdir(infra);
    await writeFile(
      path.join(infra, 'api.tf'),
      'resource "aws_api_gateway_rest_api" "api" { name = "API" }',
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('api-gateway');
  });
});

describe('Pulumi provider patterns via collectRepoSignals', () => {
  it('detects api-gateway from aws.apigateway.RestApi in TypeScript Pulumi program', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'Pulumi.yaml'), 'name: my-stack\nruntime: nodejs\n');
    await writeFile(
      path.join(root, 'index.ts'),
      'const api = new aws.apigateway.RestApi("my-api", { name: "MyAPI" });',
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('api-gateway');
  });

  it('detects api-gateway from aws.apigatewayv2.Api in TypeScript Pulumi program', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'Pulumi.yaml'), 'name: my-stack\nruntime: nodejs\n');
    await writeFile(
      path.join(root, 'index.ts'),
      'const api = new aws.apigatewayv2.Api("http-api", { protocolType: "HTTP" });',
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('api-gateway');
  });

  it('detects appsync from aws.appsync.GraphQLApi in TypeScript Pulumi program', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'Pulumi.yaml'), 'name: my-stack\nruntime: nodejs\n');
    await writeFile(
      path.join(root, 'index.ts'),
      'const gql = new aws.appsync.GraphQLApi("my-api", { authenticationType: "API_KEY" });',
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('appsync');
  });

  it('does not scan Pulumi source files when Pulumi.yaml is absent', async () => {
    const root = await makeTempDir();
    await writeFile(
      path.join(root, 'index.ts'),
      'const api = new aws.apigateway.RestApi("my-api", {});',
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints ?? []).not.toContain('api-gateway');
  });

  it('detects appsync from aws.appsync.GraphQLApi in Python Pulumi program', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'Pulumi.yaml'), 'name: my-stack\nruntime: python\n');
    await writeFile(
      path.join(root, '__main__.py'),
      'api = aws.appsync.GraphQLApi("my-api", authentication_type="API_KEY")',
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('appsync');
  });
});

#!/usr/bin/env node
/* global console, process */
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  const inline = process.argv.find((value) => value.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : fallback;
}

const surface = arg('surface', 'repo-openapi');
const region = arg('region', process.env.AWS_REGION ?? 'us-east-1');
const keepWorkspace = arg('keep-workspace', 'false') === 'true';
const repoRoot = process.cwd();
const cli = path.join(repoRoot, 'dist', 'cli.cjs');
const workspace = await mkdtemp(path.join(os.tmpdir(), `spec-discovery-${surface}-`));

async function seedSurface() {
  switch (surface) {
    case 'repo-openapi':
      await cp(path.join(repoRoot, 'validation/fixtures/repo-spec/openapi-3.0.yaml'), path.join(workspace, 'openapi.yaml'));
      break;
    case 'repo-graphql':
      await cp(path.join(repoRoot, 'validation/fixtures/repo-spec/schema.graphql'), path.join(workspace, 'schema.graphql'));
      break;
    case 'repo-asyncapi':
      await cp(path.join(repoRoot, 'validation/fixtures/repo-spec/asyncapi.yaml'), path.join(workspace, 'asyncapi.yaml'));
      break;
    case 'backstage':
      await cp(path.join(repoRoot, 'validation/fixtures/repo-spec/openapi-3.0.yaml'), path.join(workspace, 'openapi.yaml'));
      await writeFile(path.join(workspace, 'catalog-info.yaml'), [
        'apiVersion: backstage.io/v1alpha1',
        'kind: API',
        'metadata:',
        '  name: validation-local-openapi',
        'spec:',
        '  type: openapi',
        '  definition: ./openapi.yaml'
      ].join('\n'));
      break;
    case 'iac-signals':
      await mkdir(path.join(workspace, '.github/workflows'), { recursive: true });
      await cp(path.join(repoRoot, 'validation/fixtures/iac/cloudformation/template.yaml'), path.join(workspace, 'template.yaml'));
      await cp(path.join(repoRoot, 'validation/fixtures/iac/readme/README.md'), path.join(workspace, 'README.md'));
      await cp(path.join(repoRoot, 'validation/fixtures/iac/workflow/deploy.yml'), path.join(workspace, '.github/workflows/deploy.yml'));
      break;
    case 'discover-many':
      break;
    default:
      throw new Error(`Unsupported surface seed: ${surface}`);
  }
}

try {
  await seedSurface();
  const stdout = execFileSync('node', [
    cli,
    '--mode', surface === 'discover-many' ? 'discover-many' : 'resolve-one',
    '--aws-region', region,
    '--repo-root', workspace,
    '--output-dir', 'discovered-specs',
    '--result-json', 'result.json'
  ], {
    cwd: workspace,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  const result = JSON.parse(await readFile(path.join(workspace, 'result.json'), 'utf8'));
  console.log(JSON.stringify({ workspace, result, stdout: JSON.parse(stdout) }, null, 2));
} finally {
  if (!keepWorkspace) {
    await rm(workspace, { recursive: true, force: true });
  }
}

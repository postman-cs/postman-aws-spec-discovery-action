#!/usr/bin/env node
/* global console, process */
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = process.cwd();

const required = [
  'validation/fixtures/repo-spec/openapi-3.0.yaml',
  'validation/fixtures/repo-spec/openapi-3.1.json',
  'validation/fixtures/repo-spec/swagger-2.0.yaml',
  'validation/fixtures/repo-spec/schema.graphql',
  'validation/fixtures/repo-spec/asyncapi.yaml',
  'validation/fixtures/repo-spec/collection.postman_collection.json',
  'validation/fixtures/repo-spec/service.proto',
  'validation/fixtures/repo-spec/model.smithy',
  'validation/fixtures/repo-spec/smithy-build.json',
  'validation/fixtures/backstage/catalog-info.yaml',
  'validation/fixtures/backstage/catalog-info.yml',
  'validation/fixtures/aws/live-stack.yaml',
  'validation/fixtures/iac/cloudformation/template.yaml',
  'validation/fixtures/iac/cloudformation/lambda-url.yaml',
  'validation/fixtures/iac/terraform/main.tf',
  'validation/fixtures/iac/cdk/cdk.json',
  'validation/fixtures/iac/cdk/lib/app.ts',
  'validation/fixtures/iac/pulumi/Pulumi.yaml',
  'validation/fixtures/iac/pulumi/index.ts',
  'validation/fixtures/iac/workflow/deploy.yml',
  'validation/fixtures/iac/readme/README.md',
  'validation/fixtures/iac/graphql/schema.graphql',
  'validation/scripts/validate-repo-spec-matrix.mjs',
  'validation/scripts/validate-iac-signals.mjs',
  'validation/scripts/validate-live-aws-surfaces.mjs'
];

const markerChecks = [
  ['validation/fixtures/repo-spec/openapi-3.0.yaml', 'openapi: 3.0.3'],
  ['validation/fixtures/repo-spec/openapi-3.1.json', '"openapi": "3.1.0"'],
  ['validation/fixtures/repo-spec/swagger-2.0.yaml', "swagger: '2.0'"],
  ['validation/fixtures/repo-spec/schema.graphql', 'type Query'],
  ['validation/fixtures/repo-spec/asyncapi.yaml', 'asyncapi: 2.6.0'],
  ['validation/fixtures/repo-spec/collection.postman_collection.json', 'schema.getpostman.com/json/collection'],
  ['validation/fixtures/repo-spec/service.proto', 'syntax = "proto3"'],
  ['validation/fixtures/repo-spec/model.smithy', '$version: "2"'],
  ['validation/fixtures/iac/terraform/main.tf', 'aws_lambda_function_url'],
  ['validation/fixtures/iac/readme/README.md', 'lambda-url.us-east-1.on.aws']
];

const missing = [];
for (const file of required) {
  try {
    await access(path.join(repoRoot, file));
  } catch {
    missing.push(file);
  }
}

const failedMarkers = [];
for (const [file, marker] of markerChecks) {
  const content = await readFile(path.join(repoRoot, file), 'utf8').catch(() => '');
  if (!content.includes(marker)) {
    failedMarkers.push(`${file} missing marker ${marker}`);
  }
}

if (missing.length > 0 || failedMarkers.length > 0) {
  for (const entry of missing) console.error(`missing: ${entry}`);
  for (const entry of failedMarkers) console.error(`invalid: ${entry}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: 'ok', checkedFiles: required.length, markerChecks: markerChecks.length }, null, 2));
}

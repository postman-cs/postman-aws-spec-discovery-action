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
  'validation/fixtures/repo-spec/order.schema.json',
  'validation/fixtures/repo-spec/order.avsc',
  'validation/fixtures/repo-spec/service.proto',
  'validation/fixtures/repo-spec/model.smithy',
  'validation/fixtures/repo-spec/smithy-build.json',
  'validation/fixtures/backstage/catalog-info.yaml',
  'validation/fixtures/backstage/catalog-info.yml',
  'validation/fixtures/aws/live-stack.yaml',
  'validation/fixtures/aws/p3-surfaces.json',
  'validation/fixtures/iac/cloudformation/template.yaml',
  'validation/fixtures/iac/cloudformation/lambda-url.yaml',
  'validation/fixtures/iac/terraform/main.tf',
  'validation/fixtures/iac/cdk/cdk.json',
  'validation/fixtures/iac/cdk/lib/app.ts',
  'validation/fixtures/iac/cdk/lib/app.py',
  'validation/fixtures/iac/pulumi/Pulumi.yaml',
  'validation/fixtures/iac/pulumi/index.ts',
  'validation/fixtures/iac/backstage/services/orders/catalog-info.yaml',
  'validation/fixtures/iac/backstage/services/orders/openapi.yaml',
  'validation/fixtures/iac/deployment/helm/orders/templates/ingress.yaml',
  'validation/fixtures/iac/deployment/k8s/ingress.yaml',
  'validation/fixtures/iac/deployment/docker-compose.yml',
  'validation/fixtures/iac/deployment/ecs/task-definition.json',
  'validation/fixtures/iac/deployment/spring/application.yml',
  'validation/fixtures/iac/deployment/dotnet/appsettings.json',
  'validation/fixtures/iac/workflow/deploy.yml',
  'validation/fixtures/iac/readme/README.md',
  'validation/fixtures/iac/graphql/schema.graphql',
  'validation/runbooks/aws-derived-surfaces.md',
  'validation/scripts/validate-repo-spec-matrix.mjs',
  'validation/scripts/validate-iac-signals.mjs',
  'validation/scripts/validate-p3-surfaces.mjs',
  'validation/scripts/validate-live-aws-surfaces.mjs',
  'validation/support-ledger.json',
  'validation/SUPPORT_LEDGER.md',
  'validation/scripts/validate-support-ledger.mjs',
  'validation/scripts/validate-resolution-closure.mjs',
  'validation/scripts/emit-live-required-matrix.mjs',
  'validation/fixtures/closure/github-org-repo-tags/expected-contracts.json',
  'validation/fixtures/closure/json-schema/order.schema.json',
  'validation/fixtures/closure/avro/order.avsc',
  'validation/fixtures/closure/smithy-project/smithy-build.json',
  'validation/fixtures/closure/graphql-multi/graphql/schema.graphql',
  'validation/fixtures/closure/monorepo/packages/orders/openapi.yaml',
  'validation/fixtures/closure/backstage-multi/catalog-info.yaml',
  'validation/fixtures/closure/iac-static/cfn-inline/template.yaml',
  'validation/fixtures/closure/iac-static/cdk-assembly/cdk.out/manifest.json',
  'validation/fixtures/closure/iac-static/terraform-literal/main.tf',
  'validation/fixtures/closure/iac-static/serverless-static/serverless.yml',
  'validation/fixtures/closure/adversarial/remote/catalog-info.yaml',
  'validation/fixtures/closure/provenance/resolution.example.json',
];

const markerChecks = [
  ['validation/fixtures/repo-spec/openapi-3.0.yaml', 'openapi: 3.0.3'],
  ['validation/fixtures/repo-spec/openapi-3.1.json', '"openapi": "3.1.0"'],
  ['validation/fixtures/repo-spec/swagger-2.0.yaml', "swagger: '2.0'"],
  ['validation/fixtures/repo-spec/schema.graphql', 'type Query'],
  ['validation/fixtures/repo-spec/asyncapi.yaml', 'asyncapi: 2.6.0'],
  ['validation/fixtures/repo-spec/collection.postman_collection.json', 'schema.getpostman.com/json/collection'],
  ['validation/fixtures/repo-spec/order.schema.json', '"title": "OrderCreated"'],
  ['validation/fixtures/repo-spec/order.avsc', '"name": "OrderEvent"'],
  ['validation/fixtures/repo-spec/service.proto', 'syntax = "proto3"'],
  ['validation/fixtures/repo-spec/model.smithy', '$version: "2"'],
  ['validation/fixtures/aws/live-stack.yaml', 'Name: OrderMessage'],
  ['validation/fixtures/aws/p3-surfaces.json', '"orders-rule"'],
  ['validation/fixtures/aws/p3-surfaces.json', '"orders-pipe"'],
  ['validation/fixtures/aws/p3-surfaces.json', '"orders-workflow"'],
  ['validation/fixtures/aws/live-stack.yaml', 'RouteResponseKey:'],
  ['validation/fixtures/aws/live-stack.yaml', 'FilterPolicyScope: MessageBody'],
  ['validation/fixtures/aws/live-stack.yaml', 'RedrivePolicy:'],
  ['validation/fixtures/iac/terraform/main.tf', 'aws_lambda_function_url'],
  ['validation/fixtures/iac/cdk/lib/app.py', 'aws_apigatewayv2'],
  ['validation/fixtures/iac/pulumi/Pulumi.yaml', 'aws:apigatewayv2/api:Api'],
  ['validation/fixtures/iac/backstage/services/orders/catalog-info.yaml', 'kind: API'],
  ['validation/fixtures/iac/deployment/helm/orders/templates/ingress.yaml', 'api.orders.example.test'],
  ['validation/fixtures/iac/deployment/docker-compose.yml', 'abc123def4.execute-api'],
  ['validation/fixtures/iac/deployment/spring/application.yml', 'lambda-url.us-east-1.on.aws'],
  ['validation/fixtures/iac/readme/README.md', 'lambda-url.us-east-1.on.aws'],
  ['validation/runbooks/aws-derived-surfaces.md', 'live-validated against dedicated resources'],
  ['validation/support-ledger.json', '"schemaVersion": 1'],
  ['validation/fixtures/closure/github-org-repo-tags/expected-contracts.json', 'GithubOrg+GithubRepo'],
  ['validation/fixtures/closure/provenance/latest-configuration.example.json', 'latest-configuration'],
  ['validation/fixtures/closure/iac-static/cdk-assembly/cdk.out/OrdersStack.template.json', 'openapi'],
  ['docs/providers.md', 'deny-by-default'],
  ['docs/providers.md', 'remote-fetch-allowlist-json'],
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

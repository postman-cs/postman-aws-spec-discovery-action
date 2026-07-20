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

  it('stops when maxInspectedEntries is reached and returns sorted paths', async () => {
    const root = await makeTempDir();
    for (let i = 0; i < 20; i++) {
      await writeFile(path.join(root, `file${String(i).padStart(2, '0')}.tf`), '');
    }

    const files = await findIaCFiles(root, ['.tf'], 0, { value: 0 }, { maxInspectedEntries: 5 });
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeLessThanOrEqual(5);
    expect(files).toEqual([...files].sort((a, b) => a.localeCompare(b)));
  });

  it('stops when maxElapsedMs is exhausted and returns sorted paths', async () => {
    const root = await makeTempDir();
    for (let i = 0; i < 20; i++) {
      await writeFile(path.join(root, `file${String(i).padStart(2, '0')}.tf`), '');
    }

    const files = await findIaCFiles(root, ['.tf'], 0, { value: 0 }, { maxElapsedMs: 0 });
    expect(files.length).toBeLessThan(20);
    expect(files).toEqual([...files].sort((a, b) => a.localeCompare(b)));
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

describe('SNS provider patterns via collectRepoSignals', () => {
  it('detects sns from CloudFormation AWS::SNS::Topic', async () => {
    const root = await makeTempDir();
    await writeFile(
      path.join(root, 'template.yaml'),
      ['Resources:', '  Topic:', '    Type: AWS::SNS::Topic'].join('\n'),
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('sns');
  });

  it('detects sns from CloudFormation AWS::SNS::Subscription', async () => {
    const root = await makeTempDir();
    await writeFile(
      path.join(root, 'template.yaml'),
      ['Resources:', '  Subscription:', '    Type: AWS::SNS::Subscription'].join('\n'),
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('sns');
  });

  it('detects sns from SAM SNS event bindings', async () => {
    const root = await makeTempDir();
    await writeFile(
      path.join(root, 'template.yaml'),
      [
        'Resources:',
        '  HandlerFunction:',
        '    Type: AWS::Serverless::Function',
        '    Properties:',
        '      Events:',
        '        TopicEvent:',
        '          Type: SNS',
      ].join('\n'),
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('sns');
  });

  it('detects sns from SNS ARN references', async () => {
    const root = await makeTempDir();
    await writeFile(
      path.join(root, 'template.yaml'),
      'TopicArn: arn:aws:sns:us-east-1:123456789012:orders-topic',
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('sns');
  });

  it('does not detect sns from README examples while still extracting gateway IDs', async () => {
    const root = await makeTempDir();
    await writeFile(
      path.join(root, 'README.md'),
      [
        'Supports AWS::SNS::Topic in examples.',
        'Use https://abc123def4.execute-api.us-east-1.amazonaws.com/prod for smoke tests.',
      ].join('\n'),
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints ?? []).not.toContain('sns');
    expect(signals.inferredGatewayIdHints).toContain('abc123def4');
  });

  it('detects explicit README SNS/EventBridge bridge descriptions', async () => {
    const root = await makeTempDir();
    await writeFile(
      path.join(root, 'README.md'),
      'SNS bridge: messages are delivered to Lambda and then published to EventBridge.',
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('sns');
    expect(signals.providerHints).toContain('eventbridge-schemas');
    expect(signals.evidence.some((entry) => entry.includes('Detected SNS/EventBridge bridge pattern'))).toBe(true);
  });

  it('detects sns from Terraform aws_sns_topic resource', async () => {
    const root = await makeTempDir();
    await writeFile(
      path.join(root, 'main.tf'),
      'resource "aws_sns_topic" "orders" { name = "orders-topic" }',
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('sns');
  });

  it('detects sns from Terraform aws_sns_topic_subscription resource', async () => {
    const root = await makeTempDir();
    await writeFile(
      path.join(root, 'main.tf'),
      'resource "aws_sns_topic_subscription" "orders" { topic_arn = "arn:aws:sns:us-east-1:123456789012:orders-topic" protocol = "sqs" endpoint = "arn:aws:sqs:us-east-1:123456789012:orders-queue" }',
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('sns');
  });

  it('detects sns from CDK TypeScript source when cdk.json exists', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'cdk.json'), JSON.stringify({ app: 'npx ts-node bin/app.ts' }));
    await writeFile(
      path.join(root, 'stack.ts'),
      [
        "import * as sns from 'aws-cdk-lib/aws-sns';",
        'const topic = new sns.Topic(this, "OrdersTopic");',
      ].join('\n'),
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('sns');
  });

  it('detects api-gateway and appsync from CDK TypeScript source when cdk.json exists', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'cdk.json'), JSON.stringify({ app: 'npx ts-node bin/app.ts' }));
    await writeFile(
      path.join(root, 'stack.ts'),
      [
        "import * as apigateway from 'aws-cdk-lib/aws-apigateway';",
        "import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';",
        "import * as appsync from 'aws-cdk-lib/aws-appsync';",
        'new apigateway.RestApi(this, "OrdersRestApi");',
        'new apigatewayv2.HttpApi(this, "OrdersHttpApi");',
        'new appsync.GraphqlApi(this, "OrdersGraphqlApi", {});',
      ].join('\n'),
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('api-gateway');
    expect(signals.providerHints).toContain('appsync');
  });

  it('detects sns from CDK sns.Topic.fromTopicArn usage when cdk.json exists', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'cdk.json'), JSON.stringify({ app: 'npx ts-node bin/app.ts' }));
    await writeFile(
      path.join(root, 'stack.ts'),
      'const topic = sns.Topic.fromTopicArn(this, "OrdersTopic", "arn:aws:sns:us-east-1:123456789012:orders-topic");',
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('sns');
  });

  it('detects sns from CDK SnsEventSource usage when cdk.json exists', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'cdk.json'), JSON.stringify({ app: 'npx ts-node bin/app.ts' }));
    await writeFile(
      path.join(root, 'stack.ts'),
      'const source = new SnsEventSource(topic);',
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('sns');
  });

  it('detects sns from Pulumi TypeScript source', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'Pulumi.yaml'), 'name: my-stack\nruntime: nodejs\n');
    await writeFile(
      path.join(root, 'index.ts'),
      'const topic = new aws.sns.Topic("orders-topic", {});',
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('sns');
  });

  it('detects asyncapi.yml as SNS contract evidence when SNS IaC is present', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'template.yaml'), 'Type: AWS::SNS::Topic');
    await writeFile(path.join(root, 'asyncapi.yml'), 'asyncapi: 2.6.0');

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('sns');
    expect(signals.evidence.some((entry) => entry.includes('asyncapi.yml'))).toBe(true);
  });

  it('detects asyncapi.yaml as SNS contract evidence when SNS IaC is present', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'template.yaml'), 'Type: AWS::SNS::Topic');
    await writeFile(path.join(root, 'asyncapi.yaml'), 'asyncapi: 2.6.0');

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('sns');
    expect(signals.evidence.some((entry) => entry.includes('asyncapi.yaml'))).toBe(true);
  });

  it('detects asyncapi.json as SNS contract evidence when SNS IaC is present', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'main.tf'), 'resource "aws_sns_topic" "orders" {}');
    await writeFile(path.join(root, 'asyncapi.json'), JSON.stringify({ asyncapi: '2.6.0' }));

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('sns');
    expect(signals.evidence.some((entry) => entry.includes('asyncapi.json'))).toBe(true);
  });

  it('detects *.schema.json as SNS contract evidence when SNS IaC is present', async () => {
    const root = await makeTempDir();
    await mkdir(path.join(root, 'schemas'));
    await writeFile(path.join(root, 'template.yaml'), 'Type: AWS::SNS::Topic');
    await writeFile(path.join(root, 'schemas', 'orders.schema.json'), '{}');

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('sns');
    expect(signals.evidence.some((entry) => entry.includes('orders.schema.json'))).toBe(true);
  });

  it('does not infer sns from event contract files without SNS IaC', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'asyncapi.yaml'), 'asyncapi: 2.6.0');
    await writeFile(
      path.join(root, 'main.tf'),
      'resource "aws_api_gateway_rest_api" "my_api" { name = "MyAPI" }',
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints ?? []).not.toContain('sns');
    expect(signals.providerHints).toContain('api-gateway');
  });

  it('flags bridge evidence when CloudFormation/SAM includes SNS-to-Lambda-to-EventBridge pipeline hints', async () => {
    const root = await makeTempDir();
    await writeFile(
      path.join(root, 'template.yaml'),
      [
        'Resources:',
        '  Topic:',
        '    Type: AWS::SNS::Topic',
        '  HandlerFunction:',
        '    Type: AWS::Serverless::Function',
        '    Properties:',
        '      Events:',
        '        TopicEvent:',
        '          Type: SNS',
        '  BridgeRule:',
        '    Type: AWS::Events::Rule'
      ].join('\n'),
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('sns');
    expect(signals.providerHints).toContain('eventbridge-schemas');
    expect(signals.evidence.some((entry) => entry.includes('Detected SNS/EventBridge bridge pattern'))).toBe(true);
  });

  it('flags bridge evidence when Terraform includes sns topic/subscription and event bus resources', async () => {
    const root = await makeTempDir();
    await writeFile(
      path.join(root, 'main.tf'),
      [
        'resource "aws_sns_topic" "orders" { name = "orders-topic" }',
        'resource "aws_sns_topic_subscription" "orders" { topic_arn = aws_sns_topic.orders.arn protocol = "lambda" endpoint = aws_lambda_function.handler.arn }',
        'resource "aws_cloudwatch_event_bus" "orders" { name = "orders" }'
      ].join('\n'),
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('sns');
    expect(signals.providerHints).toContain('eventbridge-schemas');
    expect(signals.evidence.some((entry) => entry.includes('Detected SNS/EventBridge bridge pattern'))).toBe(true);
  });

  it('flags bridge evidence when CDK includes SnsEventSource and EventBridge usage', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'cdk.json'), JSON.stringify({ app: 'npx ts-node bin/app.ts' }));
    await writeFile(
      path.join(root, 'stack.ts'),
      [
        "import * as sns from 'aws-cdk-lib/aws-sns';",
        "import { SnsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';",
        "import * as events from 'aws-cdk-lib/aws-events';",
        'new SnsEventSource(topic);',
        'new events.EventBus(this, "BridgeBus");'
      ].join('\n'),
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('sns');
    expect(signals.providerHints).toContain('eventbridge-schemas');
    expect(signals.evidence.some((entry) => entry.includes('Detected SNS/EventBridge bridge pattern'))).toBe(true);
  });
});

describe('Lambda Function URL provider patterns via collectRepoSignals', () => {
  it('detects lambda-url from CloudFormation AWS::Lambda::Url', async () => {
    const root = await makeTempDir();
    await writeFile(
      path.join(root, 'template.yaml'),
      ['Resources:', '  FnUrl:', '    Type: AWS::Lambda::Url'].join('\n'),
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('lambda-url');
  });

  it('detects lambda-url from SAM FunctionUrlConfig', async () => {
    const root = await makeTempDir();
    await writeFile(
      path.join(root, 'template.yaml'),
      [
        'Resources:',
        '  Handler:',
        '    Type: AWS::Serverless::Function',
        '    Properties:',
        '      FunctionUrlConfig:',
        '        AuthType: NONE',
      ].join('\n'),
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('lambda-url');
  });

  it('detects lambda-url from Terraform aws_lambda_function_url resource', async () => {
    const root = await makeTempDir();
    await writeFile(
      path.join(root, 'main.tf'),
      'resource "aws_lambda_function_url" "orders" { function_name = aws_lambda_function.orders.function_name authorization_type = "NONE" }',
    );

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('lambda-url');
  });

  it('detects lambda-url from CDK addFunctionUrl usage', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'cdk.json'), JSON.stringify({ app: 'npx ts-node bin/app.ts' }));
    await writeFile(path.join(root, 'stack.ts'), 'handler.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });');

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('lambda-url');
  });

  it('detects lambda-url from Pulumi aws.lambda.FunctionUrl usage', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'Pulumi.yaml'), 'name: my-stack\nruntime: nodejs\n');
    await writeFile(path.join(root, 'index.ts'), 'const url = new aws.lambda.FunctionUrl("orders", { authorizationType: "NONE" });');

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('lambda-url');
  });

  it('extracts Lambda Function URL host hints from README', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'README.md'), 'Smoke test https://abc123.lambda-url.us-east-1.on.aws/orders');

    const signals = await collectRepoSignals(root);
    expect(signals.providerHints).toContain('lambda-url');
    expect(signals.lambdaUrlHints).toContain('abc123.lambda-url.us-east-1.on.aws');
  });
});

import { cp, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  contentBearingIacCandidates,
  resolveStaticIacCandidates,
  SUPPORTED_CDK_ASSEMBLY_MAJOR_MAX
} from '../src/lib/iac/index.js';
import { collectRepoSignals } from '../src/lib/repo/signals.js';
import { inventoryRepoSpecs } from '../src/lib/repo/specs.js';

const FIXTURES = path.join(__dirname, 'fixtures', 'iac-static');
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function withFixture(name: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `iac-static-${name}-`));
  tempDirs.push(tempDir);
  await cp(path.join(FIXTURES, name), tempDir, { recursive: true });
  return tempDir;
}

describe('resolveStaticIacCandidates — CloudFormation/SAM', () => {
  it('resolves inline Body OpenAPI as authored', async () => {
    const root = await withFixture('cfn-inline');
    const result = await resolveStaticIacCandidates(root);
    const inline = result.candidates.filter((c) => c.kind === 'openapi-inline');
    expect(inline).toHaveLength(1);
    expect(inline[0]?.artifactClass).toBe('authored');
    expect(inline[0]?.content).toContain('/orders');
    expect(inline[0]?.logicalId).toBe('OrdersApi');
  });

  it('resolves local DefinitionUri', async () => {
    const root = await withFixture('cfn-local-uri');
    const result = await resolveStaticIacCandidates(root);
    const local = result.candidates.find((c) => c.kind === 'openapi-local-ref');
    expect(local?.content).toContain('listOrders');
    expect(local?.source).toMatch(/sam|cloudformation/);
  });

  it('resolves exact S3 BodyS3Location and DefinitionUri via injected client', async () => {
    const root = await withFixture('cfn-s3');
    const openapi = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'S3', version: '1.0.0' },
      paths: { '/s3': { get: { responses: { '200': { description: 'ok' } } } } }
    });
    const s3Client = {
      getObject: vi.fn().mockResolvedValue(openapi)
    };
    const result = await resolveStaticIacCandidates(root, { s3Client });
    const s3Candidates = result.candidates.filter((c) => c.kind === 'openapi-s3-ref');
    expect(s3Candidates.length).toBeGreaterThanOrEqual(2);
    expect(s3Client.getObject).toHaveBeenCalledWith('my-specs', 'openapi/orders.json', '3');
    expect(s3Client.getObject).toHaveBeenCalledWith('my-specs', 'openapi/orders.json', undefined);
    expect(s3Candidates.every((c) => c.content?.includes('/s3'))).toBe(true);
  });

  it('follows nested local templates and preserves remote nested as unresolved', async () => {
    const root = await withFixture('cfn-nested');
    const result = await resolveStaticIacCandidates(root);
    const nested = result.candidates.find((c) => c.logicalId === 'NestedApi' && c.kind === 'openapi-inline');
    expect(nested?.content).toContain('/nested');
    const unresolved = result.candidates.find(
      (c) => c.kind === 'unresolved-evidence' && c.logicalId === 'RemoteNested'
    );
    expect(unresolved?.unresolvedExpression).toMatch(/example\.com|Fn::Sub/);
  });

  it('preserves unresolved intrinsics as evidence and never invents routes', async () => {
    const root = await withFixture('cfn-unresolved');
    const result = await resolveStaticIacCandidates(root);
    const unresolved = result.candidates.filter((c) => c.kind === 'unresolved-evidence');
    expect(unresolved.length).toBeGreaterThanOrEqual(2);
    expect(result.candidates.every((c) => !c.content || !c.content.includes('/invented'))).toBe(true);
    expect(contentBearingIacCandidates(result)).toHaveLength(0);
  });

  it('extracts literal physical API IDs and redacts sensitive outputs', async () => {
    const root = await withFixture('cfn-outputs');
    const result = await resolveStaticIacCandidates(root);
    expect(result.physicalApiIds).toContain('abcdef1234');
    const redacted = result.candidates.find((c) => c.logicalId === 'ApiSecretToken');
    expect(redacted?.unresolvedExpression).toBe('[redacted]');
    const dynamic = result.candidates.find((c) => c.logicalId === 'DynamicApiId');
    expect(dynamic?.kind).toBe('unresolved-evidence');
  });

  it('records missing DefinitionUri targets without inventing content', async () => {
    const root = await withFixture('missing-file');
    const result = await resolveStaticIacCandidates(root);
    expect(result.errors.some((e) => e.code === 'missing-file')).toBe(true);
    expect(contentBearingIacCandidates(result)).toHaveLength(0);
  });
});

describe('resolveStaticIacCandidates — CDK', () => {
  it('follows cloud assembly manifest into templates with schema version evidence', async () => {
    const root = await withFixture('cdk-assembly');
    const result = await resolveStaticIacCandidates(root, {
      enabledSources: { cloudformation: false, sam: false, terraform: false, serverless: false, cdk: true }
    });
    const inline = result.candidates.find((c) => c.kind === 'openapi-inline' && c.logicalId === 'OrdersApi');
    expect(inline?.schemaVersion).toBe('36.0.0');
    expect(inline?.content).toContain('/orders');
    expect(result.physicalApiIds).toContain('cdkapiid01');
    const asset = result.candidates.find((c) => c.id.includes('OrdersStackAssets'));
    expect(asset?.kind).toBe('unresolved-evidence');
  });

  it('follows nested cloud assemblies', async () => {
    const root = await withFixture('cdk-nested');
    const result = await resolveStaticIacCandidates(root, {
      enabledSources: { cloudformation: false, sam: false, terraform: false, serverless: false, cdk: true }
    });
    const child = result.candidates.find((c) => c.logicalId === 'ChildApi' && c.kind === 'openapi-inline');
    expect(child?.content).toContain('/orders');
    expect(child?.sourcePath).toContain('assembly-Nested');
    expect(child?.evidence.some((e) => /nested CDK assembly/i.test(e))).toBe(true);
  });

  it('rejects unsupported manifest schema versions', async () => {
    const root = await withFixture('cdk-unsupported-version');
    const result = await resolveStaticIacCandidates(root, {
      enabledSources: { cloudformation: false, sam: false, terraform: false, serverless: false, cdk: true }
    });
    expect(result.errors.some((e) => e.code === 'unsupported-manifest')).toBe(true);
    const unresolved = result.candidates.find((c) => c.kind === 'unresolved-evidence' && c.schemaVersion === '99.0.0');
    expect(unresolved?.evidence.join(' ')).toContain(String(SUPPORTED_CDK_ASSEMBLY_MAJOR_MAX));
    expect(contentBearingIacCandidates(result)).toHaveLength(0);
  });

  it('classifies stale generated artifacts when sources are newer', async () => {
    const root = await withFixture('cdk-stale');
    const past = new Date('2020-01-01T00:00:00Z');
    const future = new Date('2026-06-01T00:00:00Z');
    await utimes(path.join(root, 'cdk.out', 'StaleStack.template.json'), past, past);
    await utimes(path.join(root, 'cdk.out', 'manifest.json'), past, past);
    await utimes(path.join(root, 'cdk.json'), future, future);
    const result = await resolveStaticIacCandidates(root, {
      enabledSources: { cloudformation: false, sam: false, terraform: false, serverless: false, cdk: true }
    });
    const inline = result.candidates.find((c) => c.kind === 'openapi-inline');
    expect(inline?.artifactClass).toBe('generated-stale');
  });
});

describe('resolveStaticIacCandidates — Terraform/OpenTofu', () => {
  it('parses literal heredoc bodies and output API IDs', async () => {
    const root = await withFixture('terraform-literal');
    const result = await resolveStaticIacCandidates(root, {
      enabledSources: { cloudformation: false, sam: false, cdk: false, serverless: false, terraform: true }
    });
    const body = result.candidates.find((c) => c.kind === 'openapi-inline');
    expect(body?.content).toContain('/orders');
    expect(result.physicalApiIds).toContain('tfapiid001');
  });

  it('resolves literal file() references and physical IDs', async () => {
    const root = await withFixture('terraform-file');
    const result = await resolveStaticIacCandidates(root, {
      enabledSources: { cloudformation: false, sam: false, cdk: false, serverless: false, terraform: true }
    });
    const fileRef = result.candidates.find((c) => c.kind === 'openapi-local-ref');
    expect(fileRef?.content).toContain('listOrders');
    expect(result.physicalApiIds).toContain('tfhttpapi1');
  });

  it('leaves dynamic expressions unresolved without evaluating them', async () => {
    const root = await withFixture('terraform-dynamic');
    const result = await resolveStaticIacCandidates(root, {
      enabledSources: { cloudformation: false, sam: false, cdk: false, serverless: false, terraform: true }
    });
    expect(contentBearingIacCandidates(result)).toHaveLength(0);
    expect(result.candidates.some((c) => c.kind === 'unresolved-evidence')).toBe(true);
    expect(result.physicalApiIds).toHaveLength(0);
  });

  it('reads local state artifacts and redacts sensitive outputs', async () => {
    const root = await withFixture('terraform-state');
    const result = await resolveStaticIacCandidates(root, {
      enabledSources: { cloudformation: false, sam: false, cdk: false, serverless: false, terraform: true }
    });
    expect(result.physicalApiIds).toContain('stateapi01');
    const redacted = result.candidates.find((c) => c.logicalId === 'api_secret_token');
    expect(redacted?.unresolvedExpression).toBe('[redacted]');
    expect(JSON.stringify(result)).not.toContain('leaky');
  });

  it('redacts sensitive Terraform outputs while keeping literal API IDs', async () => {
    const root = await withFixture('terraform-sensitive');
    const result = await resolveStaticIacCandidates(root, {
      enabledSources: { cloudformation: false, sam: false, cdk: false, serverless: false, terraform: true }
    });
    expect(result.physicalApiIds).toContain('sensapi001');
    expect(result.physicalApiIds).not.toContain('super-secret-value');
    const redacted = result.candidates.find((c) => c.logicalId === 'api_secret_token');
    expect(redacted?.unresolvedExpression).toBe('[redacted]');
  });
});

describe('resolveStaticIacCandidates — Serverless', () => {
  it('inspects static YAML without loading plugins', async () => {
    const root = await withFixture('serverless-static');
    const result = await resolveStaticIacCandidates(root, {
      enabledSources: { cloudformation: false, sam: false, cdk: false, terraform: false, serverless: true }
    });
    const local = result.candidates.find((c) => c.kind === 'openapi-local-ref' && c.source === 'serverless');
    expect(local?.content).toContain('/orders');
  });

  it('reads existing package artifacts and deployed output handoff', async () => {
    const root = await withFixture('serverless-package');
    const result = await resolveStaticIacCandidates(root, {
      enabledSources: { cloudformation: false, sam: false, cdk: false, terraform: false, serverless: true },
      deployedStackOutputs: {
        'orders-prod': {
          HttpApiId: 'deployed01',
          ApiSecretToken: 'should-redact'
        }
      }
    });
    expect(result.candidates.some((c) => c.kind === 'openapi-inline' && c.content?.includes('/orders'))).toBe(true);
    expect(result.physicalApiIds).toEqual(expect.arrayContaining(['slspkgapi1', 'deployed01']));
    expect(JSON.stringify(result)).not.toContain('should-redact');
  });

  it('refuses Serverless JS/TS config execution', async () => {
    const root = await withFixture('serverless-js-refused');
    const result = await resolveStaticIacCandidates(root, {
      enabledSources: { cloudformation: false, sam: false, cdk: false, terraform: false, serverless: true }
    });
    expect(result.errors.some((e) => /JavaScript|TypeScript|refusing/i.test(e.message))).toBe(true);
    expect(contentBearingIacCandidates(result)).toHaveLength(0);
  });
});

describe('resolveStaticIacCandidates — bounds and invariants', () => {
  it('enforces scan bounds', async () => {
    const root = await withFixture('cfn-inline');
    const result = await resolveStaticIacCandidates(root, { maxFiles: 0 });
    expect(result.errors.some((e) => e.code === 'bounds-exceeded') || result.candidates.length === 0).toBe(true);
  });

  it('never builds, fetches remote state, or invents routes for dynamic IaC', async () => {
    const root = await withFixture('terraform-dynamic');
    const s3Client = { getObject: vi.fn() };
    const result = await resolveStaticIacCandidates(root, { s3Client });
    expect(s3Client.getObject).not.toHaveBeenCalled();
    expect(contentBearingIacCandidates(result)).toHaveLength(0);
    expect(result.physicalApiIds).toHaveLength(0);
    expect(result.candidates.every((c) => c.kind === 'unresolved-evidence' || c.kind === 'physical-api-id')).toBe(true);
    // Source text proves we do not evaluate templatefile / remote backends.
    const joined = result.candidates.map((c) => c.unresolvedExpression ?? '').join('\n');
    expect(joined).toMatch(/templatefile|aws_api_gateway_rest_api\.orders\.id/);
  });

  it('keeps generated below authored in ranking', async () => {
    const root = await withFixture('cdk-assembly');
    await writeFile(
      path.join(root, 'template.yaml'),
      [
        "AWSTemplateFormatVersion: '2010-09-09'",
        'Resources:',
        '  AuthoredApi:',
        '    Type: AWS::ApiGateway::RestApi',
        '    Properties:',
        '      Body:',
        '        openapi: 3.0.3',
        '        info: { title: Authored, version: "1.0.0" }',
        '        paths:',
        '          /authored:',
        '            get:',
        '              responses: { "200": { description: ok } }'
      ].join('\n'),
      'utf8'
    );
    const result = await resolveStaticIacCandidates(root);
    const content = contentBearingIacCandidates(result);
    expect(content[0]?.artifactClass).toBe('authored');
    expect(content.some((c) => c.artifactClass !== 'authored')).toBe(true);
  });
});

describe('repo inventory + signals integration', () => {
  it('does not promote generated cdk.out candidates into repo-spec inventory', async () => {
    const root = await withFixture('cdk-assembly');
    const inventory = await inventoryRepoSpecs(root);
    expect(inventory.candidates.every((c) => !c.path.includes('cdk.out'))).toBe(true);
  });

  it('merges authored static IaC OpenAPI into inventory below direct authored specs', async () => {
    const root = await withFixture('cfn-inline');
    await writeFile(
      path.join(root, 'openapi.yaml'),
      ['openapi: 3.0.3', 'info:', '  title: Direct', '  version: 1.0.0', 'paths: {}'].join('\n'),
      'utf8'
    );
    const inventory = await inventoryRepoSpecs(root);
    expect(inventory.candidates[0]?.path).toBe('openapi.yaml');
    expect(inventory.candidates[0]?.artifactClass).toBe('authored');
  });

  it('hands exact physical API IDs into repo signals', async () => {
    const root = await withFixture('cfn-outputs');
    const signals = await collectRepoSignals(root);
    expect(signals.inferredGatewayIdHints).toContain('abcdef1234');
    expect(signals.evidence.some((e) => /Exact physical API ID|Physical API ID handoff/i.test(e))).toBe(true);
  });
});

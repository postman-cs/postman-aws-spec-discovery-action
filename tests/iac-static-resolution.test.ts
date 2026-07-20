import { cp, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { discoverCloudFormationTemplatePaths } from '../src/lib/iac/cloudformation.js';
import {
  contentBearingIacCandidates,
  resolveStaticIacCandidates,
  SUPPORTED_CDK_ASSEMBLY_MAJOR_MAX,
  type IacResolutionError
} from '../src/lib/iac/index.js';
import { createIacReadBudget } from '../src/lib/iac/read.js';
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

  it('rejects nested directoryName that escapes repoRoot before template-glob enumeration', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'iac-cdk-escape-parent-'));
    tempDirs.push(parent);
    const root = path.join(parent, 'repo');
    const outside = path.join(parent, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await mkdir(path.join(root, 'cdk.out', 'assembly-Valid'), { recursive: true });

    // Tempting outside artifact: no manifest, so a buggy fallback would opendir here.
    const outsideMarker = '/escape-outside-must-not-appear';
    await writeFile(
      path.join(outside, 'Escape.template.json'),
      JSON.stringify({
        Resources: {
          EscapeApi: {
            Type: 'AWS::ApiGateway::RestApi',
            Properties: {
              Body: {
                openapi: '3.0.3',
                info: { title: 'Escape', version: '1.0.0' },
                paths: {
                  [outsideMarker]: { get: { responses: { '200': { description: 'ok' } } } }
                }
              }
            }
          }
        }
      }),
      'utf8'
    );

    await writeFile(path.join(root, 'cdk.json'), JSON.stringify({ app: 'npx ts-node bin/app.ts' }), 'utf8');

    const escapeDirectoryName = path.posix.relative(
      path.posix.join(root.replace(/\\/g, '/'), 'cdk.out'),
      outside.replace(/\\/g, '/')
    );
    await writeFile(
      path.join(root, 'cdk.out', 'manifest.json'),
      JSON.stringify({
        version: '36.0.0',
        artifacts: {
          EscapeAssembly: {
            type: 'cdk:cloud-assembly',
            properties: { directoryName: escapeDirectoryName }
          },
          ValidAssembly: {
            type: 'cdk:cloud-assembly',
            properties: { directoryName: 'assembly-Valid' }
          }
        }
      }),
      'utf8'
    );

    await writeFile(
      path.join(root, 'cdk.out', 'assembly-Valid', 'manifest.json'),
      JSON.stringify({
        version: '36.0.0',
        artifacts: {
          ValidStack: {
            type: 'aws:cloudformation:stack',
            properties: { templateFile: 'ValidStack.template.json' }
          }
        }
      }),
      'utf8'
    );
    await writeFile(
      path.join(root, 'cdk.out', 'assembly-Valid', 'ValidStack.template.json'),
      JSON.stringify({
        Resources: {
          ValidApi: {
            Type: 'AWS::ApiGatewayV2::Api',
            Properties: {
              Name: 'valid',
              ProtocolType: 'HTTP',
              Body: {
                openapi: '3.0.3',
                info: { title: 'Valid', version: '1.0.0' },
                paths: {
                  '/valid-nested': { get: { responses: { '200': { description: 'ok' } } } }
                }
              }
            }
          }
        }
      }),
      'utf8'
    );

    const result = await resolveStaticIacCandidates(root, {
      enabledSources: { cloudformation: false, sam: false, terraform: false, serverless: false, cdk: true }
    });

    const pathEscapeErrors = result.errors.filter((error) => error.code === 'path-escape');
    expect(pathEscapeErrors.length).toBeGreaterThanOrEqual(1);
    expect(pathEscapeErrors.some((error) => /escap|repo-root|cdk-directory/i.test(error.message))).toBe(true);

    // No outside-derived candidates/content and no legacy template-glob fallback acceptance.
    expect(JSON.stringify(result)).not.toContain(outsideMarker);
    expect(JSON.stringify(result)).not.toContain('Escape.template.json');
    expect(
      result.candidates.every((candidate) => {
        const source = candidate.sourcePath ?? '';
        return !source.includes('outside') && !source.includes('Escape.template.json');
      })
    ).toBe(true);

    // Neighboring valid nested assembly still resolves (supported behavior preserved).
    const valid = result.candidates.find((c) => c.logicalId === 'ValidApi' && c.kind === 'openapi-inline');
    expect(valid?.content).toContain('/valid-nested');
    expect(valid?.sourcePath).toContain('assembly-Valid');
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

  it('does not auto-discover .tfstate without explicit terraformStatePaths', async () => {
    const root = await withFixture('terraform-state');
    const result = await resolveStaticIacCandidates(root, {
      enabledSources: { cloudformation: false, sam: false, cdk: false, serverless: false, terraform: true }
    });
    expect(result.physicalApiIds).not.toContain('stateapi01');
    expect(result.candidates.every((c) => !c.sourcePath.endsWith('.tfstate'))).toBe(true);
  });

  it('reads local state artifacts only from explicit terraformStatePaths and redacts sensitive outputs', async () => {
    const root = await withFixture('terraform-state');
    const result = await resolveStaticIacCandidates(root, {
      enabledSources: { cloudformation: false, sam: false, cdk: false, serverless: false, terraform: true },
      terraformStatePaths: ['terraform.tfstate']
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
  it('stops CloudFormation directory enumeration and emits bounds-exceeded', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'iac-cfn-entry-bound-'));
    tempDirs.push(root);
    for (let i = 0; i < 40; i++) {
      await writeFile(path.join(root, `noise-${String(i).padStart(2, '0')}.txt`), 'x');
    }
    await writeFile(
      path.join(root, 'template.yaml'),
      ["AWSTemplateFormatVersion: '2010-09-09'", 'Resources: {}'].join('\n')
    );

    const budget = createIacReadBudget({ maxFiles: 5 });
    const errors: IacResolutionError[] = [];
    const paths = await discoverCloudFormationTemplatePaths(root, budget, errors);

    expect(budget.truncated).toBe(true);
    expect(errors.some((error) => error.code === 'bounds-exceeded')).toBe(true);
    expect(errors.some((error) => /inspected-entry bound/i.test(error.message))).toBe(true);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
  });

  it('stops CDK template-glob enumeration and rejects beyond-bound artifacts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'iac-cdk-entry-bound-'));
    tempDirs.push(root);
    const cdkOut = path.join(root, 'cdk.out');
    await mkdir(cdkOut);
    const maxFiles = 5;
    for (let i = 0; i < 40; i++) {
      await writeFile(path.join(cdkOut, `noise-${String(i).padStart(2, '0')}.txt`), 'x');
    }
    // More matching templates than the inspected-entry bound; only in-bound ones may be accepted.
    for (let i = 0; i < 10; i++) {
      await writeFile(
        path.join(cdkOut, `artifact-${String(i).padStart(2, '0')}.template.json`),
        JSON.stringify({
          Resources: {
            [`Api${i}`]: {
              Type: 'AWS::ApiGateway::RestApi',
              Properties: {
                Body: {
                  openapi: '3.0.3',
                  info: { title: `Artifact${i}`, version: '1.0.0' },
                  paths: { [`/a${i}`]: { get: { responses: { '200': { description: 'ok' } } } } }
                }
              }
            }
          }
        })
      );
    }

    const result = await resolveStaticIacCandidates(root, {
      enabledSources: { cloudformation: false, sam: false, terraform: false, serverless: false, cdk: true },
      maxFiles
    });

    expect(result.errors.some((error) => error.code === 'bounds-exceeded')).toBe(true);
    expect(result.errors.some((error) => /CDK template discovery exceeded inspected-entry bound/i.test(error.message))).toBe(true);
    const acceptedTemplates = result.candidates.filter((candidate) =>
      Boolean(candidate.sourcePath?.includes('.template.json'))
    );
    expect(acceptedTemplates.length).toBeLessThanOrEqual(maxFiles);
    expect(acceptedTemplates.length).toBeLessThan(10);
  });

  it('stops Serverless package enumeration and rejects beyond-bound artifacts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'iac-sls-entry-bound-'));
    tempDirs.push(root);
    const packageDir = path.join(root, '.serverless');
    await mkdir(packageDir);
    const maxFiles = 5;
    for (let i = 0; i < 40; i++) {
      await writeFile(path.join(packageDir, `noise-${String(i).padStart(2, '0')}.txt`), 'x');
    }
    for (let i = 0; i < 10; i++) {
      await writeFile(
        path.join(packageDir, `artifact-${String(i).padStart(2, '0')}-cloudformation-template.json`),
        JSON.stringify({
          Resources: {
            [`Api${i}`]: {
              Type: 'AWS::ApiGateway::RestApi',
              Properties: {
                Body: {
                  openapi: '3.0.3',
                  info: { title: `Artifact${i}`, version: '1.0.0' },
                  paths: { [`/a${i}`]: { get: { responses: { '200': { description: 'ok' } } } } }
                }
              }
            }
          }
        })
      );
    }

    const result = await resolveStaticIacCandidates(root, {
      enabledSources: { cloudformation: false, sam: false, terraform: false, cdk: false, serverless: true },
      maxFiles
    });

    expect(result.errors.some((error) => error.code === 'bounds-exceeded')).toBe(true);
    expect(result.errors.some((error) => /Serverless package discovery exceeded inspected-entry bound/i.test(error.message))).toBe(true);
    const acceptedArtifacts = result.candidates.filter((candidate) =>
      Boolean(candidate.sourcePath?.includes('cloudformation-template'))
    );
    expect(acceptedArtifacts.length).toBeLessThanOrEqual(maxFiles);
    expect(acceptedArtifacts.length).toBeLessThan(10);
  });

  it('stops Terraform source enumeration and rejects beyond-bound artifacts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'iac-tf-entry-bound-'));
    tempDirs.push(root);
    const maxFiles = 5;
    for (let i = 0; i < 40; i++) {
      await writeFile(path.join(root, `noise-${String(i).padStart(2, '0')}.txt`), 'x');
    }
    for (let i = 0; i < 10; i++) {
      await writeFile(
        path.join(root, `artifact-${String(i).padStart(2, '0')}.tf`),
        [
          `resource "aws_api_gateway_rest_api" "api_${i}" {`,
          '  body = <<-EOF',
          'openapi: 3.0.3',
          'info:',
          `  title: Artifact${i}`,
          '  version: "1.0.0"',
          'paths:',
          `  /a${i}:`,
          '    get:',
          '      responses:',
          '        "200":',
          '          description: ok',
          'EOF',
          '}'
        ].join('\n')
      );
    }

    const result = await resolveStaticIacCandidates(root, {
      enabledSources: { cloudformation: false, sam: false, cdk: false, serverless: false, terraform: true },
      maxFiles
    });

    expect(result.errors.some((error) => error.code === 'bounds-exceeded')).toBe(true);
    expect(result.errors.some((error) => /Terraform source discovery exceeded inspected-entry bound/i.test(error.message))).toBe(true);
    const acceptedTf = result.candidates.filter((candidate) =>
      Boolean(candidate.sourcePath?.match(/artifact-\d+\.tf$/))
    );
    expect(acceptedTf.length).toBeLessThanOrEqual(maxFiles);
    expect(acceptedTf.length).toBeLessThan(10);
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

  it('threads production-path S3 client options into inventory and signals static IaC', async () => {
    const root = await withFixture('cfn-s3');
    const openapi = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'S3', version: '1.0.0' },
      paths: { '/s3': { get: { responses: { '200': { description: 'ok' } } } } }
    });
    const s3Client = { getObject: vi.fn().mockResolvedValue(openapi) };
    const inventory = await inventoryRepoSpecs(root, { staticIac: { s3Client } });
    expect(s3Client.getObject).toHaveBeenCalled();
    expect(inventory.candidates.some((c) => c.evidence.some((e) => /Static IaC|openapi-s3-ref|S3/i.test(e)))).toBe(true);

    s3Client.getObject.mockClear();
    const signals = await collectRepoSignals(root, undefined, undefined, [], { staticIac: { s3Client } });
    expect(s3Client.getObject).toHaveBeenCalled();
    expect(signals.evidence.length).toBeGreaterThan(0);
  });
});

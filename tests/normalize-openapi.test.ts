import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { normalizeOpenApiYaml } from '../src/lib/spec/normalize-openapi.js';
import { ApiGatewayProvider } from '../src/lib/providers/api-gateway.js';
import type { AwsGatewayClient } from '../src/lib/aws/client.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function readFixture(name: string): Promise<string> {
  return await readFile(path.join(fixturesDir, name), 'utf8');
}

function collectOperationIds(yamlContent: string): string[] {
  const doc = parse(yamlContent) as { paths?: Record<string, Record<string, { operationId?: string }>> };
  const ids: string[] = [];
  for (const pathItem of Object.values(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(pathItem)) {
      if (!['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'].includes(method)) continue;
      if (op && typeof op === 'object' && typeof op.operationId === 'string') {
        ids.push(op.operationId);
      }
    }
  }
  return ids;
}

describe('normalizeOpenApiYaml', () => {
  it('renames a duplicate operationId by appending a slugified path suffix', () => {
    const input = [
      'openapi: "3.0.1"',
      'info:',
      '  title: t',
      '  version: v',
      'paths:',
      '  /v1/users/{userId}:',
      '    post:',
      '      operationId: update',
      '      responses:',
      '        "200": { description: ok }',
      '  /v1/profile:',
      '    post:',
      '      operationId: update',
      '      responses:',
      '        "200": { description: ok }',
      ''
    ].join('\n');

    const result = normalizeOpenApiYaml(input);

    expect(result.normalized).toBe(true);
    expect(result.renamed).toHaveLength(1);
    expect(result.renamed[0]).toMatchObject({
      path: '/v1/profile',
      method: 'post',
      original: 'update',
      renamed: 'update_v1_profile'
    });

    const ids = collectOperationIds(result.content);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('update');
    expect(ids).toContain('update_v1_profile');
  });

  it('synthesizes operationId when missing using method + path', () => {
    const input = [
      'openapi: "3.0.1"',
      'info: { title: t, version: v }',
      'paths:',
      '  /v1/orders/{orderId}:',
      '    get:',
      '      responses:',
      '        "200": { description: ok }',
      ''
    ].join('\n');

    const result = normalizeOpenApiYaml(input);
    expect(result.renamed).toHaveLength(1);
    expect(result.renamed[0]).toMatchObject({
      method: 'get',
      original: null,
      renamed: 'getV1OrdersOrderId'
    });
  });

  it('is a no-op when all operationIds are already unique', () => {
    const input = [
      'openapi: "3.0.1"',
      'info: { title: t, version: v }',
      'paths:',
      '  /a:',
      '    get: { operationId: alpha, responses: { "200": { description: ok } } }',
      '  /b:',
      '    get: { operationId: beta, responses: { "200": { description: ok } } }',
      ''
    ].join('\n');

    const result = normalizeOpenApiYaml(input);
    expect(result.renamed).toEqual([]);
    expect(result.content).toBe(input);
    expect(result.normalized).toBe(true);
  });

  it('returns content unchanged when the document is not an OpenAPI map', () => {
    const input = '- just\n- a\n- list\n';
    const result = normalizeOpenApiYaml(input);
    expect(result.normalized).toBe(false);
    expect(result.content).toBe(input);
  });

  it('returns content unchanged when YAML is malformed (never throws)', () => {
    const input = ':\n  -invalid\nthis-is-not: [unbalanced';
    const result = normalizeOpenApiYaml(input);
    expect(result.normalized).toBe(false);
    expect(result.content).toBe(input);
  });

  it('handles further collisions by appending a numeric tiebreaker', () => {
    // Three operations all share base id `update`. The first stays put;
    // the second would normally become `update_v1_x`, but that id is
    // already claimed (post on /v1/x); so it falls back to numeric tiebreak.
    const input = [
      'openapi: "3.0.1"',
      'info: { title: t, version: v }',
      'paths:',
      '  /v1/x:',
      '    post:',
      '      operationId: update',
      '      responses: { "200": { description: ok } }',
      '    put:',
      '      operationId: update_v1_x',
      '      responses: { "200": { description: ok } }',
      '    patch:',
      '      operationId: update',
      '      responses: { "200": { description: ok } }',
      ''
    ].join('\n');

    const result = normalizeOpenApiYaml(input);
    const ids = collectOperationIds(result.content);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('update');
    expect(ids).toContain('update_v1_x');
    expect(ids.some((id) => /^update_v1_x_\d+$/.test(id))).toBe(true);
  });

  it('preserves the canonical Fox AWS export and dedupes the duplicate `update`', async () => {
    const fixture = await readFixture('aws-export-duplicate-operation-ids.yaml');
    const result = normalizeOpenApiYaml(fixture);

    expect(result.normalized).toBe(true);
    expect(result.renamed.length).toBeGreaterThan(0);

    const ids = collectOperationIds(result.content);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('update');
    // After normalization there is exactly one `update` and one renamed copy.
    expect(ids.filter((id) => id === 'update')).toHaveLength(1);
    // The renamed entry should preserve `update` as the base.
    const renamedCopies = ids.filter((id) => id !== 'update' && id.startsWith('update'));
    expect(renamedCopies.length).toBeGreaterThan(0);
  });
});

describe('ApiGatewayProvider.exportSpec normalization', () => {
  function makeClient(spec: string): AwsGatewayClient {
    return {
      probeApiGatewayReadAccess: vi.fn().mockResolvedValue(undefined),
      listRestApis: vi.fn().mockResolvedValue([]),
      listHttpApis: vi.fn().mockResolvedValue([]),
      exportRestApi: vi.fn().mockResolvedValue(spec),
      exportHttpApi: vi.fn().mockResolvedValue(spec)
    } as unknown as AwsGatewayClient;
  }

  it('rewrites duplicate operationIds in REST exports and reports renames', async () => {
    const spec = [
      'openapi: "3.0.1"',
      'info: { title: t, version: v }',
      'paths:',
      '  /a:',
      '    post:',
      '      operationId: update',
      '      responses: { "200": { description: ok } }',
      '  /b:',
      '    post:',
      '      operationId: update',
      '      responses: { "200": { description: ok } }',
      ''
    ].join('\n');

    const renames: unknown[] = [];
    const provider = new ApiGatewayProvider(makeClient(spec), {
      includeV2: false,
      onOperationIdRenamed: (rename) => renames.push(rename)
    });
    const result = await provider.exportSpec(
      { id: 'gw-1', name: 'svc', providerType: 'api-gateway', tags: {}, evidence: [], meta: { gatewayType: 'REST' } },
      { stage: 'prod' }
    );

    const ids = collectOperationIds(result.content);
    expect(new Set(ids).size).toBe(ids.length);
    expect(renames).toHaveLength(1);
    expect(result.evidence.some((line) => line.includes('Normalized 1 operationId'))).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { mergeRestApiDocumentation } from '../src/lib/spec/rest-api-documentation-merge.js';

// Shape of a real oas30 GetExport body: operationId survives, summary/description/tags do not.
const NATIVE_EXPORT = [
  'openapi: "3.0.1"',
  'info:',
  '  title: "fe-onsite-t00"',
  '  version: "1.0.0"',
  'paths:',
  '  /v1/decisions:',
  '    post:',
  '      operationId: "createDecision"',
  '      responses:',
  '        "201":',
  '          description: "201 response"',
  '  /v1/health:',
  '    get:',
  '      operationId: "getHealth"',
  '      responses:',
  '        "200":',
  '          description: "200 response"',
  ''
].join('\n');

const API_PART = {
  type: 'API',
  properties: JSON.stringify({
    info: { description: 'Reference decision service.' },
    tags: [{ name: 'Decisions', description: 'Reference policy decision operations.' }]
  })
};

const CREATE_PART = {
  type: 'METHOD',
  path: '/v1/decisions',
  method: 'POST',
  properties: JSON.stringify({ tags: ['Decisions'], summary: 'Create a decision', description: 'Evaluate a policy.' })
};

const HEALTH_PART = {
  type: 'METHOD',
  path: '/v1/health',
  method: 'GET',
  properties: JSON.stringify({ tags: ['Health'], summary: 'Check service health' })
};

function operations(yaml: string): Record<string, Record<string, Record<string, unknown>>> {
  return parse(yaml).paths;
}

describe('mergeRestApiDocumentation', () => {
  it('restores operation summaries that GetExport drops', () => {
    const merged = operations(
      mergeRestApiDocumentation({ nativeExport: NATIVE_EXPORT, parts: [API_PART, CREATE_PART, HEALTH_PART] })
    );
    expect(merged['/v1/decisions'].post.summary).toBe('Create a decision');
    expect(merged['/v1/decisions'].post.description).toBe('Evaluate a policy.');
    expect(merged['/v1/decisions'].post.tags).toEqual(['Decisions']);
    expect(merged['/v1/health'].get.summary).toBe('Check service health');
  });

  it('leaves every native value untouched', () => {
    const merged = parse(
      mergeRestApiDocumentation({ nativeExport: NATIVE_EXPORT, parts: [API_PART, CREATE_PART, HEALTH_PART] })
    );
    expect(merged.paths['/v1/decisions'].post.operationId).toBe('createDecision');
    expect(merged.paths['/v1/decisions'].post.responses['201'].description).toBe('201 response');
    expect(merged.info.title).toBe('fe-onsite-t00');
    expect(merged.info.version).toBe('1.0.0');
  });

  it('never overwrites a summary the native export already carries', () => {
    const withSummary = NATIVE_EXPORT.replace('      operationId: "createDecision"', '      operationId: "createDecision"\n      summary: "Native summary"');
    const merged = operations(mergeRestApiDocumentation({ nativeExport: withSummary, parts: [CREATE_PART] }));
    expect(merged['/v1/decisions'].post.summary).toBe('Native summary');
  });

  it('applies a wildcard method part to every operation on the path', () => {
    const wildcard = { type: 'METHOD', path: '/v1/decisions', method: '*', properties: JSON.stringify({ summary: 'Any decision operation' }) };
    const merged = operations(mergeRestApiDocumentation({ nativeExport: NATIVE_EXPORT, parts: [wildcard] }));
    expect(merged['/v1/decisions'].post.summary).toBe('Any decision operation');
  });

  it('adds info.description and the root tag catalogue from the API part', () => {
    const merged = parse(mergeRestApiDocumentation({ nativeExport: NATIVE_EXPORT, parts: [API_PART] }));
    expect(merged.info.description).toBe('Reference decision service.');
    expect(merged.tags).toEqual([{ name: 'Decisions', description: 'Reference policy decision operations.' }]);
  });

  it('returns the native export unchanged when there are no parts', () => {
    expect(mergeRestApiDocumentation({ nativeExport: NATIVE_EXPORT, parts: [] })).toBe(NATIVE_EXPORT);
  });

  it('returns the native export unchanged on unparseable input', () => {
    expect(mergeRestApiDocumentation({ nativeExport: 'not: a: spec', parts: [CREATE_PART] })).toBe('not: a: spec');
  });

  it('ignores parts with malformed properties JSON', () => {
    const bad = { type: 'METHOD', path: '/v1/decisions', method: 'POST', properties: '{not json' };
    const merged = operations(mergeRestApiDocumentation({ nativeExport: NATIVE_EXPORT, parts: [bad] }));
    expect(merged['/v1/decisions'].post.summary).toBeUndefined();
    expect(merged['/v1/decisions'].post.operationId).toBe('createDecision');
  });

  it('ignores parts pointing at a path the export does not contain', () => {
    const orphan = { type: 'METHOD', path: '/v1/gone', method: 'GET', properties: JSON.stringify({ summary: 'Ghost' }) };
    const merged = mergeRestApiDocumentation({ nativeExport: NATIVE_EXPORT, parts: [orphan] });
    expect(merged).not.toContain('Ghost');
  });
});

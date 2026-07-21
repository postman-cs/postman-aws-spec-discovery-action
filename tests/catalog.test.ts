import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { detectCatalogApis } from '../src/lib/repo/catalog.js';

describe('detectCatalogApis', () => {
  it('returns undefined when no catalog-info.yaml exists', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'catalog-test-'));
    try {
      const result = await detectCatalogApis(tempDir);
      expect(result).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('extracts API spec path from catalog-info.yaml', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'catalog-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'catalog-info.yaml'),
        `apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: payments-api
spec:
  type: openapi
  definition: ./openapi.yaml
`,
        'utf8'
      );
      const result = await detectCatalogApis(tempDir);
      expect(result).toHaveLength(1);
      expect(result?.[0]?.name).toBe('payments-api');
      expect(result?.[0]?.type).toBe('openapi');
      expect(result?.[0]?.specPath).toBe('./openapi.yaml');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('extracts API spec URL from catalog-info.yaml', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'catalog-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'catalog-info.yaml'),
        `apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: auth-service
spec:
  type: openapi
  definition: https://api.example.com/openapi.json
`,
        'utf8'
      );
      const result = await detectCatalogApis(tempDir);
      expect(result).toHaveLength(1);
      expect(result?.[0]?.type).toBe('openapi');
      expect(result?.[0]?.specUrl).toBe('https://api.example.com/openapi.json');
      expect(result?.[0]?.specPath).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('extracts $text reference from definition', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'catalog-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'catalog-info.yaml'),
        `apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: graphql-api
spec:
  type: graphql
  definition:
    $text: ./schema.graphql
`,
        'utf8'
      );
      const result = await detectCatalogApis(tempDir);
      expect(result).toHaveLength(1);
      expect(result?.[0]?.type).toBe('graphql');
      expect(result?.[0]?.specPath).toBe('./schema.graphql');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('extracts $json reference from definition', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'catalog-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'catalog-info.yaml'),
        `apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: async-api
spec:
  type: asyncapi
  definition:
    $json: ./asyncapi.json
`,
        'utf8'
      );
      const result = await detectCatalogApis(tempDir);
      expect(result).toHaveLength(1);
      expect(result?.[0]?.type).toBe('asyncapi');
      expect(result?.[0]?.specPath).toBe('./asyncapi.json');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('skips non-API entities', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'catalog-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'catalog-info.yaml'),
        `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: my-component
spec:
  type: service
`,
        'utf8'
      );
      const result = await detectCatalogApis(tempDir);
      expect(result).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('parses multi-document catalog-info.yaml and returns API entities across documents', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'catalog-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'catalog-info.yaml'),
        `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: infra
---
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: orders-api
spec:
  definition: https://example.com/orders.asyncapi.yaml
---
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: billing-api
spec:
  definition:
    $text: ./billing/openapi.yaml
`,
        'utf8'
      );

      const result = await detectCatalogApis(tempDir);
      expect(result).toMatchObject([
        {
          name: 'orders-api',
          specUrl: 'https://example.com/orders.asyncapi.yaml',
          catalogPath: 'catalog-info.yaml'
        },
        {
          name: 'billing-api',
          specPath: './billing/openapi.yaml',
          catalogPath: 'catalog-info.yaml'
        }
      ]);
      expect(result?.[0]?.specPath).toBeUndefined();
      expect(result?.[0]?.inlineContent).toBeUndefined();
      expect(result?.[1]?.specUrl).toBeUndefined();
      expect(result?.[1]?.inlineContent).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('extracts $yaml local reference from definition', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'catalog-yaml-ref-'));
    try {
      await writeFile(
        path.join(tempDir, 'catalog-info.yaml'),
        [
          'apiVersion: backstage.io/v1alpha1',
          'kind: API',
          'metadata:',
          '  name: orders-api',
          'spec:',
          '  type: openapi',
          '  definition:',
          '    $yaml: ./openapi.yaml'
        ].join('\n'),
        'utf8'
      );
      const result = await detectCatalogApis(tempDir);
      expect(result).toHaveLength(1);
      expect(result?.[0]).toMatchObject({
        name: 'orders-api',
        type: 'openapi',
        specPath: './openapi.yaml'
      });
      expect(result?.[0]?.inlineContent).toBeUndefined();
      expect(result?.[0]?.specUrl).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('models inline OpenAPI, WSDL, MCP, and introspection separately from path/URL refs', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'catalog-inline-'));
    try {
      const openapiInline = [
        'openapi: 3.0.3',
        'info:',
        '  title: Inline Orders',
        '  version: "1.0.0"',
        'paths: {}'
      ].join('\n');
      const wsdlInline =
        '<?xml version="1.0"?><definitions xmlns="http://schemas.xmlsoap.org/wsdl/" name="Demo"></definitions>';
      const mcpInline = JSON.stringify({ mcpServers: { demo: { command: 'run' } } });
      const introInline = JSON.stringify({
        __schema: { queryType: { name: 'Query' }, types: [] }
      });
      await writeFile(
        path.join(tempDir, 'catalog-info.yaml'),
        [
          'apiVersion: backstage.io/v1alpha1',
          'kind: API',
          'metadata:',
          '  name: openapi-inline',
          'spec:',
          '  type: openapi',
          '  definition: |',
          ...openapiInline.split('\n').map((line) => `    ${line}`),
          '---',
          'apiVersion: backstage.io/v1alpha1',
          'kind: API',
          'metadata:',
          '  name: wsdl-inline',
          'spec:',
          '  type: wsdl',
          `  definition: ${JSON.stringify(wsdlInline)}`,
          '---',
          'apiVersion: backstage.io/v1alpha1',
          'kind: API',
          'metadata:',
          '  name: mcp-inline',
          'spec:',
          '  type: mcp',
          '  definition:',
          '    mcpServers:',
          '      demo:',
          '        command: run',
          '---',
          'apiVersion: backstage.io/v1alpha1',
          'kind: API',
          'metadata:',
          '  name: intro-inline',
          'spec:',
          '  type: graphql',
          '  definition:',
          '    __schema:',
          '      queryType:',
          '        name: Query',
          '      types: []'
        ].join('\n'),
        'utf8'
      );

      const result = await detectCatalogApis(tempDir);
      expect(result?.map((api) => api.name).sort()).toEqual([
        'intro-inline',
        'mcp-inline',
        'openapi-inline',
        'wsdl-inline'
      ]);
      for (const api of result ?? []) {
        expect(api.specPath).toBeUndefined();
        expect(api.specUrl).toBeUndefined();
        expect(api.inlineContent).toBeTruthy();
      }
      expect(result?.find((api) => api.name === 'openapi-inline')?.inlineContent).toContain('openapi:');
      expect(result?.find((api) => api.name === 'wsdl-inline')?.inlineContent).toContain('schemas.xmlsoap.org/wsdl');
      expect(result?.find((api) => api.name === 'mcp-inline')?.inlineContent).toContain('mcpServers');
      expect(result?.find((api) => api.name === 'intro-inline')?.inlineContent).toContain('__schema');
      expect(mcpInline).toContain('mcpServers');
      expect(introInline).toContain('__schema');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('scopes catalog APIs by service-root and service name', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'catalog-scope-'));
    try {
      await mkdir(path.join(tempDir, 'services', 'orders'), { recursive: true });
      await mkdir(path.join(tempDir, 'services', 'billing'), { recursive: true });
      await writeFile(
        path.join(tempDir, 'services', 'orders', 'catalog-info.yaml'),
        [
          'apiVersion: backstage.io/v1alpha1',
          'kind: API',
          'metadata:',
          '  name: orders-api',
          'spec:',
          '  type: openapi',
          '  definition: ./openapi.yaml'
        ].join('\n'),
        'utf8'
      );
      await writeFile(
        path.join(tempDir, 'services', 'billing', 'catalog-info.yaml'),
        [
          'apiVersion: backstage.io/v1alpha1',
          'kind: API',
          'metadata:',
          '  name: billing-api',
          'spec:',
          '  type: openapi',
          '  definition: ./openapi.yaml'
        ].join('\n'),
        'utf8'
      );

      const scopedRoot = await detectCatalogApis(tempDir, { serviceRoot: 'services/orders' });
      expect(scopedRoot?.map((api) => api.name)).toEqual(['orders-api']);

      const scopedName = await detectCatalogApis(tempDir, { serviceName: 'billing-api' });
      expect(scopedName?.map((api) => api.name)).toEqual(['billing-api']);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

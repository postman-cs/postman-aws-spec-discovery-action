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
      expect(result).toEqual([
        {
          name: 'orders-api',
          type: undefined,
          specUrl: 'https://example.com/orders.asyncapi.yaml',
          specPath: undefined,
          catalogPath: 'catalog-info.yaml'
        },
        {
          name: 'billing-api',
          type: undefined,
          specPath: './billing/openapi.yaml',
          specUrl: undefined,
          catalogPath: 'catalog-info.yaml'
        }
      ]);
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

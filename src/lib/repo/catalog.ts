import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAllDocuments, stringify } from 'yaml';
import { findIaCFiles } from './scan.js';
import { resolveLocalReadWithinRoot } from '../utils/resolve-path-within-root.js';

export interface CatalogApiRef {
  name: string;
  type?: string;
  specPath?: string;
  specUrl?: string;
  /** Inline definition bytes acquired from the catalog entity (not a path/URL ref). */
  inlineContent?: string;
  /** Catalog file that declared this API (posix, relative to repo root). */
  catalogPath?: string;
}

export interface DetectCatalogApisOptions {
  /** Optional monorepo service root (posix, relative to repo root). */
  serviceRoot?: string;
  /** Optional API / service name filter (case-insensitive exact match). */
  serviceName?: string;
}

interface CatalogEntity {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; [k: string]: unknown };
  spec?: {
    type?: string;
    definition?: string | Record<string, unknown>;
    [k: string]: unknown;
  };
}

export async function detectCatalogApis(
  repoRoot: string,
  options: DetectCatalogApisOptions = {}
): Promise<CatalogApiRef[] | undefined> {
  const candidates = await catalogCandidates(repoRoot);
  const apis: CatalogApiRef[] = [];

  for (const catalogPath of candidates) {
    let content: string | undefined;
    try {
      const resolved = await resolveLocalReadWithinRoot(repoRoot, catalogPath, {
        fieldName: 'catalog-info',
        countAsReference: false
      });
      content = await readFile(resolved.canonicalPath, 'utf8');
    } catch {
      continue;
    }
    let docs: CatalogEntity[];
    try {
      docs = parseAllDocuments(content)
        .map((document) => document.toJSON() as CatalogEntity | null)
        .filter((document): document is CatalogEntity => Boolean(document && typeof document === 'object'));
    } catch {
      continue;
    }
    apis.push(...extractCatalogApis(catalogPath, docs));
  }

  const scoped = scopeCatalogApis(apis, options);
  return scoped.length > 0 ? scoped : undefined;
}

function scopeCatalogApis(apis: CatalogApiRef[], options: DetectCatalogApisOptions): CatalogApiRef[] {
  const serviceRoot = options.serviceRoot?.replace(/\\/g, '/').replace(/\/+$/, '');
  const serviceName = options.serviceName?.trim().toLowerCase();
  return apis.filter((api) => {
    if (serviceName && api.name.trim().toLowerCase() !== serviceName) {
      return false;
    }
    if (!serviceRoot || serviceRoot === '.' || serviceRoot === '') {
      return true;
    }
    if (api.catalogPath) {
      const catalogDir = path.posix.dirname(api.catalogPath.replace(/\\/g, '/'));
      if (catalogDir === serviceRoot || catalogDir.startsWith(`${serviceRoot}/`)) {
        return true;
      }
    }
    if (api.specPath) {
      const normalized = api.specPath.replace(/\\/g, '/').replace(/^\.\//, '');
      if (normalized === serviceRoot || normalized.startsWith(`${serviceRoot}/`)) {
        return true;
      }
    }
    // Remote/inline-only entities under an explicit service root match by catalog location.
    if ((!api.specPath && api.specUrl) || api.inlineContent) {
      return Boolean(api.catalogPath && isUnderServiceRoot(api.catalogPath, serviceRoot));
    }
    return false;
  });
}

function isUnderServiceRoot(relativePath: string, serviceRoot: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  const dir = path.posix.dirname(normalized);
  return dir === serviceRoot || dir.startsWith(`${serviceRoot}/`) || normalized.startsWith(`${serviceRoot}/`);
}

async function catalogCandidates(repoRoot: string): Promise<string[]> {
  const discovered = await findIaCFiles(repoRoot, ['.yaml', '.yml']);
  return [...new Set([
    'catalog-info.yaml',
    'catalog-info.yml',
    ...discovered
      .map((filePath) => path.relative(repoRoot, filePath).replace(/\\/g, '/'))
      .filter((filePath) => /(^|\/)catalog-info\.ya?ml$/.test(filePath))
  ])];
}

function extractCatalogApis(catalogPath: string, docs: CatalogEntity[]): CatalogApiRef[] {
  const apis: CatalogApiRef[] = [];
  for (const doc of docs) {
    if (!doc || doc.kind !== 'API') continue;

    const name = doc.metadata?.name ?? '';
    if (!name) continue;
    const type = typeof doc.spec?.type === 'string' ? doc.spec.type : undefined;

    const acquired = acquireDefinition(catalogPath, doc.spec?.definition);
    if (!acquired) continue;

    apis.push({
      name,
      type,
      ...acquired,
      catalogPath: catalogPath.replace(/\\/g, '/')
    });
  }

  return apis;
}

type AcquiredDefinition =
  | { specPath: string; specUrl?: undefined; inlineContent?: undefined }
  | { specUrl: string; specPath?: undefined; inlineContent?: undefined }
  | { inlineContent: string; specPath?: undefined; specUrl?: undefined };

function acquireDefinition(
  catalogPath: string,
  def: string | Record<string, unknown> | undefined
): AcquiredDefinition | undefined {
  if (typeof def === 'string') {
    return classifyDefinitionString(catalogPath, def);
  }
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    return undefined;
  }

  const refKeys = ['$text', '$json', '$yaml'] as const;
  for (const key of refKeys) {
    const value = def[key];
    if (typeof value === 'string' && value.trim()) {
      return classifyDefinitionString(catalogPath, value);
    }
  }

  // Inline document embedded directly as a YAML/JSON object (no $text/$json/$yaml wrapper).
  if (looksLikeInlineDocumentObject(def)) {
    try {
      return { inlineContent: stringify(def) };
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function classifyDefinitionString(catalogPath: string, value: string): AcquiredDefinition {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return { specUrl: trimmed };
  }
  if (isInlineDefinitionBytes(trimmed)) {
    return { inlineContent: value };
  }
  return { specPath: resolveCatalogPath(catalogPath, trimmed) };
}

/**
 * Distinguish inline document bytes from local path references.
 * Paths stay path-like (no newlines, no document markers); everything else is inline.
 */
function isInlineDefinitionBytes(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.includes('\n') || trimmed.includes('\r')) return true;
  if (trimmed.startsWith('{') || trimmed.startsWith('<')) return true;
  if (/^\s*(openapi|swagger|asyncapi)\s*:/i.test(trimmed)) return true;
  if (/^\s*\$version\s*:/i.test(trimmed)) return true;
  // Path-like: optional ./ ../, segments, extension
  if (/^(\.\/|\.\.\/)?[\w.@+-]+(?:\/[\w.@+-]+)*\.[A-Za-z0-9]+$/.test(trimmed)) return false;
  if (trimmed.startsWith('./') || trimmed.startsWith('../')) return false;
  // Ambiguous short strings without extension still treated as paths for Backstage relative refs.
  if (trimmed.length < 80 && !/\s{2,}/.test(trimmed)) return false;
  return true;
}

function looksLikeInlineDocumentObject(def: Record<string, unknown>): boolean {
  return Boolean(
    def.openapi
    || def.swagger
    || def.asyncapi
    || def.__schema
    || def.mcpServers
    || (def.data && typeof def.data === 'object')
  );
}

function resolveCatalogPath(catalogPath: string, reference: string): string {
  const normalized = reference.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalized)) {
    return normalized.replace(/^\/+/, '');
  }
  const catalogDir = path.posix.dirname(catalogPath);
  if (catalogDir === '.') {
    return normalized;
  }
  return path.posix.normalize(path.posix.join(catalogDir, normalized));
}

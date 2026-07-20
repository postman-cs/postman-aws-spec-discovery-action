import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import { findIaCFiles } from './scan.js';
import { resolveLocalReadWithinRoot } from '../utils/resolve-path-within-root.js';

export interface CatalogApiRef {
  name: string;
  type?: string;
  specPath?: string;
  specUrl?: string;
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
    definition?: string | { $text?: string; $json?: string };
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
    // Remote-only entities under an explicit service root match by name filter above, or by catalog location.
    if (!api.specPath && api.specUrl) {
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

    const def = doc.spec?.definition;
    let specPath: string | undefined;
    let specUrl: string | undefined;

    if (typeof def === 'string') {
      if (def.startsWith('http://') || def.startsWith('https://')) {
        specUrl = def;
      } else {
        specPath = resolveCatalogPath(catalogPath, def);
      }
    } else if (def && typeof def === 'object') {
      const ref = typeof def.$text === 'string' ? def.$text : typeof def.$json === 'string' ? def.$json : undefined;
      if (typeof ref === 'string') {
        if (ref.startsWith('http://') || ref.startsWith('https://')) {
          specUrl = ref;
        } else {
          specPath = resolveCatalogPath(catalogPath, ref);
        }
      }
    }

    apis.push({ name, type, specPath, specUrl, catalogPath: catalogPath.replace(/\\/g, '/') });
  }

  return apis;
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

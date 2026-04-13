import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';

export interface CatalogApiRef {
  name: string;
  specPath?: string;
  specUrl?: string;
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

/**
 * Detect Backstage catalog-info.yaml in the repo root and extract API spec references.
 * Returns undefined if no catalog file found or no API entities are present.
 */
export async function detectCatalogApis(repoRoot: string): Promise<CatalogApiRef[] | undefined> {
  const candidates = ['catalog-info.yaml', 'catalog-info.yml'];
  let content: string | undefined;

  for (const filename of candidates) {
    try {
      content = await readFile(path.resolve(repoRoot, filename), 'utf8');
      break;
    } catch {
      // Continue
    }
  }

  if (!content) return undefined;

  let docs: CatalogEntity[];
  try {
    docs = parseAllDocuments(content)
      .map((document) => document.toJSON() as CatalogEntity | null)
      .filter((document): document is CatalogEntity => Boolean(document && typeof document === 'object'));
  } catch {
    return undefined;
  }

  const apis: CatalogApiRef[] = [];
  for (const doc of docs) {
    if (!doc || doc.kind !== 'API') continue;

    const name = doc.metadata?.name ?? '';
    if (!name) continue;

    const def = doc.spec?.definition;
    let specPath: string | undefined;
    let specUrl: string | undefined;

    if (typeof def === 'string') {
      if (def.startsWith('http://') || def.startsWith('https://')) {
        specUrl = def;
      } else {
        specPath = def;
      }
    } else if (def && typeof def === 'object') {
      const textRef = def.$text;
      if (typeof textRef === 'string') {
        if (textRef.startsWith('http://') || textRef.startsWith('https://')) {
          specUrl = textRef;
        } else {
          specPath = textRef;
        }
      }
    }

    apis.push({ name, specPath, specUrl });
  }

  return apis.length > 0 ? apis : undefined;
}

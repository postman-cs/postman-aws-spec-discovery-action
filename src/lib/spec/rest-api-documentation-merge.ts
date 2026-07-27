import { parse, stringify } from 'yaml';

/** One API Gateway documentation part, as returned by GetDocumentationParts. */
export interface RestApiDocumentationPart {
  /** Documentation part location type, e.g. API, METHOD, RESPONSE, PATH_PARAMETER. */
  type?: string;
  /** Resource path the part documents, e.g. /v1/decisions. */
  path?: string;
  /** HTTP method the part documents, e.g. GET. Literal '*' means all methods. */
  method?: string;
  /** Response status code for RESPONSE parts. */
  statusCode?: string;
  /** Request/response field name for parameter parts. */
  name?: string;
  /** Raw JSON properties blob carrying summary/description/tags. */
  properties?: string;
}

export interface MergeRestApiDocumentationInput {
  nativeExport: string;
  parts: RestApiDocumentationPart[];
}

/** Operation-level documentation keys that are safe to restore additively. */
const METHOD_DOC_KEYS = ['summary', 'description', 'tags', 'externalDocs'] as const;

function parseNativeExport(nativeExport: string): Record<string, unknown> | undefined {
  try {
    const parsed = nativeExport.trim().startsWith('{') ? JSON.parse(nativeExport) : parse(nativeExport);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as Record<string, unknown>).paths) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to undefined
  }
  return undefined;
}

function parseProperties(properties: string | undefined): Record<string, unknown> | undefined {
  if (!properties) return undefined;
  try {
    const parsed = JSON.parse(properties);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to undefined
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Copy only keys the target does not already own. Native values always win. */
function addAbsentKeys(target: Record<string, unknown>, source: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (Object.prototype.hasOwnProperty.call(target, key)) continue;
    target[key] = value;
  }
}

/**
 * Additively restore API Gateway documentation parts into a native REST GetExport
 * document. GetExport drops operation summary/description/tags even with
 * extensions=documentation, so operations that were imported with documentation
 * come back anonymous and downstream consumers fall back to operationId.
 *
 * Only absent values are added; every native value is preserved as parsed. On any
 * shape surprise the native export is returned unchanged.
 */
export function mergeRestApiDocumentation(input: MergeRestApiDocumentationInput): string {
  const document = parseNativeExport(input.nativeExport);
  if (!document) {
    return input.nativeExport;
  }
  if (input.parts.length === 0) {
    return input.nativeExport;
  }

  const paths = asRecord(document.paths);

  for (const part of input.parts) {
    const properties = parseProperties(part.properties);
    if (!properties) continue;
    const type = (part.type ?? '').toUpperCase();

    // API-level part carries info.description and the root tag catalogue.
    if (type === 'API') {
      const infoSource = asRecord(properties.info);
      if (infoSource) {
        const info = asRecord(document.info) ?? {};
        addAbsentKeys(info, infoSource, ['description', 'summary', 'termsOfService', 'contact', 'license']);
        if (Object.keys(info).length > 0) document.info = info;
      }
      if (Array.isArray(properties.tags) && document.tags === undefined) {
        document.tags = properties.tags;
      }
      continue;
    }

    if (type !== 'METHOD' || !paths) continue;
    if (!part.path || !part.method) continue;

    const pathItem = asRecord(paths[part.path]);
    if (!pathItem) continue;

    // '*' documents every method on the path; a concrete verb documents just one.
    const methodNames =
      part.method === '*'
        ? Object.keys(pathItem).filter((key) => key !== 'parameters' && !key.startsWith('x-'))
        : [part.method.toLowerCase()];

    for (const methodName of methodNames) {
      const operation = asRecord(pathItem[methodName]);
      if (!operation) continue;
      addAbsentKeys(operation, properties, METHOD_DOC_KEYS);
    }
  }

  return stringify(document);
}

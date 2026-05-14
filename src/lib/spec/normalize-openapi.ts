// Normalize OpenAPI specs exported by AWS to satisfy validator requirements
// that the AWS export pipeline does not enforce.
//
// Today this handles one rule:
//
//   "Every operation must have a unique operationId" -- OpenAPI 3.x spec
//
// AWS API Gateway populates `operationId` from the integration request's
// `OperationName`, which is often the bare HTTP method (`get`, `update`,
// `post`) or omitted entirely. Multiple operations across paths therefore
// collide, and downstream validators (including the Postman bootstrap
// action's OpenAPI loader) reject the document with:
//
//   CONTRACT_SPEC_VALIDATION_FAILED: The operationId `update` is
//   duplicated and must be made unique.
//
// We rewrite the duplicate (and synthesize ones that were missing) so the
// committed spec is a valid OpenAPI document with no behaviour change for
// runtime callers.
//
// Algorithm:
//   1. Walk paths in insertion order, then methods in OpenAPI canonical
//      order. The FIRST occurrence of an operationId wins -- we never
//      rename it. This keeps existing references stable.
//   2. Subsequent collisions are renamed to `<originalId>_<slugifiedPath>`.
//      If that suffix itself collides we append `_2`, `_3`, ... until unique.
//   3. Missing operationIds are synthesized as `<method><PascalPath>` so
//      generated collections still get human-readable request names.
//
// We use `yaml`'s document-level API so quoting, ordering, and the bits of
// formatting AWS emits are preserved -- the only diff is the operationId
// values themselves.

import { isMap, isScalar, parseDocument, type Document, type Scalar, type YAMLMap } from 'yaml';

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

export interface OperationIdRename {
  path: string;
  method: string;
  original: string | null;
  renamed: string;
}

export interface NormalizeOpenApiResult {
  content: string;
  renamed: OperationIdRename[];
  /** True if the document was recognized as an OpenAPI spec and walked. */
  normalized: boolean;
}

/**
 * Normalize an OpenAPI document by deduplicating and synthesizing
 * `operationId` values. Returns the (possibly-rewritten) YAML content
 * along with a list of rewrites for logging.
 *
 * If the input is not a recognizable OpenAPI YAML document the original
 * content is returned unchanged with `normalized: false`. Failures parsing
 * the document are treated the same way -- we never throw, because this
 * runs in the export hot path and a broken spec is the bootstrap action's
 * problem to surface, not ours.
 */
export function normalizeOpenApiYaml(content: string): NormalizeOpenApiResult {
  const passthrough: NormalizeOpenApiResult = { content, renamed: [], normalized: false };

  let doc: Document;
  try {
    doc = parseDocument(content, { prettyErrors: false });
  } catch {
    return passthrough;
  }
  if (doc.errors.length > 0) return passthrough;
  if (!isMap(doc.contents)) return passthrough;

  const paths = doc.get('paths', true);
  if (!isMap(paths)) return passthrough;

  const seen = new Set<string>();
  const renamed: OperationIdRename[] = [];

  for (const pathPair of paths.items) {
    const pathKey = scalarString(pathPair.key);
    if (pathKey === undefined) continue;
    const pathItem = pathPair.value;
    if (!isMap(pathItem)) continue;

    for (const methodPair of pathItem.items) {
      const method = scalarString(methodPair.key);
      if (method === undefined) continue;
      const methodLower = method.toLowerCase();
      if (!HTTP_METHODS.has(methodLower)) continue;
      const operation = methodPair.value;
      if (!isMap(operation)) continue;

      const opIdNode = operation.get('operationId', true);
      const originalId = isScalar(opIdNode) && typeof opIdNode.value === 'string' ? opIdNode.value : null;
      const base = originalId && originalId.trim().length > 0
        ? originalId
        : synthesizeOperationId(methodLower, pathKey);

      let finalId = base;
      if (seen.has(base)) {
        const suffix = slugifyPath(pathKey);
        let candidate = suffix.length > 0 ? `${base}_${suffix}` : `${base}_${methodLower}`;
        let counter = 2;
        while (seen.has(candidate)) {
          candidate = suffix.length > 0
            ? `${base}_${suffix}_${counter}`
            : `${base}_${methodLower}_${counter}`;
          counter += 1;
        }
        finalId = candidate;
      }

      seen.add(finalId);
      if (finalId !== originalId) {
        renamed.push({ path: pathKey, method: methodLower, original: originalId, renamed: finalId });
        setOperationId(operation, finalId);
      }
    }
  }

  if (renamed.length === 0) {
    return { content, renamed: [], normalized: true };
  }

  return { content: String(doc), renamed, normalized: true };
}

function scalarString(node: unknown): string | undefined {
  if (isScalar(node) && typeof node.value === 'string') return node.value;
  if (typeof node === 'string') return node;
  return undefined;
}

function setOperationId(operation: YAMLMap, value: string): void {
  const existing = operation.get('operationId', true);
  if (isScalar(existing)) {
    (existing as Scalar).value = value;
    return;
  }
  operation.set('operationId', value);
}

function synthesizeOperationId(method: string, pathKey: string): string {
  const pascal = pathKey
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(stripTemplate)
    .map(toPascalCase)
    .join('');
  return pascal.length > 0 ? `${method}${pascal}` : method;
}

function stripTemplate(segment: string): string {
  // `{orderId}` -> `OrderId`. Keep the identifier, drop the braces so
  // synthesized ids stay readable.
  if (segment.startsWith('{') && segment.endsWith('}')) {
    return segment.slice(1, -1);
  }
  return segment;
}

function toPascalCase(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9]+/g, ' ').trim();
  if (cleaned.length === 0) return '';
  return cleaned
    .split(/\s+/)
    .map((word) => (word.length === 0 ? '' : word[0].toUpperCase() + word.slice(1)))
    .join('');
}

function slugifyPath(pathKey: string): string {
  return pathKey
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(stripTemplate)
    .map((segment) => segment.replace(/[^A-Za-z0-9]+/g, '_'))
    .filter((segment) => segment.length > 0)
    .join('_');
}

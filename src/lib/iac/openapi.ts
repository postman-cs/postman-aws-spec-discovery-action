import { parse } from 'yaml';

import type { SpecFormat } from '../../contracts.js';
import { CFN_CUSTOM_TAGS, isOpenApiDocument } from '../providers/cloudformation.js';

export function detectOpenApiContent(content: string): boolean {
  try {
    const trimmed = content.trim();
    const parsed = trimmed.startsWith('{')
      ? JSON.parse(trimmed)
      : parse(trimmed, { customTags: CFN_CUSTOM_TAGS as never[] });
    return isOpenApiDocument(parsed);
  } catch {
    return false;
  }
}

export function openApiFormatForContent(content: string): { format: SpecFormat; filename: string } {
  return content.trim().startsWith('{')
    ? { format: 'openapi-json', filename: 'index.json' }
    : { format: 'openapi-yaml', filename: 'index.yaml' };
}

export function serializeInlineOpenApi(body: unknown): { content: string; format: SpecFormat; filename: string } {
  return {
    content: JSON.stringify(body, null, 2),
    format: 'openapi-json',
    filename: 'index.json'
  };
}

/** True when a CFN/YAML value is an unresolved intrinsic object or string form. */
export function isUnresolvedIntrinsic(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') {
    return /\$\{/.test(value) || /^!/.test(value.trim());
  }
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0) return false;
  return keys.every((key) =>
    /^(Ref|Fn::|Condition)$/.test(key) || key.startsWith('Fn::')
  );
}

export function describeUnresolved(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Exact 10-char API Gateway ID. */
export function isExactApiGatewayId(value: string): boolean {
  return /^[a-z0-9]{10}$/.test(value);
}

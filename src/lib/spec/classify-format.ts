import path from 'node:path';
import { parse } from 'yaml';

import type { SpecFormat } from '../../contracts.js';

export interface ClassifiedSpecFormat {
  format: SpecFormat;
  filename: string;
}

/**
 * Strict content-based classification for byte-bearing seams (repo, SSM, Backstage).
 * Returns undefined for unknown/malformed content — never defaults to OpenAPI.
 */
export function classifySpecContent(
  content: string,
  options: { pathHint?: string } = {}
): ClassifiedSpecFormat | undefined {
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  const pathHint = options.pathHint?.replace(/\\/g, '/');
  const basename = pathHint ? path.posix.basename(pathHint).toLowerCase() : '';

  if (looksLikeWsdl(trimmed)) {
    return { format: 'wsdl', filename: filenameForFormat('wsdl', pathHint) };
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (looksLikeIntrospection(record)) {
          return {
            format: 'graphql-introspection-json',
            filename: filenameForFormat('graphql-introspection-json', pathHint)
          };
        }
        if (typeof record.openapi === 'string' || typeof record.swagger === 'string') {
          return { format: 'openapi-json', filename: filenameForFormat('openapi-json', pathHint) };
        }
        if (typeof record.asyncapi === 'string') {
          return { format: 'asyncapi-json', filename: filenameForFormat('asyncapi-json', pathHint) };
        }
        if (looksLikeMcp(record)) {
          return { format: 'mcp-json', filename: filenameForFormat('mcp-json', pathHint) };
        }
        if (looksLikePostmanCollection(record)) {
          return {
            format: 'postman-collection',
            filename: filenameForFormat('postman-collection', pathHint)
          };
        }
        if (looksLikeAvro(record)) {
          return { format: 'avro', filename: filenameForFormat('avro', pathHint) };
        }
        if (looksLikeJsonSchema(record)) {
          return { format: 'json-schema', filename: filenameForFormat('json-schema', pathHint) };
        }
      }
    } catch {
      // Not JSON — fall through to text/YAML detectors.
    }
  }

  if (/^\s*(openapi|swagger)\s*:/i.test(trimmed)) {
    return { format: 'openapi-yaml', filename: filenameForFormat('openapi-yaml', pathHint) };
  }
  if (/^\s*asyncapi\s*:/i.test(trimmed)) {
    return { format: 'asyncapi-yaml', filename: filenameForFormat('asyncapi-yaml', pathHint) };
  }

  // YAML documents that parse as structured OpenAPI/AsyncAPI/MCP/etc.
  if (!trimmed.startsWith('<') && !trimmed.startsWith('{')) {
    try {
      const parsed = parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (typeof record.openapi === 'string' || typeof record.swagger === 'string') {
          return { format: 'openapi-yaml', filename: filenameForFormat('openapi-yaml', pathHint) };
        }
        if (typeof record.asyncapi === 'string') {
          return { format: 'asyncapi-yaml', filename: filenameForFormat('asyncapi-yaml', pathHint) };
        }
        if (looksLikeMcp(record)) {
          return { format: 'mcp-json', filename: filenameForFormat('mcp-json', pathHint) };
        }
        if (looksLikeIntrospection(record)) {
          return {
            format: 'graphql-introspection-json',
            filename: filenameForFormat('graphql-introspection-json', pathHint)
          };
        }
      }
    } catch {
      // Not YAML.
    }
  }

  if (basename.endsWith('.proto') || looksLikeProtobuf(trimmed)) {
    return { format: 'protobuf', filename: filenameForFormat('protobuf', pathHint) };
  }
  if (
    basename.endsWith('.graphql')
    || basename.endsWith('.gql')
    || basename.endsWith('.graphqls')
    || looksLikeGraphqlSdl(trimmed)
  ) {
    if (looksLikeGraphqlSdl(trimmed)) {
      return { format: 'graphql-sdl', filename: filenameForFormat('graphql-sdl', pathHint) };
    }
  }
  if (basename.endsWith('.smithy') || looksLikeSmithy(trimmed)) {
    if (looksLikeSmithy(trimmed)) {
      return { format: 'smithy', filename: filenameForFormat('smithy', pathHint) };
    }
  }

  return undefined;
}

/**
 * Honor an explicit declared format only when classified bytes are compatible.
 * Returns the detected classification, or undefined on unknown/mismatch.
 */
export function classifyWithDeclaredFormat(
  content: string,
  declaredFormat: string | undefined,
  options: { pathHint?: string } = {}
): ClassifiedSpecFormat | undefined {
  const detected = classifySpecContent(content, options);
  if (!detected) return undefined;
  if (!declaredFormat?.trim()) return detected;
  if (!declaredFormatCompatible(declaredFormat, detected.format)) return undefined;
  return detected;
}

export function declaredFormatCompatible(declared: string, detected: SpecFormat): boolean {
  const normalized = declared.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized === detected) return true;

  switch (normalized) {
    case 'openapi':
    case 'openapi-yaml':
    case 'openapi-json':
    case 'swagger':
      return detected === 'openapi-yaml' || detected === 'openapi-json';
    case 'asyncapi':
    case 'asyncapi-yaml':
    case 'asyncapi-json':
      return detected === 'asyncapi-yaml' || detected === 'asyncapi-json';
    case 'graphql':
    case 'graphql-sdl':
    case 'graphql-introspection':
    case 'graphql-introspection-json':
      return detected === 'graphql-sdl' || detected === 'graphql-introspection-json';
    case 'grpc':
    case 'protobuf':
    case 'proto':
      return detected === 'protobuf';
    case 'soap':
    case 'wsdl':
      return detected === 'wsdl';
    case 'mcp':
    case 'mcp-json':
      return detected === 'mcp-json';
    case 'json-schema':
    case 'jsonschema':
      return detected === 'json-schema';
    case 'avro':
      return detected === 'avro';
    case 'smithy':
      return detected === 'smithy';
    case 'postman':
    case 'postman-collection':
      return detected === 'postman-collection';
    default:
      return false;
  }
}

export function filenameForFormat(format: SpecFormat, pathHint?: string): string {
  const basename = pathHint ? path.posix.basename(pathHint.replace(/\\/g, '/')) : '';
  switch (format) {
    case 'openapi-yaml':
      return basename && /\.(ya?ml)$/i.test(basename) ? basename : 'index.yaml';
    case 'openapi-json':
      return basename && /\.json$/i.test(basename) ? basename : 'index.json';
    case 'asyncapi-yaml':
      return basename && /\.(ya?ml)$/i.test(basename) ? basename : 'asyncapi.yaml';
    case 'asyncapi-json':
      return basename && /\.json$/i.test(basename) ? basename : 'asyncapi.json';
    case 'graphql-sdl':
      return basename && /\.(graphql|graphqls|gql)$/i.test(basename) ? basename : 'schema.graphql';
    case 'graphql-introspection-json':
      return basename && /\.json$/i.test(basename) ? basename : 'introspection.json';
    case 'protobuf':
      return basename && /\.proto$/i.test(basename) ? basename : 'schema.proto';
    case 'wsdl':
      return basename && /\.wsdl$/i.test(basename) ? basename : 'service.wsdl';
    case 'mcp-json':
      return basename && /\.json$/i.test(basename) ? basename : 'mcp.json';
    case 'json-schema':
      return basename && /\.json$/i.test(basename) ? basename : 'schema.json';
    case 'avro':
      return basename && /\.(avsc|avro)$/i.test(basename) ? basename : 'schema.avsc';
    case 'smithy':
      return basename && /\.smithy$/i.test(basename) ? basename : 'model.smithy';
    case 'postman-collection':
      return basename && /\.json$/i.test(basename) ? basename : 'collection.postman_collection.json';
  }
}

export function looksLikeIntrospection(record: Record<string, unknown>): boolean {
  if (record.__schema && typeof record.__schema === 'object' && !Array.isArray(record.__schema)) {
    return true;
  }
  const data = record.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const nested = (data as Record<string, unknown>).__schema;
  return Boolean(nested && typeof nested === 'object' && !Array.isArray(nested));
}

export function looksLikeMcp(record: Record<string, unknown>): boolean {
  if (record.mcpServers && typeof record.mcpServers === 'object' && !Array.isArray(record.mcpServers)) {
    return true;
  }
  if (typeof record.$schema === 'string' && /modelcontextprotocol/i.test(record.$schema)) {
    return true;
  }
  return typeof record.name === 'string'
    && (Array.isArray(record.remotes) || Array.isArray(record.packages));
}

export function looksLikeWsdl(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith('<')) return false;
  const body = trimmed.replace(/^<\?xml[\s\S]*?\?>/i, '').trim();
  const rootMatch = body.match(/<\s*([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)\b([^>]*)>/);
  if (!rootMatch) return false;
  const qualified = rootMatch[1] ?? '';
  const localName = (qualified.includes(':') ? qualified.split(':').pop()! : qualified).toLowerCase();
  if (localName !== 'definitions' && localName !== 'description') return false;
  const head = `${qualified} ${rootMatch[2] ?? ''}`;
  return /wsdl/i.test(head)
    || /schemas\.xmlsoap\.org\/wsdl|www\.w3\.org\/ns\/wsdl/i.test(trimmed);
}

function looksLikePostmanCollection(record: Record<string, unknown>): boolean {
  const info = record.info;
  if (!info || typeof info !== 'object' || Array.isArray(info)) return false;
  const schema = (info as Record<string, unknown>).schema;
  return typeof schema === 'string' && schema.includes('schema.getpostman.com/json/collection');
}

function looksLikeAvro(record: Record<string, unknown>): boolean {
  if (record.type === 'record' && Array.isArray(record.fields) && typeof record.name === 'string') return true;
  if (record.type === 'enum' && Array.isArray(record.symbols) && typeof record.name === 'string') return true;
  if (record.type === 'fixed' && typeof record.size === 'number' && typeof record.name === 'string') return true;
  return false;
}

function looksLikeJsonSchema(record: Record<string, unknown>): boolean {
  if (record.openapi || record.swagger || record.asyncapi) return false;
  if (looksLikeIntrospection(record) || looksLikeMcp(record) || looksLikeAvro(record)) return false;
  if (looksLikePostmanCollection(record)) return false;
  if (typeof record.$schema === 'string' && /json-schema/i.test(record.$schema)) return true;
  if (typeof record.$id === 'string' && (record.type || record.properties || record.$defs || record.definitions)) {
    return true;
  }
  if (record.type === 'object' && (record.properties || record.required || record.$defs || record.definitions)) {
    return true;
  }
  if (record.$defs || record.definitions) return true;
  return false;
}

function looksLikeProtobuf(content: string): boolean {
  return /^\s*syntax\s*=\s*["']proto[23]["']\s*;/m.test(content)
    || /\bservice\s+\w+\s*\{[\s\S]*\brpc\b/.test(content);
}

function looksLikeGraphqlSdl(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed || trimmed.startsWith('{') || trimmed.startsWith('<')) return false;
  if (/^\s*(?:openapi|swagger|asyncapi)\s*:/m.test(trimmed)) return false;
  return /^\s*(?:"""[\s\S]*?"""\s*)?(?:extend\s+)?(?:(?:type|interface|enum|union|scalar|input)\s+[A-Za-z_]|schema\s*\{|directive\s+@)/m.test(
    trimmed
  );
}

function looksLikeSmithy(content: string): boolean {
  return /^\s*\$version:\s*["']2(?:\.\d+)?["']/m.test(content)
    || /\b(namespace|service|structure)\s+[\w#.]+/.test(content);
}

import { execSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';

import type { SpecFormat } from '../../contracts.js';
import { fetchSpecFromUrl } from '../fetch/spec-fetcher.js';
import type { SnsSpecClient } from '../aws/sns-client.js';
import type { SsmSpecClient } from '../aws/ssm-client.js';
import type { EventBridgeSchemasSpecClient } from '../aws/schemas-client.js';
import { detectCatalogApis, type CatalogApiRef } from '../repo/catalog.js';
import { findIaCFiles } from '../repo/scan.js';
import type { ExportOptions, SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

const ASYNCAPI_FILE_NAMES = new Set(['asyncapi.yaml', 'asyncapi.yml', 'asyncapi.json']);
const GENERATED_ASYNCAPI_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);
const GENERATED_ROOT_PREFIXES = ['spec/', 'contracts/', 'events/', 'build/', '.build/', 'out/'] as const;
const DEFAULT_IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist']);
const CONTRACT_REGISTRY_FILES = [
  '.postman/contracts.yaml',
  '.postman/contracts.yml',
  '.postman/contracts.json',
  '.postman/contract-registry.yaml',
  '.postman/contract-registry.yml',
  '.postman/contract-registry.json',
  'contracts.yaml',
  'contracts.yml',
  'contracts.json',
  'contract-registry.yaml',
  'contract-registry.yml',
  'contract-registry.json'
] as const;

interface ServiceSpec {
  serviceName: string;
  url?: string;
  content?: string;
  format?: string;
}

interface RemoteUrlCandidate {
  url: string;
  source: string;
  affinity: number;
}

interface SnsSubscriptionMetadata {
  subscriptionArn: string;
  protocol?: string;
  endpoint?: string;
  variant: 'raw-payload' | 'sns-envelope';
  RawMessageDelivery?: string;
  FilterPolicy?: string;
  FilterPolicyScope?: string;
  filterPolicyScope?: 'MessageAttributes' | 'MessageBody';
  filterPolicyRaw?: string;
  messageAttributes?: Record<string, { dataType?: string }>;
  RedrivePolicy?: string;
  DeliveryPolicy?: string;
}

interface SnsResolutionMetadata {
  contractOrigin: SnsContractOrigin;
  transformed?: boolean;
  subscriptions: SnsSubscriptionMetadata[];
  messageAttributes: Record<string, { dataType?: string }>;
  evidence: string[];
  subscriptionSummary: {
    topicArn: string;
    total: number;
    failed: number;
    errors: Array<{ subscriptionArn?: string; error: string }>;
  };
}

function classifyDeliveryVariant(protocol: string | undefined, rawMessageDelivery: string | undefined): 'raw-payload' | 'sns-envelope' {
  const normalizedProtocol = (protocol ?? '').trim().toLowerCase();
  if (normalizedProtocol === 'lambda') {
    return 'sns-envelope';
  }
  return (rawMessageDelivery ?? '').trim().toLowerCase() === 'true' ? 'raw-payload' : 'sns-envelope';
}

function normalizeFilterPolicyScope(value: string | undefined): 'MessageAttributes' | 'MessageBody' {
  return (value ?? '').trim() === 'MessageBody' ? 'MessageBody' : 'MessageAttributes';
}

function inferFilterPolicyAttributeType(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return 'Number';
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return 'String';
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  if (Array.isArray(value)) {
    let sawString = false;
    let sawNumber = false;
    for (const entry of value) {
      const inferred = inferFilterPolicyAttributeType(entry);
      if (inferred === 'String') {
        sawString = true;
      } else if (inferred === 'Number') {
        sawNumber = true;
      }
    }
    if (sawString) return 'String';
    if (sawNumber) return 'Number';
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if ('numeric' in record) {
    return 'Number';
  }
  if ('anything-but' in record) {
    return inferFilterPolicyAttributeType(record['anything-but']);
  }
  if ('prefix' in record || 'suffix' in record || 'equals-ignore-case' in record || 'ip-address' in record || 'exists' in record) {
    return 'String';
  }

  let sawString = false;
  let sawNumber = false;
  for (const nestedValue of Object.values(record)) {
    const inferred = inferFilterPolicyAttributeType(nestedValue);
    if (inferred === 'String') {
      sawString = true;
    } else if (inferred === 'Number') {
      sawNumber = true;
    }
  }
  if (sawString) return 'String';
  if (sawNumber) return 'Number';
  return undefined;
}

function parseFilterPolicyMessageAttributes(rawValue: string | undefined): Record<string, { dataType?: string }> {
  if (!rawValue?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const attributes: Record<string, { dataType?: string }> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const dataType = inferFilterPolicyAttributeType(value);
      attributes[key] = dataType ? { dataType } : { dataType: 'String' };
    }
    return attributes;
  } catch {
    return {};
  }
}

function mergeMessageAttributes(subscriptions: SnsSubscriptionMetadata[]): Record<string, { dataType?: string }> {
  const merged: Record<string, { dataType?: string }> = {};
  for (const subscription of subscriptions) {
    if (!subscription.messageAttributes) {
      continue;
    }
    for (const [name, attribute] of Object.entries(subscription.messageAttributes)) {
      merged[name] = merged[name] ?? {};
      if (!merged[name].dataType && attribute.dataType) {
        merged[name].dataType = attribute.dataType;
      }
    }
  }
  return merged;
}

function toAsyncApiHeaderSchema(attribute: { dataType?: string }): Record<string, unknown> {
  const normalized = (attribute.dataType ?? '').toLowerCase();
  if (normalized.startsWith('number')) {
    return { type: 'number' };
  }
  return { type: 'string' };
}

function hasExistingAsyncApiHeaders(document: unknown): boolean {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return false;
  }
  const root = document as Record<string, unknown>;
  const channels = root.channels;
  if (!channels || typeof channels !== 'object' || Array.isArray(channels)) {
    return false;
  }

  for (const channel of Object.values(channels as Record<string, unknown>)) {
    if (!channel || typeof channel !== 'object' || Array.isArray(channel)) {
      continue;
    }
    for (const operationName of ['publish', 'subscribe']) {
      const operation = (channel as Record<string, unknown>)[operationName];
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
        continue;
      }
      const message = (operation as Record<string, unknown>).message;
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        continue;
      }
      const messageRecord = message as Record<string, unknown>;
      if (messageRecord.headers) {
        return true;
      }
      if (Array.isArray(messageRecord.oneOf)) {
        for (const oneOfMessage of messageRecord.oneOf) {
          if (oneOfMessage && typeof oneOfMessage === 'object' && !Array.isArray(oneOfMessage) && (oneOfMessage as Record<string, unknown>).headers) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

function deriveAsyncApiHeaders(
  content: string,
  format: SpecFormat,
  messageAttributes: Record<string, { dataType?: string }>
): string {
  if ((format !== 'asyncapi-yaml' && format !== 'asyncapi-json') || Object.keys(messageAttributes).length === 0) {
    return content;
  }

  let parsed: unknown;
  try {
    parsed = format === 'asyncapi-json' ? JSON.parse(content) : parse(content);
  } catch {
    return content;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || hasExistingAsyncApiHeaders(parsed)) {
    return content;
  }

  const document = parsed as Record<string, unknown>;
  const channels = document.channels;
  if (!channels || typeof channels !== 'object' || Array.isArray(channels)) {
    return content;
  }

  const headerRef = '#/components/schemas/SnsDerivedHeaders';
  const components =
    document.components && typeof document.components === 'object' && !Array.isArray(document.components)
      ? (document.components as Record<string, unknown>)
      : {};
  const schemas =
    components.schemas && typeof components.schemas === 'object' && !Array.isArray(components.schemas)
      ? (components.schemas as Record<string, unknown>)
      : {};
  schemas.SnsDerivedHeaders = {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(messageAttributes).map(([name, attribute]) => [name, toAsyncApiHeaderSchema(attribute)])
    ),
    additionalProperties: true
  };
  components.schemas = schemas;
  document.components = components;

  for (const channel of Object.values(channels as Record<string, unknown>)) {
    if (!channel || typeof channel !== 'object' || Array.isArray(channel)) {
      continue;
    }
    for (const operationName of ['publish', 'subscribe']) {
      const operation = (channel as Record<string, unknown>)[operationName];
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
        continue;
      }
      const message = (operation as Record<string, unknown>).message;
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        continue;
      }
      const messageRecord = message as Record<string, unknown>;
      if (Array.isArray(messageRecord.oneOf)) {
        for (const oneOfMessage of messageRecord.oneOf) {
          if (oneOfMessage && typeof oneOfMessage === 'object' && !Array.isArray(oneOfMessage)) {
            const record = oneOfMessage as Record<string, unknown>;
            if (!record.headers) {
              record.headers = { $ref: headerRef };
            }
          }
        }
      } else if (!messageRecord.headers) {
        messageRecord.headers = { $ref: headerRef };
      }
    }
  }

  return format === 'asyncapi-json' ? JSON.stringify(document, null, 2) : stringify(document);
}

interface SnsProviderDependencies {
  fetchSpecFromUrl?: typeof fetchSpecFromUrl;
  catalogApis?: CatalogApiRef[];
  eventBridgeClient?: EventBridgeSchemasSpecClient;
  codeDerivedResolver?: unknown;
  gitIgnoreChecker?: (repoRoot: string, filePath: string) => Promise<boolean> | boolean;
  webhookSidecarBuilder?: (
    canonical: SpecExportResult,
    subscriptions: SnsSubscriptionMetadata[]
  ) => { filename: string; content: string } | undefined;
}

export type SnsContractOrigin =
  | 'repo-asyncapi'
  | 'repo-json-schema'
  | 'generated-asyncapi'
  | 'ssm-content'
  | 'ssm-url'
  | 'catalog-url'
  | 'eventbridge-derived'
  | 'code-derived'
  | 'manual-review';

export type SnsContractResult =
  | {
      resolved: true;
      origin: SnsContractOrigin;
      variantCount?: number;
      result: SpecExportResult;
      evidence: string[];
      metadata: SnsResolutionMetadata;
      sidecars?: Array<{ filename: string; content: string }>;
    }
  | {
      resolved: false;
      evidence: string[];
      metadata: SnsResolutionMetadata;
      sidecars?: Array<{ filename: string; content: string }>;
    };

const METADATA_SIDECAR_FILENAME = 'sns-resolution-metadata.json';
const SPEC_POINTER_FILENAME = 'spec-pointer.json';
const WEBHOOK_SIDECAR_FILENAME = 'webhook.openapi.json';

function topicNameFromArn(topicArn: string): string {
  const index = topicArn.lastIndexOf(':');
  return index >= 0 ? topicArn.slice(index + 1) : topicArn;
}

function normalizeServiceKey(value: string): string {
  return value
    .replace(/\.fifo$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();
}

function resolvePathWithinRoot(rootPath: string, targetPath: string, fieldName: string): string {
  const base = path.resolve(rootPath);
  const resolved = path.resolve(base, targetPath);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${fieldName} must stay within repo-root/workspace; received ${targetPath}`);
  }
  return resolved;
}

function toEvidencePath(repoRoot: string, filePath: string): string {
  const relative = path.relative(repoRoot, filePath);
  return relative.startsWith('..') ? filePath : relative.replace(/\\/g, '/');
}

function groupByService(entries: { serviceName: string; key: string; value: string }[]): ServiceSpec[] {
  const grouped = new Map<string, ServiceSpec>();
  for (const entry of entries) {
    let item = grouped.get(entry.serviceName);
    if (!item) {
      item = { serviceName: entry.serviceName };
      grouped.set(entry.serviceName, item);
    }
    if (entry.key === 'content' || entry.key === 'spec-content') {
      item.content = entry.value;
    } else if (entry.key === 'url' || entry.key === 'spec-url') {
      item.url = entry.value;
    } else if (entry.key === 'format' || entry.key === 'spec-format') {
      item.format = entry.value;
    }
  }
  return [...grouped.values()];
}

function looksLikeJsonSchema(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return Boolean(
    obj.$schema ||
      obj.type ||
      obj.properties ||
      obj.items ||
      obj.required ||
      obj.definitions ||
      obj.$defs
  );
}

function parseKnownFormat(format: string | undefined): { format: SpecFormat; filename: string } | undefined {
  const normalized = (format ?? '').trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'asyncapi-yaml') return { format: 'asyncapi-yaml', filename: 'asyncapi.yaml' };
  if (normalized === 'asyncapi-json') return { format: 'asyncapi-json', filename: 'asyncapi.json' };
  if (normalized === 'json-schema') return { format: 'json-schema', filename: 'schema.json' };
  return undefined;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function bestAffinity(target: string | undefined, hints: Set<string>): number {
  if (!target) return 0;
  const normalized = normalizeServiceKey(target);
  if (!normalized) return 0;

  let score = 0;
  for (const hint of hints) {
    if (!hint) continue;
    if (normalized === hint) {
      score = Math.max(score, 100);
      continue;
    }
    if (normalized.includes(hint) || hint.includes(normalized)) {
      score = Math.max(score, 60);
      continue;
    }
    const hintTokens = new Set(hint.split('-').filter(Boolean));
    const targetTokens = normalized.split('-').filter(Boolean);
    const overlap = targetTokens.some((token) => hintTokens.has(token));
    if (overlap) {
      score = Math.max(score, 30);
    }
  }
  return score;
}

function collectHints(topicName: string, candidateName: string): Set<string> {
  const canonicalTopicName = topicName.replace(/\.fifo$/i, '');
  return new Set(
    [
      normalizeServiceKey(topicName),
      normalizeServiceKey(canonicalTopicName),
      normalizeServiceKey(candidateName),
      normalizeServiceKey(candidateName.replace(/\.fifo$/i, ''))
    ].filter((entry) => entry.length > 0)
  );
}

function extractRegistryUrls(node: unknown, keyTrail: string[] = []): Array<{ selector?: string; url: string }> {
  if (typeof node === 'string') {
    return isHttpUrl(node) ? [{ selector: keyTrail[keyTrail.length - 1], url: node.trim() }] : [];
  }

  if (!node || typeof node !== 'object') {
    return [];
  }

  if (Array.isArray(node)) {
    return node.flatMap((entry) => extractRegistryUrls(entry, keyTrail));
  }

  const record = node as Record<string, unknown>;
  const selectors = [
    record.topic,
    record.topicName,
    record['topic-name'],
    record.service,
    record.serviceName,
    record['service-name'],
    record.name,
    keyTrail[keyTrail.length - 1]
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  const urls = [record.url, record.specUrl, record['spec-url'], record.definition]
    .filter((value): value is string => typeof value === 'string' && isHttpUrl(value))
    .map((value) => value.trim());

  const results: Array<{ selector?: string; url: string }> = [];
  for (const url of urls) {
    if (selectors.length === 0) {
      results.push({ url });
      continue;
    }
    for (const selector of selectors) {
      results.push({ selector, url });
    }
  }

  for (const [key, value] of Object.entries(record)) {
    results.push(...extractRegistryUrls(value, [...keyTrail, key]));
  }

  return results;
}

async function collectCatalogUrlCandidates(
  repoRoot: string,
  hints: Set<string>,
  catalogApis?: CatalogApiRef[]
): Promise<RemoteUrlCandidate[]> {
  const detectedCatalogApis = catalogApis ?? (await detectCatalogApis(repoRoot));
  if (!detectedCatalogApis || detectedCatalogApis.length === 0) {
    return [];
  }

  return detectedCatalogApis
    .filter((entry): entry is { name: string; specUrl: string } => Boolean(entry.specUrl && isHttpUrl(entry.specUrl)))
    .map((entry) => ({
      url: entry.specUrl,
      source: `Backstage catalog API "${entry.name}"`,
      affinity: bestAffinity(entry.name, hints)
    }))
    .filter((entry) => entry.affinity > 0)
    .sort((left, right) => right.affinity - left.affinity || left.url.localeCompare(right.url));
}

async function collectRegistryUrlCandidates(repoRoot: string, hints: Set<string>): Promise<RemoteUrlCandidate[]> {
  const candidates: RemoteUrlCandidate[] = [];

  for (const relativePath of CONTRACT_REGISTRY_FILES) {
    const filePath = path.join(repoRoot, relativePath);
    const content = await readFile(filePath, 'utf8').catch(() => undefined);
    if (!content) continue;

    let parsed: unknown;
    try {
      parsed = relativePath.endsWith('.json') ? JSON.parse(content) : parse(content);
    } catch {
      continue;
    }
    const extracted = extractRegistryUrls(parsed);
    for (const entry of extracted) {
      const affinity = bestAffinity(entry.selector, hints);
      if (affinity > 0) {
        candidates.push({
          url: entry.url,
          source: `contract registry file ${relativePath}`,
          affinity
        });
      }
    }
  }

  const deduped = new Map<string, RemoteUrlCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.source}::${candidate.url}`;
    const existing = deduped.get(key);
    if (!existing || candidate.affinity > existing.affinity) {
      deduped.set(key, candidate);
    }
  }

  return [...deduped.values()].sort((left, right) => right.affinity - left.affinity || left.url.localeCompare(right.url));
}

function buildSsmPointerArtifact(specUrl: string, serviceName: string, fetchError: string): string {
  return JSON.stringify(
    {
      specUrl,
      serviceName,
      registeredVia: 'ssm-parameter-store',
      fetchError
    },
    null,
    2
  );
}

function detectFormat(content: string, filenameHint: string): { format: SpecFormat; filename: string } | undefined {
  const configured = parseKnownFormat(filenameHint);
  if (configured) return configured;

  const trimmed = content.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed.asyncapi) {
      return { format: 'asyncapi-json', filename: 'asyncapi.json' };
    }
    if (looksLikeJsonSchema(parsed)) {
      return { format: 'json-schema', filename: 'schema.json' };
    }
    return undefined;
  } catch {
    // Not JSON.
  }

  try {
    const parsed = parse(trimmed) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.asyncapi) {
      return { format: 'asyncapi-yaml', filename: 'asyncapi.yaml' };
    }
  } catch {
    // Not YAML.
  }

  return undefined;
}

function parseStructuredDocument(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return parse(value);
  }
}

function getSchemaByRef(document: unknown, ref: string): unknown {
  const match = /^#\/(.+)$/.exec(ref);
  if (!match || !document || typeof document !== 'object' || Array.isArray(document)) {
    return undefined;
  }
  const segments = match[1]?.split('/') ?? [];
  let current: unknown = document;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolveSchemaNode(node: unknown, root: unknown, visited = new Set<string>()): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return node;
  }
  const record = node as Record<string, unknown>;
  const ref = typeof record.$ref === 'string' ? record.$ref : undefined;
  if (!ref) {
    return record;
  }
  if (visited.has(ref)) {
    return undefined;
  }
  visited.add(ref);
  const resolved = getSchemaByRef(root, ref);
  return resolveSchemaNode(resolved, root, visited);
}

function hasSnsEnvelopeFields(node: unknown, root: unknown): boolean {
  const resolved = resolveSchemaNode(node, root);
  if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
    return false;
  }
  const properties = (resolved as Record<string, unknown>).properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return false;
  }
  const propertyKeys = Object.keys(properties as Record<string, unknown>);
  return ['Message', 'MessageId', 'TopicArn', 'Type'].every((requiredField) => propertyKeys.includes(requiredField));
}

function detectSnsShapeFromSchemaDocument(document: unknown): { matches: boolean; transformed: boolean } {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { matches: false, transformed: false };
  }
  const root = document as Record<string, unknown>;
  if (hasSnsEnvelopeFields(root, root)) {
    return { matches: true, transformed: false };
  }

  const rootProperties = root.properties;
  if (rootProperties && typeof rootProperties === 'object' && !Array.isArray(rootProperties)) {
    const detailNode = (rootProperties as Record<string, unknown>).detail;
    if (detailNode && hasSnsEnvelopeFields(detailNode, root)) {
      return { matches: true, transformed: true };
    }
  }

  const components = root.components;
  const componentSchemas =
    components && typeof components === 'object' && !Array.isArray(components)
      ? (components as Record<string, unknown>).schemas
      : undefined;
  if (componentSchemas && typeof componentSchemas === 'object' && !Array.isArray(componentSchemas)) {
    for (const schema of Object.values(componentSchemas as Record<string, unknown>)) {
      if (hasSnsEnvelopeFields(schema, root)) {
        return { matches: true, transformed: false };
      }
      if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
        const detailNode = (schema as Record<string, unknown>).properties;
        if (detailNode && typeof detailNode === 'object' && !Array.isArray(detailNode)) {
          const nestedDetail = (detailNode as Record<string, unknown>).detail;
          if (nestedDetail && hasSnsEnvelopeFields(nestedDetail, root)) {
            return { matches: true, transformed: true };
          }
        }
      }
    }
  }

  return { matches: false, transformed: false };
}

function deepCloneJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function extractAsyncApiPayloadSchema(document: unknown): { payloadSchema: unknown; components?: Record<string, unknown> } {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { payloadSchema: { type: 'object' } };
  }

  const root = document as Record<string, unknown>;
  const channels = root.channels;
  const components =
    root.components && typeof root.components === 'object' && !Array.isArray(root.components)
      ? (root.components as Record<string, unknown>)
      : undefined;
  const schemas = components?.schemas;
  const messages = components?.messages;
  const schemaComponents = schemas && typeof schemas === 'object' && !Array.isArray(schemas) ? (schemas as Record<string, unknown>) : {};
  const messageComponents = messages && typeof messages === 'object' && !Array.isArray(messages) ? (messages as Record<string, unknown>) : {};
  const copiedComponents: Record<string, unknown> = {};
  const seen = new Set<string>();
  const seenMessages = new Set<string>();

  const resolveMessageByRef = (value: unknown): Record<string, unknown> | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const ref = typeof record.$ref === 'string' ? record.$ref : undefined;
    if (!ref) {
      return record;
    }
    const match = /^#\/components\/messages\/(.+)$/.exec(ref);
    if (!match) {
      return record;
    }
    const messageName = match[1];
    if (!messageName || seenMessages.has(messageName)) {
      return undefined;
    }
    const sourceMessage = messageComponents[messageName];
    if (!sourceMessage || typeof sourceMessage !== 'object' || Array.isArray(sourceMessage)) {
      return undefined;
    }
    seenMessages.add(messageName);
    const resolved = resolveMessageByRef(sourceMessage);
    seenMessages.delete(messageName);
    return resolved;
  };

  const copyComponentSchemaByRef = (ref: string): void => {
    const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
    if (!match) return;
    const schemaName = match[1];
    if (!schemaName || seen.has(schemaName)) return;
    const sourceSchema = schemaComponents[schemaName];
    if (!sourceSchema || typeof sourceSchema !== 'object' || Array.isArray(sourceSchema)) return;
    seen.add(schemaName);
    copiedComponents[schemaName] = deepCloneJsonValue(sourceSchema);
    collectNestedRefs(copiedComponents[schemaName]);
  };

  const collectNestedRefs = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const entry of value) collectNestedRefs(entry);
      return;
    }
    const record = value as Record<string, unknown>;
    const ref = typeof record.$ref === 'string' ? record.$ref : undefined;
    if (ref) {
      copyComponentSchemaByRef(ref);
    }
    for (const nested of Object.values(record)) {
      collectNestedRefs(nested);
    }
  };

  const finalize = (payloadSchema: unknown): { payloadSchema: unknown; components?: Record<string, unknown> } => {
    collectNestedRefs(payloadSchema);
    return {
      payloadSchema,
      ...(Object.keys(copiedComponents).length > 0 ? { components: copiedComponents } : {})
    };
  };

  if (!channels || typeof channels !== 'object' || Array.isArray(channels)) {
    return { payloadSchema: { type: 'object' } };
  }

  for (const channelValue of Object.values(channels as Record<string, unknown>)) {
    if (!channelValue || typeof channelValue !== 'object' || Array.isArray(channelValue)) {
      continue;
    }
    for (const operationName of ['publish', 'subscribe']) {
      const operation = (channelValue as Record<string, unknown>)[operationName];
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
        continue;
      }
      const message = resolveMessageByRef((operation as Record<string, unknown>).message);
      if (!message) {
        continue;
      }
      const payload = message.payload;
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        return finalize(payload);
      }
      const oneOf = message.oneOf;
      if (Array.isArray(oneOf)) {
        const oneOfPayloadSchemas: unknown[] = [];
        for (const entry of oneOf) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            continue;
          }
          const resolvedEntry = resolveMessageByRef(entry);
          if (!resolvedEntry) {
            continue;
          }
          if (typeof resolvedEntry.$ref === 'string' && /^#\/components\/schemas\/.+$/.test(resolvedEntry.$ref)) {
            oneOfPayloadSchemas.push({ $ref: resolvedEntry.$ref });
            continue;
          }
          const oneOfPayload = resolvedEntry.payload;
          if (oneOfPayload && typeof oneOfPayload === 'object' && !Array.isArray(oneOfPayload)) {
            oneOfPayloadSchemas.push(oneOfPayload);
          }
        }
        if (oneOfPayloadSchemas.length > 0) {
          return finalize({ oneOf: oneOfPayloadSchemas });
        }
      }
    }
  }

  return { payloadSchema: { type: 'object' } };
}

function canonicalPayloadSchema(canonical: SpecExportResult): { payloadSchema: unknown; components?: Record<string, unknown> } {
  if (canonical.format === 'json-schema') {
    try {
      const parsed = JSON.parse(canonical.content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { payloadSchema: parsed };
      }
    } catch {
      return { payloadSchema: { type: 'object' } };
    }
    return { payloadSchema: { type: 'object' } };
  }

  if (canonical.format === 'asyncapi-json') {
    try {
      return extractAsyncApiPayloadSchema(JSON.parse(canonical.content));
    } catch {
      return { payloadSchema: { type: 'object' } };
    }
  }

  if (canonical.format === 'asyncapi-yaml') {
    try {
      return extractAsyncApiPayloadSchema(parse(canonical.content));
    } catch {
      return { payloadSchema: { type: 'object' } };
    }
  }

  return { payloadSchema: { type: 'object' } };
}

function buildWebhookPayloadSchema(rawDelivery: boolean, baseSchema: unknown): unknown {
  const payloadSchema = deepCloneJsonValue(baseSchema);
  if (rawDelivery) {
    return payloadSchema;
  }
  return {
    type: 'object',
    properties: {
      Type: { type: 'string' },
      MessageId: { type: 'string' },
      TopicArn: { type: 'string' },
      Timestamp: { type: 'string' },
      Message: payloadSchema
    },
    required: ['Message'],
    additionalProperties: true
  };
}

function buildWebhookSidecar(
  canonical: SpecExportResult,
  subscriptions: SnsSubscriptionMetadata[]
): { filename: string; content: string } | undefined {
  const httpSubscriptions = subscriptions.filter((subscription) => {
    const protocol = (subscription.protocol ?? '').toLowerCase();
    return protocol === 'http' || protocol === 'https';
  });
  if (httpSubscriptions.length === 0) {
    return undefined;
  }

  const payloadExtraction = canonicalPayloadSchema(canonical);
  const basePayloadSchema = payloadExtraction.payloadSchema;
  const variants = new Set(httpSubscriptions.map((subscription) => subscription.variant === 'raw-payload'));
  const webhooks: Record<string, unknown> = {};

  for (const rawDelivery of variants) {
    const webhookName = rawDelivery ? 'snsMessageRaw' : 'snsMessageWrapped';
    webhooks[webhookName] = {
      post: {
        operationId: webhookName,
        'x-sns-raw-delivery': rawDelivery,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: buildWebhookPayloadSchema(rawDelivery, basePayloadSchema)
            }
          }
        },
        responses: {
          '200': {
            description: 'SNS notification received'
          }
        }
      }
    };
  }

  return {
    filename: WEBHOOK_SIDECAR_FILENAME,
    content: JSON.stringify(
      {
        openapi: '3.1.0',
        info: {
          title: 'SNS Webhook Sidecar',
          version: '1.0.0'
        },
        webhooks,
        ...(payloadExtraction.components ? { components: { schemas: payloadExtraction.components } } : {})
      },
      null,
      2
    )
  };
}

function sortByTopicAffinity(files: string[], topicName: string): string[] {
  const loweredTopicName = topicName.toLowerCase();
  return [...files].sort((left, right) => {
    const leftMatch = left.toLowerCase().includes(loweredTopicName);
    const rightMatch = right.toLowerCase().includes(loweredTopicName);
    if (leftMatch !== rightMatch) {
      return leftMatch ? -1 : 1;
    }
    return left.localeCompare(right);
  });
}

function normalizePathForMatch(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function isGeneratedSearchRootPath(repoRoot: string, filePath: string): boolean {
  const relative = normalizePathForMatch(path.relative(repoRoot, filePath));
  return GENERATED_ROOT_PREFIXES.some((prefix) => relative.startsWith(prefix));
}

function isGeneratedAsyncApiPath(repoRoot: string, filePath: string): boolean {
  const relative = normalizePathForMatch(path.relative(repoRoot, filePath));
  const base = path.basename(relative).toLowerCase();
  const isDotAsyncApi = base.endsWith('.asyncapi.yaml') || base.endsWith('.asyncapi.yml') || base.endsWith('.asyncapi.json');
  const isNamedAsyncApi = base === 'asyncapi.yaml' || base === 'asyncapi.yml' || base === 'asyncapi.json';

  if (relative.startsWith('spec/') || relative.startsWith('contracts/')) {
    return isDotAsyncApi;
  }
  if (relative.startsWith('events/')) {
    return isNamedAsyncApi;
  }
  if (relative.startsWith('build/') || relative.startsWith('.build/') || relative.startsWith('out/')) {
    return isDotAsyncApi || isNamedAsyncApi;
  }
  return false;
}

async function collectFilesByExtensionUnfiltered(currentPath: string): Promise<string[]> {
  const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      if (DEFAULT_IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      files.push(...(await collectFilesByExtensionUnfiltered(fullPath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }
    if (GENERATED_ASYNCAPI_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files;
}

function isFrameworkOutputPath(repoRoot: string, filePath: string): boolean {
  const relative = normalizePathForMatch(path.relative(repoRoot, filePath));
  return relative.startsWith('build/') || relative.startsWith('.build/') || relative.startsWith('out/');
}

async function isGitIgnoredByGit(repoRoot: string, filePath: string): Promise<boolean> {
  const relative = normalizePathForMatch(path.relative(repoRoot, filePath));
  if (!relative || relative.startsWith('..')) {
    return true;
  }
  try {
    const escapedRelative = relative.replace(/(["`$\\])/g, '\\$1');
    execSync(`git check-ignore -q -- "${escapedRelative}"`, { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function findContractFiles(repoRoot: string, topicName: string): Promise<{ asyncapi: string[]; jsonSchema: string[] }> {
  const files = await findIaCFiles(repoRoot, ['.yaml', '.yml', '.json']);
  const asyncapi: string[] = [];
  const jsonSchema: string[] = [];

  for (const filePath of files) {
    const safePath = resolvePathWithinRoot(repoRoot, filePath, 'repo contract path');
    const baseName = path.basename(safePath).toLowerCase();
    if (isGeneratedSearchRootPath(repoRoot, safePath)) {
      if (baseName === 'schema.json' || baseName.endsWith('.schema.json')) {
        jsonSchema.push(safePath);
      }
      continue;
    }
    if (ASYNCAPI_FILE_NAMES.has(baseName)) {
      asyncapi.push(safePath);
      continue;
    }
    if (baseName === 'schema.json' || baseName.endsWith('.schema.json')) {
      jsonSchema.push(safePath);
    }
  }

  return {
    asyncapi: sortByTopicAffinity(asyncapi, topicName),
    jsonSchema: sortByTopicAffinity(jsonSchema, topicName)
  };
}

async function findGeneratedAsyncApiFiles(
  repoRoot: string,
  topicName: string,
  gitIgnoreChecker: (repoRoot: string, filePath: string) => Promise<boolean> | boolean = isGitIgnoredByGit
): Promise<string[]> {
  const scanned = await findIaCFiles(repoRoot, ['.yaml', '.yml', '.json']);
  const discovered = new Set<string>(scanned);

  for (const frameworkRoot of ['build', '.build', 'out']) {
    const rootPath = path.join(repoRoot, frameworkRoot);
    const rootStats = await stat(rootPath).catch(() => null);
    if (!rootStats || !rootStats.isDirectory()) {
      continue;
    }
    for (const filePath of await collectFilesByExtensionUnfiltered(rootPath)) {
      discovered.add(filePath);
    }
  }

  const accepted: string[] = [];
  for (const filePath of discovered) {
    if (!isGeneratedAsyncApiPath(repoRoot, filePath)) {
      continue;
    }

    if (!isFrameworkOutputPath(repoRoot, filePath)) {
      accepted.push(filePath);
      continue;
    }

    const ignored = await gitIgnoreChecker(repoRoot, filePath);
    if (!ignored) {
      accepted.push(filePath);
    }
  }

  return sortByTopicAffinity(accepted, topicName);
}

async function resolveAsyncApiContract(
  repoRoot: string,
  files: string[],
  sourceLabel: 'repo-local' | 'generated' = 'repo-local'
): Promise<{ match?: SpecExportResult; evidence: string[] }> {
  const evidence: string[] = [];

  for (const filePath of files) {
    const relativePath = toEvidencePath(repoRoot, filePath);
    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      evidence.push(`Skipped malformed AsyncAPI file ${relativePath} (unreadable)`);
      continue;
    }

    try {
      const parsed = filePath.toLowerCase().endsWith('.json') ? JSON.parse(content) : parse(content);
      if (!parsed || typeof parsed !== 'object' || !('asyncapi' in (parsed as Record<string, unknown>))) {
        evidence.push(`Skipped malformed AsyncAPI file ${relativePath} (missing asyncapi key)`);
        continue;
      }

      const format: SpecFormat = filePath.toLowerCase().endsWith('.json') ? 'asyncapi-json' : 'asyncapi-yaml';
      const sourceDescription = sourceLabel === 'generated' ? 'generated AsyncAPI' : 'repo-local AsyncAPI';
      return {
        match: {
          content,
          format,
          filename: path.basename(filePath),
          evidence: [...evidence, `Resolved SNS contract from ${sourceDescription} file ${relativePath}`]
        },
        evidence
      };
    } catch {
      evidence.push(`Skipped malformed AsyncAPI file ${relativePath} (failed to parse)`);
    }
  }

  return { evidence };
}

async function resolveJsonSchemaContract(
  repoRoot: string,
  files: string[],
  inheritedEvidence: string[] = []
): Promise<{ match?: SpecExportResult; evidence: string[] }> {
  const evidence: string[] = [...inheritedEvidence];

  for (const filePath of files) {
    const relativePath = toEvidencePath(repoRoot, filePath);
    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      evidence.push(`Skipped malformed JSON Schema file ${relativePath} (unreadable)`);
      continue;
    }

    try {
      const parsed = JSON.parse(content);
      if (!looksLikeJsonSchema(parsed)) {
        evidence.push(`Skipped malformed JSON Schema file ${relativePath} (missing schema markers)`);
        continue;
      }
      return {
        match: {
          content,
          format: 'json-schema',
          filename: path.basename(filePath),
          evidence: [...evidence, `Resolved SNS contract from repo-local JSON Schema file ${relativePath}`]
        },
        evidence
      };
    } catch {
      evidence.push(`Skipped malformed JSON Schema file ${relativePath} (failed to parse JSON)`);
    }
  }

  return { evidence };
}

export class SnsProvider implements SpecProvider {
  public readonly type = 'sns' as const;
  private readonly fetchRemoteSpec: typeof fetchSpecFromUrl;
  private readonly preloadedCatalogApis?: CatalogApiRef[];
  private readonly eventBridgeClient?: EventBridgeSchemasSpecClient;
  private readonly codeDerivedResolver?: unknown;
  private readonly gitIgnoreChecker: (repoRoot: string, filePath: string) => Promise<boolean> | boolean;
  private readonly webhookSidecarBuilder: (
    canonical: SpecExportResult,
    subscriptions: SnsSubscriptionMetadata[]
  ) => { filename: string; content: string } | undefined;

  public constructor(
    private readonly client: SnsSpecClient,
    private readonly repoRoot: string = '.',
    private readonly ssmClient?: SsmSpecClient,
    dependencies: typeof fetchSpecFromUrl | SnsProviderDependencies = fetchSpecFromUrl
  ) {
    if (typeof dependencies === 'function') {
      this.fetchRemoteSpec = dependencies;
      this.gitIgnoreChecker = isGitIgnoredByGit;
      this.webhookSidecarBuilder = buildWebhookSidecar;
      return;
    }

    this.fetchRemoteSpec = dependencies.fetchSpecFromUrl ?? fetchSpecFromUrl;
    this.preloadedCatalogApis = dependencies.catalogApis;
    this.eventBridgeClient = dependencies.eventBridgeClient;
    this.codeDerivedResolver = dependencies.codeDerivedResolver;
    this.gitIgnoreChecker = dependencies.gitIgnoreChecker ?? isGitIgnoredByGit;
    this.webhookSidecarBuilder = dependencies.webhookSidecarBuilder ?? buildWebhookSidecar;
  }

  public async probe(): Promise<boolean> {
    return this.client.probe();
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const topics = await this.client.listTopics();
    if (topics.length === 0) {
      return [];
    }

    const candidates: SpecCandidate[] = [];
    for (const topic of topics) {
      const topicArn = topic.topicArn;
      const arnDerivedTopicName = topicNameFromArn(topicArn);
      const attributes: Record<string, string> = await this.client
        .getTopicAttributes(topicArn)
        .catch((): Record<string, string> => ({}));
      const tags: Record<string, string> = await this.client
        .listTagsForResource(topicArn)
        .catch((): Record<string, string> => ({}));
      const taggedServiceName = (tags['postman:project-name'] ?? '').trim();
      const candidateName = taggedServiceName || arnDerivedTopicName;

      candidates.push({
        id: topicArn,
        name: candidateName,
        providerType: 'sns',
        tags,
        evidence: [`SNS topic discovered: ${topicArn}`],
        meta: {
          topicArn,
          arnDerivedTopicName,
          ...(attributes.DisplayName ? { displayName: attributes.DisplayName } : {})
        }
      });
    }

    return candidates;
  }

  public async exportSpec(candidate: SpecCandidate, _options?: ExportOptions): Promise<SpecExportResult> {
    void _options;

    const resolvedRepoRoot = path.resolve(this.repoRoot);
    const topicArn = candidate.meta.topicArn ?? candidate.id;
    const topicName = topicNameFromArn(topicArn);
    resolvePathWithinRoot(resolvedRepoRoot, topicName, 'topic-name');

    const contract = await this.resolveContract(candidate);
    if (contract.resolved) {
      return {
        ...contract.result,
        sidecars: [
          ...(contract.result.sidecars ?? []),
          ...(contract.sidecars ?? []),
          { filename: METADATA_SIDECAR_FILENAME, content: JSON.stringify(contract.metadata, null, 2) }
        ]
      };
    }

    const manualReview = {
      status: 'unresolved',
      sourceType: 'manual-review',
      providerType: 'sns',
      topicArn,
      topicName,
      attemptedSources: [
        'repo-local-asyncapi',
        'repo-local-json-schema',
        'generated-asyncapi',
        'ssm-registry',
        'catalog-url',
        'eventbridge-derived'
      ]
    };

    return {
      content: JSON.stringify(manualReview, null, 2),
      format: 'json-schema',
      filename: 'manual-review.json',
      evidence: contract.evidence,
      sidecars: [...(contract.sidecars ?? []), { filename: METADATA_SIDECAR_FILENAME, content: JSON.stringify(contract.metadata, null, 2) }]
    };
  }

  public async resolveContract(candidate: SpecCandidate): Promise<SnsContractResult> {
    const resolvedRepoRoot = path.resolve(this.repoRoot);
    const topicArn = candidate.meta.topicArn ?? candidate.id;
    const topicName = topicNameFromArn(topicArn);
    const affinityHints = collectHints(topicName, candidate.name);
    resolvePathWithinRoot(resolvedRepoRoot, topicName, 'topic-name');
    void this.eventBridgeClient;
    void this.codeDerivedResolver;
    let pointerSidecar: { filename: string; content: string } | undefined;

    const files = await findContractFiles(resolvedRepoRoot, topicName);
    const asyncApiResolution = await resolveAsyncApiContract(resolvedRepoRoot, files.asyncapi, 'repo-local');
    let resolvedOrigin: SnsContractOrigin | undefined;
    let resolvedExport: SpecExportResult | undefined;
    let priorEvidence: string[] = [];
    if (asyncApiResolution.match) {
      resolvedOrigin = 'repo-asyncapi';
      resolvedExport = asyncApiResolution.match;
      priorEvidence = asyncApiResolution.match.evidence;
    }

    const jsonSchemaResolution = resolvedExport
      ? { evidence: priorEvidence }
      : await resolveJsonSchemaContract(resolvedRepoRoot, files.jsonSchema, asyncApiResolution.evidence);
    if (!resolvedExport && 'match' in jsonSchemaResolution && jsonSchemaResolution.match) {
      resolvedOrigin = 'repo-json-schema';
      resolvedExport = jsonSchemaResolution.match;
      priorEvidence = jsonSchemaResolution.match.evidence;
    }

    const generatedAsyncApiResolution = resolvedExport
      ? { evidence: priorEvidence }
      : await resolveAsyncApiContract(
          resolvedRepoRoot,
          await findGeneratedAsyncApiFiles(resolvedRepoRoot, topicName, this.gitIgnoreChecker),
          'generated'
        );
    if (!resolvedExport && 'match' in generatedAsyncApiResolution && generatedAsyncApiResolution.match) {
      resolvedOrigin = 'generated-asyncapi';
      resolvedExport = generatedAsyncApiResolution.match;
      priorEvidence = generatedAsyncApiResolution.match.evidence;
    }

    if (!resolvedExport) {
      priorEvidence = [...jsonSchemaResolution.evidence, ...generatedAsyncApiResolution.evidence];
    }

    if (!resolvedExport && this.ssmClient) {
      const specs = groupByService(await this.ssmClient.listSpecParameters());
      const canonicalTopicName = topicName.replace(/\.fifo$/i, '');
      const serviceKeys = new Set(
        [
          topicName,
          canonicalTopicName,
          topicName.toLowerCase(),
          canonicalTopicName.toLowerCase(),
          normalizeServiceKey(topicName),
          normalizeServiceKey(canonicalTopicName)
        ].filter((entry) => entry.length > 0)
      );
      const ssmMatch = specs.find((entry) => {
        const entryName = entry.serviceName.trim();
        if (!entryName) {
          return false;
        }
        return (
          serviceKeys.has(entryName) ||
          serviceKeys.has(entryName.toLowerCase()) ||
          serviceKeys.has(normalizeServiceKey(entryName))
        );
      });
      if (ssmMatch?.content) {
        const resolvedFormat = parseKnownFormat(ssmMatch.format) ?? detectFormat(ssmMatch.content, ssmMatch.format ?? '');
        if (resolvedFormat) {
          const evidence = [...priorEvidence, `Resolved SNS contract from SSM path /postman/specs/${ssmMatch.serviceName}/`];
          resolvedOrigin = 'ssm-content';
          resolvedExport = {
            content: ssmMatch.content,
            format: resolvedFormat.format,
            filename: resolvedFormat.filename,
            evidence
          };
          priorEvidence = evidence;
        }
      }

      const ssmUrl = ssmMatch?.url;
      if (!resolvedExport && ssmUrl) {
        try {
          const fetched = await this.fetchRemoteSpec(ssmUrl, { timeoutMs: 15000 });
          const resolvedFormat = parseKnownFormat(ssmMatch?.format) ?? detectFormat(fetched.content, ssmMatch?.format ?? '');
          if (resolvedFormat) {
            const evidence = [...priorEvidence, `Resolved SNS contract from SSM URL /postman/specs/${ssmMatch.serviceName}/`];
            resolvedOrigin = 'ssm-url';
            resolvedExport = {
              content: fetched.content,
              format: resolvedFormat.format,
              filename: resolvedFormat.filename,
              evidence
            };
            priorEvidence = evidence;
          }

          if (!resolvedExport) {
            priorEvidence.push(
              `Fetched SSM URL ${ssmUrl} but unsupported format for SNS contract resolution; expected AsyncAPI or JSON Schema`
            );
          }
        } catch (fetchError) {
          const detail = fetchError instanceof Error ? fetchError.message : String(fetchError);
          const pointerArtifact = buildSsmPointerArtifact(ssmUrl, ssmMatch.serviceName, detail);
          pointerSidecar = { filename: SPEC_POINTER_FILENAME, content: pointerArtifact };
          priorEvidence.push(
            `Failed to fetch SNS contract from SSM URL ${ssmUrl}; pointer artifact spec-pointer.json: ${pointerArtifact}`
          );
        }
      }
    }

    if (!resolvedExport) {
      const remoteUrlCandidates = [
        ...(await collectCatalogUrlCandidates(resolvedRepoRoot, affinityHints, this.preloadedCatalogApis)),
        ...(await collectRegistryUrlCandidates(resolvedRepoRoot, affinityHints))
      ].sort((left, right) => right.affinity - left.affinity || left.source.localeCompare(right.source));

      for (const remoteCandidate of remoteUrlCandidates) {
        try {
          const fetched = await this.fetchRemoteSpec(remoteCandidate.url, { timeoutMs: 15000 });
          const resolvedFormat = detectFormat(fetched.content, '');
          if (!resolvedFormat) {
            priorEvidence.push(
              `Fetched ${remoteCandidate.source} URL ${remoteCandidate.url} but unsupported format for SNS contract resolution; expected AsyncAPI or JSON Schema`
            );
            continue;
          }
          const evidence = [...priorEvidence, `Resolved SNS contract from ${remoteCandidate.source} URL ${remoteCandidate.url}`];
          resolvedOrigin = 'catalog-url';
          resolvedExport = {
            content: fetched.content,
            format: resolvedFormat.format,
            filename: resolvedFormat.filename,
            evidence
          };
          priorEvidence = evidence;
          break;
        } catch (fetchError) {
          const detail = fetchError instanceof Error ? fetchError.message : String(fetchError);
          priorEvidence.push(`Failed to fetch SNS contract from ${remoteCandidate.source} URL ${remoteCandidate.url}: ${detail}`);
        }
      }
    }

    let bridgeDerivedTransformed = false;
    if (!resolvedExport && this.eventBridgeClient) {
      try {
        const registries = await this.eventBridgeClient.listRegistries();
        const topicHints = collectHints(topicName, candidate.name);
        const matchedSchemas: Array<{ registryName: string; schemaName: string; affinity: number }> = [];

        for (const registry of registries) {
          const schemas = await this.eventBridgeClient.listSchemas(registry.name);
          for (const schema of schemas) {
            const affinity = bestAffinity(schema.name, topicHints);
            if (affinity > 0) {
              matchedSchemas.push({ registryName: registry.name, schemaName: schema.name, affinity });
            }
          }
        }

        matchedSchemas.sort((left, right) => right.affinity - left.affinity || left.schemaName.localeCompare(right.schemaName));
        for (const schema of matchedSchemas) {
          try {
            const described = await this.eventBridgeClient.describeSchema(schema.registryName, schema.schemaName);
            const parsed = parseStructuredDocument(described.content);
            const shape = detectSnsShapeFromSchemaDocument(parsed);
            if (!shape.matches) {
              priorEvidence.push(
                `EventBridge schema ${schema.registryName}/${schema.schemaName} did not match SNS payload shape`
              );
              continue;
            }
            resolvedOrigin = 'eventbridge-derived';
            bridgeDerivedTransformed = shape.transformed;
            resolvedExport = {
              content: typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2),
              format: 'json-schema',
              filename: 'index.json',
              evidence: [
                ...priorEvidence,
                `Resolved SNS contract from EventBridge schema ${schema.registryName}/${schema.schemaName}`
              ]
            };
            priorEvidence = resolvedExport.evidence;
            break;
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            priorEvidence.push(`Failed describing EventBridge schema ${schema.registryName}/${schema.schemaName}: ${detail}`);
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        priorEvidence.push(`EventBridge bridge detection unavailable: ${detail}`);
      }
    }

    const subscriptionInspection = await this.inspectSubscriptions(topicArn);
    const finalEvidence = [...priorEvidence, ...subscriptionInspection.evidence];
    if (!resolvedExport || !resolvedOrigin) {
      finalEvidence.push(`No SNS contract found for ${topicArn}; manual review required`);
      const messageAttributes = mergeMessageAttributes(subscriptionInspection.subscriptions);
      const metadata: SnsResolutionMetadata = {
        contractOrigin: 'manual-review',
        subscriptions: subscriptionInspection.subscriptions,
        messageAttributes,
        evidence: finalEvidence,
        subscriptionSummary: {
          topicArn,
          total: subscriptionInspection.subscriptions.length,
          failed: subscriptionInspection.errors.length,
          errors: subscriptionInspection.errors
        }
      };
      return {
        resolved: false,
        evidence: finalEvidence,
        metadata,
        sidecars: pointerSidecar ? [pointerSidecar] : undefined
      };
    }

    const messageAttributes = mergeMessageAttributes(subscriptionInspection.subscriptions);
    resolvedExport = {
      ...resolvedExport,
      content: deriveAsyncApiHeaders(resolvedExport.content, resolvedExport.format, messageAttributes)
    };
    const metadata: SnsResolutionMetadata = {
      contractOrigin: resolvedOrigin,
      ...(resolvedOrigin === 'eventbridge-derived' && bridgeDerivedTransformed ? { transformed: true } : {}),
      subscriptions: subscriptionInspection.subscriptions,
      messageAttributes,
      evidence: finalEvidence,
      subscriptionSummary: {
        topicArn,
        total: subscriptionInspection.subscriptions.length,
        failed: subscriptionInspection.errors.length,
        errors: subscriptionInspection.errors
      }
    };
    const variantCount = new Set(metadata.subscriptions.map((subscription) => subscription.variant)).size;
    const sidecars = pointerSidecar ? [pointerSidecar] : [];
    try {
      const webhookSidecar = this.webhookSidecarBuilder(resolvedExport, metadata.subscriptions);
      if (webhookSidecar) {
        sidecars.push(webhookSidecar);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      finalEvidence.push(`Failed to generate webhook sidecar for ${topicArn}: ${detail}`);
    }

    return {
      resolved: true,
      origin: resolvedOrigin,
      variantCount,
      result: {
        ...resolvedExport,
        evidence: finalEvidence
      },
      evidence: finalEvidence,
      metadata,
      sidecars: sidecars.length > 0 ? sidecars : undefined
    };
  }

  private async inspectSubscriptions(topicArn: string): Promise<{
    subscriptions: SnsSubscriptionMetadata[];
    evidence: string[];
    errors: Array<{ subscriptionArn?: string; error: string }>;
  }> {
    const evidence: string[] = [];
    const errors: Array<{ subscriptionArn?: string; error: string }> = [];
    let summaries: Awaited<ReturnType<SnsSpecClient['listSubscriptionsByTopic']>>;
    try {
      summaries = await this.client.listSubscriptionsByTopic(topicArn);
      evidence.push(`Inspected SNS subscriptions for topic ${topicArn}; discovered ${summaries.length}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const isAccessDenied = /AccessDeniedException/i.test(detail);
      evidence.push(
        isAccessDenied
          ? `Could not list subscriptions for ${topicArn}: AccessDeniedException (continuing with evidence only)`
          : `Could not list subscriptions for ${topicArn}: ${detail} (continuing with evidence only)`
      );
      errors.push({ error: detail });
      return { subscriptions: [], evidence, errors };
    }

    const subscriptions: SnsSubscriptionMetadata[] = [];
    for (const summary of summaries) {
      const subscriptionArn = summary.subscriptionArn;
      if (!subscriptionArn) {
        continue;
      }
      try {
        const attributes = await this.client.getSubscriptionAttributes(subscriptionArn);
        const filterPolicyScope = normalizeFilterPolicyScope(attributes.FilterPolicyScope);
        const parsedMessageAttributes =
          filterPolicyScope === 'MessageAttributes' ? parseFilterPolicyMessageAttributes(attributes.FilterPolicy) : {};
        subscriptions.push({
          subscriptionArn,
          protocol: attributes.Protocol ?? summary.protocol,
          endpoint: attributes.Endpoint ?? summary.endpoint,
          variant: classifyDeliveryVariant(attributes.Protocol ?? summary.protocol, attributes.RawMessageDelivery),
          RawMessageDelivery: attributes.RawMessageDelivery,
          FilterPolicy: attributes.FilterPolicy,
          FilterPolicyScope: attributes.FilterPolicyScope,
          filterPolicyScope,
          ...(attributes.FilterPolicy ? { filterPolicyRaw: attributes.FilterPolicy } : {}),
          ...(Object.keys(parsedMessageAttributes).length > 0 ? { messageAttributes: parsedMessageAttributes } : {}),
          RedrivePolicy: attributes.RedrivePolicy,
          DeliveryPolicy: attributes.DeliveryPolicy
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        evidence.push(`Failed to read SNS subscription attributes for ${subscriptionArn}: ${detail}`);
        errors.push({ subscriptionArn, error: detail });
        subscriptions.push({
          subscriptionArn,
          protocol: summary.protocol,
          endpoint: summary.endpoint,
          variant: classifyDeliveryVariant(summary.protocol, undefined)
        });
      }
    }

    return { subscriptions, evidence, errors };
  }
}

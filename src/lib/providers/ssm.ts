import type { SpecFormat } from '../../contracts.js';
import type { SsmSpecClient } from '../aws/ssm-client.js';
import {
  DEFAULT_REMOTE_FETCH_POLICY,
  fetchSpecFromUrl,
  sanitizeUrlEvidence,
  type RemoteFetchPolicy
} from '../fetch/spec-fetcher.js';
import type { ExportOptions, SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

function detectFormat(content: string, key: string): { format: SpecFormat; filename: string } {
  const trimmed = content.trim();
  if (key.endsWith('.graphql') || key.endsWith('.gql') || /\btype\s+Query\b/.test(trimmed)) {
    return { format: 'graphql-sdl', filename: 'schema.graphql' };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.openapi || parsed.swagger) return { format: 'openapi-json', filename: 'index.json' };
    if (parsed.asyncapi) return { format: 'asyncapi-json', filename: 'asyncapi.json' };
    if (parsed.info?.schema?.includes?.('schema.getpostman.com/json/collection')) {
      return { format: 'postman-collection', filename: 'collection.postman_collection.json' };
    }
    if (parsed.$schema || parsed.type === 'object' || parsed.type === 'record') return { format: 'json-schema', filename: 'schema.json' };
  } catch { /* not JSON */ }
  if (trimmed.startsWith('openapi:') || trimmed.startsWith('swagger:')) {
    return { format: 'openapi-yaml', filename: 'index.yaml' };
  }
  if (trimmed.startsWith('asyncapi:')) {
    return { format: 'asyncapi-yaml', filename: 'asyncapi.yaml' };
  }
  if (key.endsWith('.proto') || /^\s*syntax\s*=\s*["']proto[23]["']\s*;/m.test(trimmed)) {
    return { format: 'protobuf', filename: 'schema.proto' };
  }
  return { format: 'openapi-json', filename: 'index.json' };
}

interface ServiceSpec {
  serviceName: string;
  url?: string;
  content?: string;
  format?: string;
}

export interface SsmProviderOptions {
  remoteFetchPolicy?: RemoteFetchPolicy;
  fetchSpecFromUrl?: typeof fetchSpecFromUrl;
}

function groupByService(entries: { serviceName: string; key: string; value: string }[]): ServiceSpec[] {
  const map = new Map<string, ServiceSpec>();
  for (const entry of entries) {
    let spec = map.get(entry.serviceName);
    if (!spec) {
      spec = { serviceName: entry.serviceName };
      map.set(entry.serviceName, spec);
    }
    if (entry.key === 'url' || entry.key === 'spec-url') {
      spec.url = entry.value;
    } else if (entry.key === 'content' || entry.key === 'spec-content') {
      spec.content = entry.value;
    } else if (entry.key === 'format' || entry.key === 'spec-format') {
      spec.format = entry.value;
    }
  }
  return [...map.values()].filter((s) => s.url || s.content);
}

export class SsmProvider implements SpecProvider {
  public readonly type = 'ssm' as const;
  private readonly remoteFetchPolicy: RemoteFetchPolicy;
  private readonly fetchRemoteSpec: typeof fetchSpecFromUrl;

  public constructor(
    private readonly client: SsmSpecClient,
    options: SsmProviderOptions = {}
  ) {
    this.remoteFetchPolicy = options.remoteFetchPolicy ?? DEFAULT_REMOTE_FETCH_POLICY;
    this.fetchRemoteSpec = options.fetchSpecFromUrl ?? fetchSpecFromUrl;
  }

  public async probe(): Promise<boolean> {
    return this.client.probe();
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const entries = await this.client.listSpecParameters();
    const services = groupByService(entries);
    return services.map((svc) => ({
      id: `ssm/${svc.serviceName}`,
      name: svc.serviceName,
      providerType: 'ssm' as const,
      tags: {},
      evidence: [`Found spec registration in SSM at /postman/specs/${svc.serviceName}/`],
      meta: {
        url: svc.url ? sanitizeUrlEvidence(svc.url) : '',
        hasContent: svc.content ? 'true' : 'false',
        format: svc.format ?? ''
      }
    }));
  }

  public async exportSpec(candidate: SpecCandidate, _options?: ExportOptions): Promise<SpecExportResult> {
    void _options;
    const entries = await this.client.listSpecParameters();
    const services = groupByService(entries);
    const svc = services.find((s) => s.serviceName === candidate.name);

    if (svc?.content) {
      const { format, filename } = detectFormat(svc.content, candidate.name);
      return {
        content: svc.content,
        format,
        filename,
        evidence: [`Spec content loaded from SSM /postman/specs/${candidate.name}/content`]
      };
    }

    if (svc?.url) {
      const safeUrl = sanitizeUrlEvidence(svc.url);
      try {
        const fetched = await this.fetchRemoteSpec(svc.url, {
          timeoutMs: 15000,
          policy: this.remoteFetchPolicy
        });
        const { format, filename } = detectFormat(fetched.content, svc.url);
        return {
          content: fetched.content,
          format,
          filename,
          evidence: [`Spec fetched from URL registered in SSM: ${safeUrl}`]
        };
      } catch (fetchError) {
        const detail = fetchError instanceof Error ? fetchError.message : String(fetchError);
        const pointerContent = JSON.stringify({
          specUrl: safeUrl,
          serviceName: candidate.name,
          registeredVia: 'ssm-parameter-store',
          fetchError: detail
        }, null, 2);
        return {
          content: pointerContent,
          format: 'openapi-json',
          filename: 'spec-pointer.json',
          evidence: [`Spec URL registered in SSM: ${safeUrl} (fetch failed: ${detail})`]
        };
      }
    }

    throw new Error(`No spec content or URL found in SSM for service ${candidate.name}`);
  }
}

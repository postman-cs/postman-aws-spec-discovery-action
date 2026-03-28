import type { SpecFormat } from '../../contracts.js';
import type { SsmSpecClient } from '../aws/ssm-client.js';
import { fetchSpecFromUrl } from '../fetch/spec-fetcher.js';
import type { ExportOptions, SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

function detectFormat(content: string, key: string): { format: SpecFormat; filename: string } {
  const trimmed = content.trim();
  if (key.endsWith('.graphql') || key.endsWith('.gql') || /\btype\s+Query\b/.test(trimmed)) {
    return { format: 'graphql-sdl', filename: 'schema.graphql' };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.openapi || parsed.swagger) return { format: 'openapi-json', filename: 'index.json' };
    if (parsed.$schema || parsed.type === 'object' || parsed.type === 'record') return { format: 'json-schema', filename: 'schema.json' };
  } catch { /* not JSON */ }
  if (trimmed.startsWith('openapi:') || trimmed.startsWith('swagger:')) {
    return { format: 'openapi-yaml', filename: 'index.yaml' };
  }
  return { format: 'openapi-json', filename: 'index.json' };
}

interface ServiceSpec {
  serviceName: string;
  url?: string;
  content?: string;
  format?: string;
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

  public constructor(private readonly client: SsmSpecClient) {}

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
        url: svc.url ?? '',
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
      // Attempt to fetch actual spec content from the registered URL
      try {
        const fetched = await fetchSpecFromUrl(svc.url, { timeoutMs: 15000 });
        const { format, filename } = detectFormat(fetched.content, svc.url);
        return {
          content: fetched.content,
          format,
          filename,
          evidence: [`Spec fetched from URL registered in SSM: ${svc.url}`]
        };
      } catch (fetchError) {
        // Fall back to pointer file if fetch fails (e.g. non-HTTPS, network error)
        const detail = fetchError instanceof Error ? fetchError.message : String(fetchError);
        const pointerContent = JSON.stringify({
          specUrl: svc.url,
          serviceName: candidate.name,
          registeredVia: 'ssm-parameter-store',
          fetchError: detail
        }, null, 2);
        return {
          content: pointerContent,
          format: 'openapi-json',
          filename: 'spec-pointer.json',
          evidence: [`Spec URL registered in SSM: ${svc.url} (fetch failed: ${detail})`]
        };
      }
    }

    throw new Error(`No spec content or URL found in SSM for service ${candidate.name}`);
  }
}

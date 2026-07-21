import type { SpecFormat } from '../../contracts.js';
import type { SsmSpecClient } from '../aws/ssm-client.js';
import {
  DEFAULT_REMOTE_FETCH_POLICY,
  fetchSpecFromUrl,
  sanitizeUrlEvidence,
  type RemoteFetchPolicy
} from '../fetch/spec-fetcher.js';
import {
  classifySpecContent,
  classifyWithDeclaredFormat,
  filenameForFormat,
  type ClassifiedSpecFormat
} from '../spec/classify-format.js';
import type { ExportOptions, SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

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

function resolveClassifiedFormat(
  content: string,
  declaredFormat: string | undefined,
  pathHint: string
): ClassifiedSpecFormat {
  const classified = declaredFormat?.trim()
    ? classifyWithDeclaredFormat(content, declaredFormat, { pathHint })
    : classifySpecContent(content, { pathHint });
  if (!classified) {
    if (declaredFormat?.trim()) {
      throw new Error(
        `SSM spec content does not match declared format "${declaredFormat.trim()}" (or could not be classified)`
      );
    }
    throw new Error('SSM spec content could not be classified as a supported specification format');
  }
  return {
    format: classified.format,
    filename: filenameForFormat(classified.format, pathHint) || classified.filename
  };
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
      const { format, filename } = resolveClassifiedFormat(
        svc.content,
        svc.format ?? candidate.meta.format,
        candidate.name
      );
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
        const { format, filename } = resolveClassifiedFormat(
          fetched.content,
          svc.format ?? candidate.meta.format,
          svc.url
        );
        return {
          content: fetched.content,
          format,
          filename,
          evidence: [`Spec fetched from URL registered in SSM: ${safeUrl}`]
        };
      } catch (fetchError) {
        const detail = fetchError instanceof Error ? fetchError.message : String(fetchError);
        // Fail closed: never materialize a fetch-failure pointer as a resolved OpenAPI artifact.
        // Safe URL evidence is retained in the thrown error for provider failure semantics.
        throw new Error(`SSM remote spec fetch failed for ${safeUrl}: ${detail}`, { cause: fetchError });
      }
    }

    throw new Error(`No spec content or URL found in SSM for service ${candidate.name}`);
  }
}

/** @internal test helper */
export function classifySsmContentForTest(
  content: string,
  declaredFormat?: string,
  pathHint = 'spec'
): { format: SpecFormat; filename: string } {
  return resolveClassifiedFormat(content, declaredFormat, pathHint);
}

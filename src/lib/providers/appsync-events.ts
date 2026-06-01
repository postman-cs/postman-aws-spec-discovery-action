import type {
  AppSyncChannelNamespaceSummary,
  AppSyncEventsSpecClient
} from '../aws/appsync-events-client.js';
import type { ExportOptions, SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

export class AppSyncEventsProvider implements SpecProvider {
  public readonly type = 'appsync-events' as const;

  public constructor(private readonly client: AppSyncEventsSpecClient) {}

  public async probe(): Promise<boolean> {
    return this.client.probe();
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const candidates: SpecCandidate[] = [];
    for (const api of await this.client.listEventApis()) {
      const namespaces = await this.client.listChannelNamespaces(api.apiId);
      candidates.push({
        id: api.apiId,
        name: api.name,
        providerType: 'appsync-events',
        tags: api.tags ?? {},
        evidence: [`AppSync Event API discovered: ${api.name}`],
        meta: {
          apiId: api.apiId,
          apiArn: api.apiArn ?? '',
          dnsJson: JSON.stringify(api.dns ?? {}),
          namespacesJson: JSON.stringify(namespaces)
        }
      });
    }
    return candidates;
  }

  public async exportSpec(candidate: SpecCandidate, _options?: ExportOptions): Promise<SpecExportResult> {
    void _options;
    const namespaces = parseNamespaces(candidate.meta.namespacesJson);
    const document = {
      openapi: '3.1.0',
      info: {
        title: candidate.name,
        version: '1.0.0',
        description: 'Partial AppSync Events surface derived from Event API channel namespaces.'
      },
      paths: {},
      webhooks: Object.fromEntries(
        namespaces.flatMap((namespace) => [
          [`${namespace.name}.publish`, namespaceOperation('publish', namespace)],
          [`${namespace.name}.subscribe`, namespaceOperation('subscribe', namespace)]
        ])
      ),
      'x-aws-appsync-events': {
        apiId: candidate.meta.apiId,
        apiArn: candidate.meta.apiArn || undefined,
        dns: parseJson(candidate.meta.dnsJson)
      }
    };
    return {
      content: `${JSON.stringify(document, null, 2)}\n`,
      format: 'openapi-json',
      filename: 'index.json',
      derivedOpenApiCompleteness: 'partial',
      evidence: [`Synthesized partial OpenAPI webhooks for AppSync Event API ${candidate.name}`]
    };
  }
}

function namespaceOperation(direction: 'publish' | 'subscribe', namespace: AppSyncChannelNamespaceSummary): Record<string, unknown> {
  const authModes = direction === 'publish' ? namespace.publishAuthModes : namespace.subscribeAuthModes;
  return {
    post: {
      operationId: `${direction}${pascal(namespace.name)}AppSyncEvent`,
      summary: `${direction === 'publish' ? 'Publish to' : 'Subscribe to'} AppSync Events channel namespace ${namespace.name}`,
      'x-aws-appsync-channel-namespace': {
        apiId: namespace.apiId,
        name: namespace.name,
        arn: namespace.channelNamespaceArn,
        authModes,
        direction
      },
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: { type: 'object', additionalProperties: true }
          }
        }
      },
      responses: { '202': { description: 'AppSync Events request accepted' } }
    }
  };
}

function parseNamespaces(raw: string | undefined): AppSyncChannelNamespaceSummary[] {
  const parsed = parseJson(raw);
  return Array.isArray(parsed) ? parsed as AppSyncChannelNamespaceSummary[] : [];
}

function parseJson(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function pascal(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+(.)/g, (_match, chr: string) => chr.toUpperCase())
    .replace(/^([a-z])/, (match) => match.toUpperCase());
}

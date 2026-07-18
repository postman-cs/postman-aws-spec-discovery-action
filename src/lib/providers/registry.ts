import type { ProviderProbeResult, ProviderProbeSummary, SpecProvider } from './types.js';
import type { ProviderProbeReason, ProviderType } from '../../contracts.js';

const PROBE_TIMEOUT_MS = 3000;

class ProbeTimeoutError extends Error {
  public constructor() {
    super('Probe timed out');
    this.name = 'ProbeTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProbeTimeoutError()), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

const IAM_ERROR_PATTERN = /AccessDenied|AccessDeniedException|UnauthorizedOperation/i;

function reasonForError(error: unknown): ProviderProbeReason {
  if (error instanceof ProbeTimeoutError) return 'timeout';
  if (error && typeof error === 'object') {
    const maybe = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
    if (maybe.$metadata?.httpStatusCode === 403) return 'iam';
    if (maybe.name && IAM_ERROR_PATTERN.test(maybe.name)) return 'iam';
    if (maybe.message && IAM_ERROR_PATTERN.test(maybe.message)) return 'iam';
  }
  return 'error';
}

export class ProviderRegistry {
  private readonly providers = new Map<ProviderType, SpecProvider>();

  public register(provider: SpecProvider): void {
    this.providers.set(provider.type, provider);
  }

  public get(type: ProviderType): SpecProvider | undefined {
    return this.providers.get(type);
  }

  public all(): SpecProvider[] {
    return [...this.providers.values()];
  }

  /**
   * Probe each registered provider. Never rejects. Returns the available provider
   * instances plus one ordered typed result per registered provider, in registration order.
   */
  public async probeAvailableDetailed(): Promise<ProviderProbeSummary> {
    const registered = [...this.providers.values()];
    const settled = await Promise.allSettled(
      registered.map(async (provider) => withTimeout(provider.probe(), PROBE_TIMEOUT_MS))
    );
    const availableProviders: SpecProvider[] = [];
    const probes: ProviderProbeResult[] = [];
    for (let i = 0; i < registered.length; i += 1) {
      const provider = registered[i];
      const result = settled[i];
      if (result.status === 'fulfilled') {
        if (result.value === true) {
          availableProviders.push(provider);
          probes.push({ provider: provider.type, status: 'available' });
        } else {
          probes.push({ provider: provider.type, status: 'skipped' });
        }
      } else {
        probes.push({ provider: provider.type, status: 'skipped', reason: reasonForError(result.reason) });
      }
    }
    return { availableProviders, probes };
  }

  /** Backward-compatible: probe each registered provider and return only those the caller has access to. */
  public async probeAvailable(): Promise<SpecProvider[]> {
    const { availableProviders } = await this.probeAvailableDetailed();
    return availableProviders;
  }
}

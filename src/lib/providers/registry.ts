import type { ProviderType } from '../../contracts.js';
import type { SpecProvider } from './types.js';

const PROBE_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Probe timed out')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
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

  /** Probe each registered provider and return only those the caller has access to. */
  public async probeAvailable(): Promise<SpecProvider[]> {
    const results = await Promise.allSettled(
      [...this.providers.values()].map(async (provider) => {
        const available = await withTimeout(provider.probe(), PROBE_TIMEOUT_MS);
        return available ? provider : undefined;
      })
    );
    return results
      .filter((r): r is PromiseFulfilledResult<SpecProvider | undefined> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter((p): p is SpecProvider => p !== undefined);
  }
}

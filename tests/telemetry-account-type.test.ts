import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetIdentityMemo,
  resolveTelemetryAccountType
} from '../src/lib/postman/credential-identity.js';

beforeEach(() => __resetIdentityMemo());
afterEach(() => vi.restoreAllMocks());

describe('resolveTelemetryAccountType (aws-spec-discovery telemetry enrichment)', () => {
  it('returns the session consumerType when an access token resolves an iapub session', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe('https://iapub.postman.co/api/sessions/current');
      expect((init?.headers as Record<string, string>)['x-access-token']).toBe('pma_at_service');
      return new Response(
        JSON.stringify({ session: { identity: { team: '10490519' }, consumerType: 'service_account' } }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    });
    await expect(resolveTelemetryAccountType('pma_at_service', fetchImpl)).resolves.toBe('service_account');
  });

  it('returns undefined when no access token is present (account_type stays unknown)', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(resolveTelemetryAccountType('', fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns undefined on a probe failure rather than throwing', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(resolveTelemetryAccountType('pma_at_service', fetchImpl)).resolves.toBeUndefined();
  });
});

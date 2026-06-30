import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetIdentityMemo,
  resolveTelemetryAccountType
} from '../src/lib/postman/credential-identity.js';
import { prepareTelemetryCredentials } from '../src/lib/postman/telemetry-credentials.js';

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

describe('prepareTelemetryCredentials', () => {
  it('mints an access token from postman-api-key when no access token is supplied', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('/service-account-tokens')) {
        return new Response(JSON.stringify({ access_token: 'pma_at_minted' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (String(url).includes('/api/sessions/current')) {
        return new Response(
          JSON.stringify({ session: { identity: { team: '10490519' }, consumerType: 'service' } }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    });

    const onToken = vi.fn();
    const result = await prepareTelemetryCredentials({
      postmanApiKey: 'PMAK-test',
      fetchImpl,
      onToken
    });

    expect(result.provider?.current()).toBe('pma_at_minted');
    expect(result.accountType).toBe('service');
    expect(onToken).toHaveBeenCalledWith('pma_at_minted');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.getpostman.com/service-account-tokens',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('returns empty when neither PMAK nor access token is present', async () => {
    await expect(prepareTelemetryCredentials({})).resolves.toEqual({});
  });

  it('does not throw when mint fails (best-effort telemetry)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('nope', { status: 403 }));
    await expect(
      prepareTelemetryCredentials({
        postmanApiKey: 'PMAK-bad',
        fetchImpl
      })
    ).resolves.toEqual({
      provider: expect.objectContaining({ current: expect.any(Function) })
    });
  });
});

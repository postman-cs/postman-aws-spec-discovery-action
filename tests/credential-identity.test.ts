import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetIdentityMemo,
  getSessionResolutionFailure,
  resolveSessionIdentity,
  resolveTelemetryAccountType
} from '../src/lib/postman/credential-identity.js';

const IAPUB_BASE = 'https://iapub.postman.co';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function sessionPayload(team: unknown = 13347347): Record<string, unknown> {
  return {
    identity: { team, domain: 'field-services-v12-demo' },
    data: { user: { id: 999, fullName: 'Svc Account' } },
    consumerType: 'service_account',
    token: 'session-token-must-never-copy'
  };
}

function sessionSequence(steps: Array<() => Response>) {
  let n = 0;
  return vi.fn<typeof fetch>(async () => {
    const step = steps[Math.min(n, steps.length - 1)];
    n += 1;
    return step();
  });
}

describe('event-based session retry (aws-spec-discovery)', () => {
  beforeEach(() => {
    __resetIdentityMemo();
  });

  it('retries a transient 5xx and resolves later via full-jitter through the injected clock', async () => {
    const sleeps: number[] = [];
    const fetchImpl = sessionSequence([
      () => new Response('server error', { status: 503 }),
      () => jsonResponse(sessionPayload(13347347))
    ]);

    const identity = await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'retry-5xx',
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      randomImpl: () => 0.5
    });

    expect(identity?.consumerType).toBe('service_account');
    expect(sleeps).toEqual([250]);
    expect(getSessionResolutionFailure()).toBeUndefined();
  });

  it('honors Retry-After (seconds) on 429 instead of jitter and clamps a rogue value', async () => {
    const afterSecs: number[] = [];
    const fetchAfter = sessionSequence([
      () => new Response('slow', { status: 429, headers: { 'retry-after': '2' } }),
      () => jsonResponse(sessionPayload(13347347))
    ]);
    await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'retry-after',
      fetchImpl: fetchAfter,
      sleepImpl: async (ms) => {
        afterSecs.push(ms);
      },
      randomImpl: () => 0.99
    });
    expect(afterSecs).toEqual([2000]);

    __resetIdentityMemo();
    const clamped: number[] = [];
    const fetchHuge = sessionSequence([
      () => new Response('slow', { status: 503, headers: { 'retry-after': '9999' } }),
      () => jsonResponse(sessionPayload(13347347))
    ]);
    await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'retry-after-huge',
      fetchImpl: fetchHuge,
      sleepImpl: async (ms) => {
        clamped.push(ms);
      },
      randomImpl: () => 0
    });
    expect(clamped).toEqual([8000]);
  });

  it('does NOT retry or sleep on 401 and classifies auth', async () => {
    const sleeps: number[] = [];
    const fetchImpl = sessionSequence([() => new Response('nope', { status: 401 })]);
    const identity = await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'auth-401',
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      }
    });
    expect(identity).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleeps).toHaveLength(0);
    expect(getSessionResolutionFailure()).toBe('auth');
  });

  it('resolveTelemetryAccountType stays best-effort undefined when iapub keeps failing', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('down', { status: 503 }));
    const accountType = await resolveTelemetryAccountType('tok', fetchImpl);
    expect(accountType).toBeUndefined();
  });
});

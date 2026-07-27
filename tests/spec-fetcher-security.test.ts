import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { agentOptions, proxyOptions, lookupMock, undiciFetchMock } = vi.hoisted(() => ({
  agentOptions: [] as unknown[],
  proxyOptions: [] as unknown[],
  lookupMock: vi.fn(async () => [{ address: '8.8.8.8', family: 4 as const }]),
  // The fetcher deliberately uses undici's fetch, not the global, so its dispatcher and
  // its fetch come from one undici instance. Stub that same export here; the globalThis
  // spy installed in beforeEach delegates to this mock so existing assertions still read
  // the calls the fetcher actually made.
  undiciFetchMock: vi.fn()
}));

vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));
vi.mock('undici', async (importOriginal) => {
  const original = await importOriginal<typeof import('undici')>();
  return {
    ...original,
    Agent: class extends original.Agent {
      constructor(options: ConstructorParameters<typeof original.Agent>[0]) {
        agentOptions.push(options);
        super(options);
      }
    },
    ProxyAgent: class extends original.ProxyAgent {
      constructor(options: ConstructorParameters<typeof original.ProxyAgent>[0]) {
        proxyOptions.push(options);
        super(options);
      }
    },
    fetch: undiciFetchMock
  };
});

import {
  createRemoteFetchPolicy,
  DEFAULT_REMOTE_FETCH_POLICY,
  enableRemoteFetch,
  fetchSpecFromUrl,
  isBlockedAddress,
  sanitizeUrlEvidence
} from '../src/lib/fetch/spec-fetcher.js';

const VALID_BODY = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'x', version: '1' },
  paths: { '/': {} }
});

const ALLOWED = enableRemoteFetch([{ hostname: 'specs.example.com', pathPrefix: '/v1/' }]);

function jsonResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

beforeEach(() => {
  agentOptions.length = 0;
  proxyOptions.length = 0;
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  undiciFetchMock.mockReset();
  // Bind the global to the very mock the fetcher calls, so `vi.spyOn(globalThis, 'fetch')`
  // observes and controls the real request path rather than an unused global.
  vi.stubGlobal('fetch', undiciFetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.HTTP_PROXY;
  delete process.env.http_proxy;
  vi.restoreAllMocks();
});

describe('remote fetch policy defaults', () => {
  it('denies remote fetch by default without network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(fetchSpecFromUrl('https://specs.example.com/v1/openapi.yaml')).rejects.toThrow(
      /disabled by default/
    );
    await expect(
      fetchSpecFromUrl('https://specs.example.com/v1/openapi.yaml', { policy: DEFAULT_REMOTE_FETCH_POLICY })
    ).rejects.toThrow(/disabled by default/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('denies when enabled with an empty allowlist', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      fetchSpecFromUrl('https://specs.example.com/v1/openapi.yaml', {
        policy: createRemoteFetchPolicy({ enabled: true, allowlist: [] })
      })
    ).rejects.toThrow(/empty allowlist/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows an exact host and path-prefix match', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(VALID_BODY));
    const fetched = await fetchSpecFromUrl('https://specs.example.com/v1/openapi.yaml', {
      policy: ALLOWED
    });
    expect(fetched.content).toBe(VALID_BODY);
    expect(fetched.finalUrl).toBe('https://specs.example.com/v1/openapi.yaml');
  });

  it('rejects exact-host mismatches and path-prefix mismatches', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      fetchSpecFromUrl('https://evil.example.com/v1/openapi.yaml', { policy: ALLOWED })
    ).rejects.toThrow(/not allowlisted/);
    await expect(
      fetchSpecFromUrl('https://specs.example.com/other/openapi.yaml', { policy: ALLOWED })
    ).rejects.toThrow(/not allowlisted/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('spec fetcher SSRF and redirect hardening', () => {
  it('rejects malformed and non-HTTPS URLs without fetching', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(fetchSpecFromUrl('not a url', { policy: ALLOWED })).rejects.toThrow(/Malformed URL/);
    await expect(fetchSpecFromUrl('http://specs.example.com/v1/x', { policy: ALLOWED })).rejects.toThrow(
      /Only HTTPS/
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sanitizes credentials and query secrets from evidence and errors', async () => {
    expect(sanitizeUrlEvidence('https://user:pass@specs.example.com/v1/x?token=secret')).toBe( // trufflehog:ignore
      'https://specs.example.com/v1/x'
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 404 }));
    const error = await fetchSpecFromUrl(
      'https://user:s3cret@specs.example.com/v1/openapi.yaml?sig=abc', // trufflehog:ignore
      { policy: ALLOWED }
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/https:\/\/specs\.example\.com\/v1\/openapi\.yaml/);
    expect(message).not.toMatch(/s3cret|sig=abc|user:/);
  });

  it('strips URL credentials before fetch and does not forward them on cross-origin redirect', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(redirectResponse('https://specs.example.com/v1/next.yaml'))
      .mockResolvedValueOnce(jsonResponse(VALID_BODY));

    const policy = enableRemoteFetch([{ hostname: 'specs.example.com', pathPrefix: '/v1/' }]);
    await fetchSpecFromUrl('https://user:pass@specs.example.com/v1/openapi.yaml', { policy });

    expect(fetchSpy.mock.calls.map(([input]) => String(input))).toEqual([
      'https://specs.example.com/v1/openapi.yaml',
      'https://specs.example.com/v1/next.yaml'
    ]);
    expect(String(fetchSpy.mock.calls[0]?.[0])).not.toContain('user');
  });

  it('revalidates HTTPS, allowlist, and addresses on every redirect hop', async () => {
    lookupMock
      .mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }])
      .mockResolvedValueOnce([{ address: '9.9.9.9', family: 4 }]);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(redirectResponse('https://specs.example.com/v1/next.yaml'))
      .mockResolvedValueOnce(jsonResponse(VALID_BODY));

    await fetchSpecFromUrl('https://specs.example.com/v1/openapi.yaml', { policy: ALLOWED });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(lookupMock).toHaveBeenCalledTimes(2);
  });

  it('rejects redirect-to-private and redirect off allowlist', async () => {
    lookupMock
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValueOnce([{ address: '192.168.1.5', family: 4 }]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      redirectResponse('https://specs.example.com/v1/internal.yaml')
    );
    await expect(
      fetchSpecFromUrl('https://specs.example.com/v1/openapi.yaml', { policy: ALLOWED })
    ).rejects.toThrow(/Private or local/);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      redirectResponse('https://evil.example.com/steal.yaml')
    );
    await expect(
      fetchSpecFromUrl('https://specs.example.com/v1/openapi.yaml', { policy: ALLOWED })
    ).rejects.toThrow(/not allowlisted/);
  });

  it('rejects redirect to HTTP', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(redirectResponse('http://specs.example.com/v1/x'));
    await expect(
      fetchSpecFromUrl('https://specs.example.com/v1/openapi.yaml', { policy: ALLOWED })
    ).rejects.toThrow(/Only HTTPS/);
  });

  it('bounds redirects', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    for (let i = 0; i < 6; i += 1) {
      spy.mockResolvedValueOnce(redirectResponse(`https://specs.example.com/v1/hop-${i + 1}`));
    }
    await expect(
      fetchSpecFromUrl('https://specs.example.com/v1/openapi.yaml', { policy: ALLOWED })
    ).rejects.toThrow(/Too many redirects/);
  });

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.0.1',
    '169.254.169.254',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '0.0.0.0',
    '224.0.0.1'
  ])('rejects private/reserved IPv4 %s before fetch', async (address) => {
    expect(isBlockedAddress(address)).toBe(true);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const policy = enableRemoteFetch([{ hostname: address }]);
    await expect(fetchSpecFromUrl(`https://${address}/openapi.yaml`, { policy })).rejects.toThrow(
      /Private or local/
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['::1', 'fc00::1', 'fe80::1', '2001:db8::1', 'ff02::1'])(
    'rejects private/reserved IPv6 %s before fetch',
    async (address) => {
      expect(isBlockedAddress(address)).toBe(true);
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const policy = enableRemoteFetch([{ hostname: address }]);
      await expect(fetchSpecFromUrl(`https://[${address}]/openapi.yaml`, { policy })).rejects.toThrow(
        /Private or local/
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  it('rejects metadata hostnames without fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const host of ['metadata', 'metadata.google.internal', 'localhost', 'svc.internal']) {
      const policy = enableRemoteFetch([{ hostname: host }]);
      await expect(fetchSpecFromUrl(`https://${host}/latest/meta-data`, { policy })).rejects.toThrow(
        /Private or local/
      );
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('defends against DNS rebinding by pinning the resolved address on the dispatcher', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(VALID_BODY));

    await fetchSpecFromUrl('https://specs.example.com/v1/openapi.yaml', { policy: ALLOWED });

    const connect = (
      agentOptions[0] as {
        connect: {
          servername: string;
          lookup: (
            hostname: string,
            options: { all?: boolean },
            callback: (...args: unknown[]) => void
          ) => void;
        };
      }
    ).connect;
    expect(connect.servername).toBe('specs.example.com');
    const single = vi.fn();
    connect.lookup('rebinding.example', { all: false }, single);
    expect(single).toHaveBeenCalledWith(null, '1.1.1.1', 4);
    const all = vi.fn();
    connect.lookup('rebinding.example', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: '1.1.1.1', family: 4 }]);
  });

  it('rejects DNS answers that resolve to private addresses (rebinding simulation)', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      fetchSpecFromUrl('https://specs.example.com/v1/openapi.yaml', { policy: ALLOWED })
    ).rejects.toThrow(/Private or local/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects oversized Content-Length and streamed chunked bodies', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(VALID_BODY, { 'content-length': String(20 * 1024 * 1024) })
    );
    await expect(
      fetchSpecFromUrl('https://specs.example.com/v1/openapi.yaml', { policy: ALLOWED })
    ).rejects.toThrow(/Response too large/);

    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        canceled = true;
      }
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(body, { status: 200 }));
    await expect(
      fetchSpecFromUrl('https://specs.example.com/v1/openapi.yaml', {
        policy: ALLOWED,
        maxBytes: 32
      })
    ).rejects.toThrow(/Response body too large/);
    expect(canceled).toBe(true);
  });

  it('enforces cumulative byte budget across fetches', async () => {
    const budget = { totalBytes: 0 };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse('x'.repeat(40)));
    await fetchSpecFromUrl('https://specs.example.com/v1/a.yaml', {
      policy: ALLOWED,
      budget,
      maxBytes: 100,
      maxTotalBytes: 50
    });
    await expect(
      fetchSpecFromUrl('https://specs.example.com/v1/b.yaml', {
        policy: ALLOWED,
        budget,
        maxBytes: 100,
        maxTotalBytes: 50
      })
    ).rejects.toThrow(/Cumulative response bytes|Response body too large|Response too large/);
  });

  it('times out without external network', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })
    );
    await expect(
      fetchSpecFromUrl('https://specs.example.com/v1/openapi.yaml', {
        policy: ALLOWED,
        timeoutMs: 20
      })
    ).rejects.toThrow(/Timed out/);
  });
});

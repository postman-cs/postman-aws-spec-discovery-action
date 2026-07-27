import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch, Pool, ProxyAgent, type Dispatcher } from 'undici';

import {
  isBlockedAddress,
  isBlockedHostname,
  normalizedHostname
} from './blocked-addresses.js';
import {
  assertUrlAllowedByPolicy,
  createRemoteFetchPolicy,
  DEFAULT_REMOTE_FETCH_POLICY,
  type RemoteFetchPolicy
} from './remote-fetch-policy.js';
import { redactUrlsInMessage, sanitizeUrlEvidence } from './url-evidence.js';

export {
  createRemoteFetchPolicy,
  DEFAULT_REMOTE_FETCH_POLICY,
  isUrlAllowedByPolicy,
  type RemoteFetchAllowlistEntry,
  type RemoteFetchPolicy
} from './remote-fetch-policy.js';
export { sanitizeUrlEvidence, redactUrlsInMessage } from './url-evidence.js';
export { isBlockedAddress, isBlockedHostname } from './blocked-addresses.js';

const MAX_SPEC_BYTES = 10 * 1024 * 1024; // 10 MiB per response
const DEFAULT_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;

export interface FetchByteBudget {
  totalBytes: number;
}

export interface FetchSpecOptions {
  maxBytes?: number;
  maxTotalBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /**
   * Remote fetch policy. Defaults to deny-all.
   * Wave-2 callers (Backstage/SSM) should pass an enabled policy with exact host/path allowlist.
   */
  policy?: RemoteFetchPolicy;
  /** Optional shared cumulative byte budget across multiple fetches. */
  budget?: FetchByteBudget;
  /** Injectable DNS lookup for tests (no external network). */
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export interface FetchedSpec {
  content: string;
  contentType: string;
  /** Sanitized final URL (no credentials or query). */
  finalUrl: string;
}

type Connector = NonNullable<ConstructorParameters<typeof Pool>[1]>['connect'] extends infer T
  ? Extract<T, (...args: never[]) => unknown>
  : never;

interface RequestInitWithDispatcher extends RequestInit {
  dispatcher: Dispatcher;
}

function stripUrlCredentials(url: URL): URL {
  const cleaned = new URL(url.toString());
  cleaned.username = '';
  cleaned.password = '';
  return cleaned;
}

function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port;
}

async function defaultLookup(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
}

async function resolvePublicAddress(
  parsed: URL,
  lookupFn: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>
): Promise<{ address: string; family: 4 | 6; all: Array<{ address: string; family: 4 | 6 }> }> {
  const hostname = normalizedHostname(parsed);
  if (isBlockedHostname(hostname)) {
    throw new Error(
      `Private or local addresses are not allowed for remote spec fetch: ${sanitizeUrlEvidence(parsed)}`
    );
  }

  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
    : await lookupFn(hostname);

  if (addresses.length === 0) {
    throw new Error(`No DNS records for ${hostname}`);
  }

  for (const entry of addresses) {
    if (isBlockedAddress(entry.address)) {
      throw new Error(
        `Private or local addresses are not allowed for remote spec fetch: ${sanitizeUrlEvidence(parsed)}`
      );
    }
  }

  const pinned = addresses.find(({ family }) => family === 4) ?? addresses[0]!;
  return { address: pinned.address, family: pinned.family, all: addresses };
}

function shouldBypassProxy(parsed: URL): boolean {
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? '';
  const hostname = normalizedHostname(parsed);
  const port = parsed.port || '443';
  return noProxy.split(',').some((entry) => {
    const value = entry.trim().toLowerCase();
    if (!value) return false;
    if (value === '*') return true;
    const separator = value.lastIndexOf(':');
    const hasPort = separator > -1 && /^\d+$/.test(value.slice(separator + 1));
    const rulePort = hasPort ? value.slice(separator + 1) : undefined;
    const ruleHost = hasPort ? value.slice(0, separator) : value;
    if (rulePort && rulePort !== port) return false;
    if (ruleHost.startsWith('*.')) return hostname.endsWith(ruleHost.slice(1));
    if (ruleHost.startsWith('.')) return hostname.endsWith(ruleHost);
    return hostname === ruleHost;
  });
}

function createDispatcher(parsed: URL, address: string): Dispatcher {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  const family = isIP(address) as 4 | 6;
  const hostname = normalizedHostname(parsed);

  if (!proxy || shouldBypassProxy(parsed)) {
    return new Agent({
      connect: {
        ...(isIP(hostname) ? {} : { servername: hostname }),
        lookup(_hostname, options, callback) {
          if (options.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        }
      }
    });
  }

  return new ProxyAgent({
    uri: proxy,
    requestTls: isIP(hostname) ? {} : { servername: hostname },
    factory(origin, options) {
      const { connect } = options as { connect: Connector };
      return new Pool(origin, {
        ...options,
        connect(connectOptions, callback) {
          connect({ ...connectOptions, host: address, hostname: address }, callback);
        }
      });
    }
  });
}

function parseHttpsUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Malformed URL for remote spec fetch: ${sanitizeUrlEvidence(input)}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Only HTTPS URLs are supported for remote spec fetch; got ${parsed.protocol} (${sanitizeUrlEvidence(parsed)})`
    );
  }
  return parsed;
}

async function readBodyWithLimit(
  response: Response,
  maxBytes: number
): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const declared = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`Response too large (${declared} bytes); limit is ${maxBytes}`);
    }
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new Error(`Response body too large (over ${maxBytes} bytes); limit is ${maxBytes}`);
      }
      chunks.push(value);
    }
  }

  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

/**
 * Fetch a spec from a remote URL with deny-by-default policy, exact allowlisting,
 * manual redirect revalidation, DNS pinning against rebinding, and streamed size limits.
 *
 * Default policy denies all remote fetches. Enable with:
 * ```ts
 * fetchSpecFromUrl(url, {
 *   policy: createRemoteFetchPolicy({
 *     enabled: true,
 *     allowlist: [{ hostname: 'backstage.example.com', pathPrefix: '/api/catalog/' }]
 *   })
 * })
 * ```
 */
export async function fetchSpecFromUrl(url: string, options: FetchSpecOptions = {}): Promise<FetchedSpec> {
  const maxBytes = options.maxBytes ?? MAX_SPEC_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const policy = options.policy ?? DEFAULT_REMOTE_FETCH_POLICY;
  const budget = options.budget ?? { totalBytes: 0 };
  const lookupFn = options.lookup ?? defaultLookup;
  // The dispatcher below is an undici Agent from this package's undici. Node's global
  // fetch is backed by its own bundled undici, and a dispatcher cannot cross that
  // boundary (undici 8 handlers reject the foreign instance with
  // 'invalid onRequestStart method'). Default to this package's fetch so the
  // dispatcher and the fetch implementation always come from one undici.
  const fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as typeof fetch);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let currentUrl = parseHttpsUrl(url);
    // Never forward embedded credentials; strip before any request.
    currentUrl = stripUrlCredentials(currentUrl);
    let previousOrigin: URL | undefined;
    // Authorization is never set by this fetcher; track for cross-origin stripping if callers inject via subclassing later.
    let authorizationHeader: string | undefined;

    for (let hop = 0; ; hop += 1) {
      assertUrlAllowedByPolicy(currentUrl, policy);

      const hostname = normalizedHostname(currentUrl);
      if (isBlockedHostname(hostname) || (isIP(hostname) && isBlockedAddress(hostname))) {
        throw new Error(
          `Private or local addresses are not allowed for remote spec fetch: ${sanitizeUrlEvidence(currentUrl)}`
        );
      }

      const pinned = await resolvePublicAddress(currentUrl, lookupFn);
      const dispatcher = createDispatcher(currentUrl, pinned.address);

      try {
        const headers: Record<string, string> = {
          Accept: 'application/json, application/yaml, text/yaml, text/plain, */*'
        };
        if (authorizationHeader && previousOrigin && sameOrigin(previousOrigin, currentUrl)) {
          headers.Authorization = authorizationHeader;
        } else {
          authorizationHeader = undefined;
        }

        const init: RequestInitWithDispatcher = {
          signal: controller.signal,
          headers,
          redirect: 'manual',
          dispatcher
        };

        let response: Response;
        try {
          response = await fetchImpl(currentUrl.toString(), init);
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(`Timed out fetching ${sanitizeUrlEvidence(currentUrl)} after ${timeoutMs}ms`, {
              cause: error
            });
          }
          throw new Error(
            redactUrlsInMessage(
              `OpenAPI fetch failed for ${sanitizeUrlEvidence(currentUrl)}: ${
                error instanceof Error ? error.message : String(error)
              }`
            ),
            { cause: error }
          );
        }

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) {
            throw new Error(
              `Redirect response ${response.status} without a Location header for ${sanitizeUrlEvidence(currentUrl)}`
            );
          }
          if (hop >= maxRedirects) {
            throw new Error(
              `Too many redirects (limit ${maxRedirects}) fetching ${sanitizeUrlEvidence(url)}`
            );
          }

          previousOrigin = currentUrl;
          // Do not forward Authorization across origins.
          if (!sameOrigin(currentUrl, new URL(location, currentUrl))) {
            authorizationHeader = undefined;
          }

          const next = stripUrlCredentials(new URL(location, currentUrl));
          if (next.protocol !== 'https:') {
            throw new Error(
              `Only HTTPS URLs are supported for remote spec fetch; got ${next.protocol} (${sanitizeUrlEvidence(next)})`
            );
          }
          currentUrl = next;
          continue;
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} fetching ${sanitizeUrlEvidence(currentUrl)}`);
        }

        const remainingBudget = maxTotalBytes - budget.totalBytes;
        if (remainingBudget <= 0) {
          throw new Error(`Cumulative response bytes exceeded ${maxTotalBytes}`);
        }
        const perResponseLimit = Math.min(maxBytes, remainingBudget);
        const buffer = await readBodyWithLimit(response, perResponseLimit);
        budget.totalBytes += buffer.byteLength;
        if (budget.totalBytes > maxTotalBytes) {
          throw new Error(`Cumulative response bytes exceeded ${maxTotalBytes}`);
        }

        const content = new TextDecoder().decode(buffer);
        const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
        return {
          content,
          contentType,
          finalUrl: sanitizeUrlEvidence(currentUrl)
        };
      } finally {
        await dispatcher.close();
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Convenience: enabled policy with one or more exact allowlist entries. */
export function enableRemoteFetch(
  allowlist: Array<{ hostname: string; pathPrefix?: string }>
): RemoteFetchPolicy {
  return createRemoteFetchPolicy({ enabled: true, allowlist });
}

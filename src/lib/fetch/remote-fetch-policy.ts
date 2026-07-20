import { sanitizeUrlEvidence } from './url-evidence.js';

/**
 * Exact-hostname allowlist entry. Optional pathPrefix is matched as a pathname prefix
 * after normalizing trailing slashes on the prefix only.
 */
export interface RemoteFetchAllowlistEntry {
  /** Exact hostname match (case-insensitive). No wildcards. */
  hostname: string;
  /** Optional pathname prefix, e.g. `/org/repo/`. Empty/omitted allows any path on that host. */
  pathPrefix?: string;
}

/**
 * Policy governing remote HTTPS spec fetches.
 * Default is deny-all; callers (Backstage/SSM) must enable and allowlist explicitly.
 */
export interface RemoteFetchPolicy {
  enabled: boolean;
  allowlist: RemoteFetchAllowlistEntry[];
}

export const DEFAULT_REMOTE_FETCH_POLICY: RemoteFetchPolicy = {
  enabled: false,
  allowlist: []
};

export function createRemoteFetchPolicy(input: {
  enabled?: boolean;
  allowlist?: RemoteFetchAllowlistEntry[];
} = {}): RemoteFetchPolicy {
  const allowlist = (input.allowlist ?? []).map((entry) => ({
    hostname: entry.hostname.trim().toLowerCase(),
    ...(entry.pathPrefix !== undefined ? { pathPrefix: normalizePathPrefix(entry.pathPrefix) } : {})
  }));
  return {
    enabled: input.enabled === true,
    allowlist
  };
}

function normalizePathPrefix(prefix: string): string {
  if (!prefix || prefix === '/') return '/';
  const withLeading = prefix.startsWith('/') ? prefix : `/${prefix}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

function pathnameMatchesPrefix(pathname: string, prefix: string | undefined): boolean {
  if (prefix === undefined || prefix === '') return true;
  const normalizedPrefix = normalizePathPrefix(prefix);
  if (normalizedPrefix === '/') return true;
  const pathWithSlash = pathname.endsWith('/') ? pathname : `${pathname}/`;
  return pathname === normalizedPrefix.slice(0, -1) || pathWithSlash.startsWith(normalizedPrefix);
}

/**
 * Returns true when the URL is permitted by the policy.
 * Disabled policy or empty allowlist always denies.
 */
export function isUrlAllowedByPolicy(url: URL, policy: RemoteFetchPolicy): boolean {
  if (!policy.enabled || policy.allowlist.length === 0) {
    return false;
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[([^\]]+)\]$/, '$1');
  return policy.allowlist.some(
    (entry) => entry.hostname === hostname && pathnameMatchesPrefix(url.pathname, entry.pathPrefix)
  );
}

export function assertUrlAllowedByPolicy(url: URL, policy: RemoteFetchPolicy): void {
  if (!policy.enabled) {
    throw new Error(
      `Remote spec fetch is disabled by default; pass an enabled RemoteFetchPolicy with an allowlist to fetch ${sanitizeUrlEvidence(url)}`
    );
  }
  if (policy.allowlist.length === 0) {
    throw new Error(
      `Remote spec fetch policy has an empty allowlist; refusing ${sanitizeUrlEvidence(url)}`
    );
  }
  if (!isUrlAllowedByPolicy(url, policy)) {
    throw new Error(
      `Remote spec fetch host/path is not allowlisted: ${sanitizeUrlEvidence(url)}`
    );
  }
}

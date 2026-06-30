// Session-identity subset copied from the shared credential-identity foundation
// (postman-repo-sync-action/src/lib/postman/credential-identity.ts). This action
// makes no Postman asset calls; it resolves the access-token -> iapub session
// only so telemetry can emit `account_type` from the resolved `consumerType`
// (D1: an optional postman-access-token input used for telemetry enrichment).

export interface CredentialIdentity {
  source: 'pmak/me' | 'iapub/sessions';
  userId?: string;
  fullName?: string;
  teamId?: string;
  teamName?: string;
  teamDomain?: string;
  roles?: string[];
  consumerType?: string;
}

export interface ResolveSessionIdentityOptions {
  iapubBaseUrl: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}

const sessionPath = '/api/sessions/current';
const DEFAULT_IAPUB_BASE_URL = 'https://iapub.postman.co';

type JsonRecord = Record<string, unknown>;

const sessionMemo = new Map<string, Promise<CredentialIdentity | undefined>>();
let memoizedSessionIdentity: CredentialIdentity | undefined;

/** Test-only: clears the in-process identity memo so cases cannot bleed into each other. */
export function __resetIdentityMemo(): void {
  sessionMemo.clear();
  memoizedSessionIdentity = undefined;
}

/** Last session identity resolved in this process, consumed for telemetry account_type. */
export function getMemoizedSessionIdentity(): CredentialIdentity | undefined {
  return memoizedSessionIdentity;
}

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonRecord;
}

function coerceId(raw: unknown): string | undefined {
  return raw ? String(raw) : undefined;
}

function coerceText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeBaseUrl(raw: string): string {
  return String(raw || '').replace(/\/+$/, '');
}

export async function resolveSessionIdentity(
  opts: ResolveSessionIdentityOptions
): Promise<CredentialIdentity | undefined> {
  const accessToken = String(opts.accessToken || '').trim();
  if (!accessToken) {
    return undefined;
  }
  const baseUrl = normalizeBaseUrl(opts.iapubBaseUrl);
  const memoKey = `${baseUrl}::${accessToken}`;
  let pending = sessionMemo.get(memoKey);
  if (!pending) {
    pending = probeSessionIdentity(baseUrl, accessToken, opts.fetchImpl ?? fetch);
    sessionMemo.set(memoKey, pending);
  }
  return pending;
}

/**
 * Resolve telemetry `account_type` (session consumerType) from an optional
 * access token. Best-effort: any failure yields undefined so telemetry stays
 * `unknown` rather than breaking discovery.
 */
export async function resolveTelemetryAccountType(
  accessToken: string | undefined,
  fetchImpl?: typeof fetch
): Promise<string | undefined> {
  const token = String(accessToken || '').trim();
  if (!token) {
    return undefined;
  }
  const identity = await resolveSessionIdentity({
    iapubBaseUrl: DEFAULT_IAPUB_BASE_URL,
    accessToken: token,
    ...(fetchImpl ? { fetchImpl } : {})
  }).catch(() => undefined);
  return identity?.consumerType;
}

async function probeSessionIdentity(
  baseUrl: string,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<CredentialIdentity | undefined> {
  try {
    const response = await fetchImpl(`${baseUrl}${sessionPath}`, {
      method: 'GET',
      headers: { 'x-access-token': accessToken }
    });
    if (!response.ok) {
      return undefined;
    }
    const payload = asRecord(await response.json());
    if (!payload) {
      return undefined;
    }
    // iapub wraps the live session under `session`; tolerate an unwrapped shape too.
    // Whitelisted extraction only; the raw session body (incl. session.token) is discarded.
    const root = asRecord(payload.session) ?? payload;
    const identity = asRecord(root.identity);
    const data = asRecord(root.data);
    const user = asRecord(data?.user);
    const roleEntries = Array.isArray(user?.roles)
      ? user.roles
          .map((entry) => coerceText(entry) ?? coerceId(entry))
          .filter((entry): entry is string => Boolean(entry))
      : [];
    const singleRole = coerceText(user?.role);
    const roles =
      roleEntries.length > 0 ? roleEntries : singleRole ? [singleRole] : undefined;
    const resolved: CredentialIdentity = {
      source: 'iapub/sessions',
      userId: coerceId(identity?.user) ?? coerceId(user?.id),
      fullName:
        coerceText(user?.fullName) ?? coerceText(user?.name) ?? coerceText(user?.username),
      teamId: coerceId(identity?.team),
      teamName: coerceText(user?.teamName),
      teamDomain: coerceText(identity?.domain),
      ...(roles ? { roles } : {}),
      consumerType:
        coerceText(root.consumerType) ??
        coerceText(data?.consumerType) ??
        coerceText(user?.consumerType)
    };
    memoizedSessionIdentity = resolved;
    return resolved;
  } catch {
    return undefined;
  }
}

export type PmakDiagnosticKind = 'personal' | 'service-account' | 'invalid' | 'inconclusive';

export interface PmakDiagnosticResult {
  kind: PmakDiagnosticKind;
  status?: number;
  payload?: Record<string, unknown>;
}

export interface InspectPmakIdentityOptions {
  apiBaseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  mode?: 'diagnostic' | 'preflight';
}

const memo = new Map<string, Promise<PmakDiagnosticResult>>();

export function __resetPmakDiagnosticMemo(): void {
  memo.clear();
}

function normalizeApiBaseUrl(apiBaseUrl: string): string {
  return new URL(apiBaseUrl.trim()).toString().replace(/\/+$/, '');
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  ]);
}

async function inspect(options: InspectPmakIdentityOptions, normalizedApiBase: string): Promise<PmakDiagnosticResult> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 2000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  try {
    const response = await abortable(
      (options.fetchImpl ?? fetch)(`${normalizedApiBase}/me`, {
        method: 'GET',
        headers: { 'x-api-key': options.apiKey },
        signal
      }),
      signal
    );
    if (response.status === 401 || response.status === 403) {
      return { kind: 'invalid', status: response.status };
    }
    if (!response.ok) {
      return { kind: 'inconclusive', status: response.status };
    }
    const payload = await abortable(response.json(), signal);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { kind: 'inconclusive', status: response.status };
    }
    const user = (payload as Record<string, unknown>).user;
    if (!user || typeof user !== 'object' || Array.isArray(user)) {
      return { kind: 'inconclusive', status: response.status };
    }
    const record = user as Record<string, unknown>;
    const username = record.username;
    const email = record.email;
    if ((typeof username === 'string' && username.trim()) || (typeof email === 'string' && email.trim())) {
      return { kind: 'personal', status: response.status };
    }
    if (
      Object.hasOwn(record, 'username') &&
      Object.hasOwn(record, 'email') &&
      (username === null || username === '') &&
      (email === null || email === '')
    ) {
      return { kind: 'service-account', status: response.status };
    }
    return { kind: 'inconclusive', status: response.status };
  } catch {
    return { kind: 'inconclusive' };
  }
}

export function inspectPmakIdentity(options: InspectPmakIdentityOptions): Promise<PmakDiagnosticResult> {
  const normalizedApiBase = normalizeApiBaseUrl(options.apiBaseUrl);
  const key = `${normalizedApiBase}\u0000${options.apiKey}`;
  let pending = memo.get(key);
  if (!pending) {
    pending = inspect(options, normalizedApiBase);
    memo.set(key, pending);
    if (options.mode === 'preflight') {
      void pending.then((result) => {
        if (result.kind === 'inconclusive') memo.delete(key);
      });
    }
  }
  return pending;
}

export function maskPmakDiagnostic(message: string, secrets: readonly (string | undefined)[]): string {
  let masked = String(message);
  for (const secret of secrets) {
    if (secret) masked = masked.split(secret).join('***');
  }
  return Array.from(masked, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? ' ' : character;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatRejectedMint(originalMintError: string, result: PmakDiagnosticResult): string {
  switch (result.kind) {
    case 'personal':
      return `${originalMintError} Personal API key detected, cannot mint a service-account access token.`;
    case 'service-account':
      return `${originalMintError} postman-api-key authenticates (GET /me OK) but was rejected by POST /service-account-tokens and lacks permission to mint access tokens.`;
    case 'invalid':
      return `${originalMintError} postman-api-key is invalid, disabled, or expired.`;
    default:
      return originalMintError;
  }
}

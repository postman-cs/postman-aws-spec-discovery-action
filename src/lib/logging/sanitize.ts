const ACCOUNT_ID_RE = /\b\d{12}\b/g;
const ARN_RE = /\barn:aws[a-z-]*:[^\s'"]+/gi;
const ACCESS_KEY_RE = /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g;
const SECRET_KEY_RE = /\b(?:(?:aws_)?secret(?:_access)?_key)\b\s*[:=]\s*["']?([A-Za-z0-9/+_=.-]{16,})/gi;
const ABS_PATH_RE = /(?:^|(?<=[\s'"=([{,:]))(?:[A-Za-z]:\\|(?<!https?:)\/)[^\s'"]+/g;

export function isDebugLoggingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.ACTIONS_STEP_DEBUG || '').toLowerCase() === 'true';
}

export function sanitizeLogMessage(message: string): string {
  return message
    .replace(ARN_RE, '[redacted-arn]')
    .replace(ACCOUNT_ID_RE, '[redacted-account-id]')
    .replace(ACCESS_KEY_RE, '[redacted-access-key]')
    .replace(SECRET_KEY_RE, (_full, value: string) => `[redacted-secret-key:${'*'.repeat(Math.min(value.length, 8))}]`)
    .replace(ABS_PATH_RE, '[redacted-path]');
}

/** Recursively sanitize every string leaf of a JSON-safe value. */
export function sanitizeJsonValue<T>(value: T): T {
  if (typeof value === 'string') {
    return sanitizeLogMessage(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeJsonValue(item);
    }
    return out as unknown as T;
  }
  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatUserSafeError(error: unknown, env: NodeJS.ProcessEnv = process.env): string {
  void env;
  return sanitizeLogMessage(errorMessage(error));
}

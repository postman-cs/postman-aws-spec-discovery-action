/**
 * Sanitize a URL for logs, errors, and provenance evidence.
 * Strips credentials, query strings, and fragments so secrets are never surfaced.
 */
export function sanitizeUrlEvidence(input: string | URL): string {
  try {
    const url = typeof input === 'string' ? new URL(input) : new URL(input.toString());
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

/**
 * Redact any http(s) URLs embedded in an error/log message.
 */
export function redactUrlsInMessage(message: string): string {
  return message.replace(/https?:\/\/[^\s'"<>]+/gi, (match) => sanitizeUrlEvidence(match));
}

const MAX_SPEC_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_TIMEOUT_MS = 15000;

export interface FetchSpecOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

export interface FetchedSpec {
  content: string;
  contentType: string;
}

/**
 * Fetch a spec from a remote URL with strict size, timeout, and protocol guards.
 * Only HTTPS URLs are allowed (HTTP is rejected for security).
 */
export async function fetchSpecFromUrl(url: string, options: FetchSpecOptions = {}): Promise<FetchedSpec> {
  const maxBytes = options.maxBytes ?? MAX_SPEC_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error(`Only HTTPS URLs are supported for remote spec fetch; got ${parsed.protocol}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json, application/yaml, text/yaml, text/plain, */*' },
      redirect: 'follow'
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${url}`);
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
      throw new Error(`Response too large (${contentLength} bytes) for ${url}; limit is ${maxBytes}`);
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new Error(`Response body too large (${buffer.byteLength} bytes) for ${url}; limit is ${maxBytes}`);
    }

    const content = new TextDecoder().decode(buffer);
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';

    return { content, contentType };
  } finally {
    clearTimeout(timer);
  }
}

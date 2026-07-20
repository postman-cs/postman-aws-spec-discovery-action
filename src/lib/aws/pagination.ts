/** Finite upper bound for released AWS list/pagination loops outside API Gateway. */
export const MAX_AWS_LIST_PAGES = 100;

export interface AwsPaginationGuard {
  /** Advance the page counter; throws when the finite page cap is exceeded. */
  beginPage(): void;
  /**
   * Accept a continuation token for the next page.
   * Returns undefined when pagination is complete; throws on a repeated non-empty token.
   */
  takeNextToken(token: string | undefined | null): string | undefined;
  /** True when the next beginPage() would exceed maxPages (without advancing). */
  isPageCapReached(): boolean;
}

/**
 * Shared token/page guard for AWS list pagination.
 * Counts the initial page and every subsequent page; throws on page-cap exhaustion
 * or a repeated non-empty continuation token (never returns partial data on cycle/cap).
 */
export function createAwsPaginationGuard(
  operation: string,
  options: { maxPages?: number } = {}
): AwsPaginationGuard {
  const maxPages = options.maxPages ?? MAX_AWS_LIST_PAGES;
  const seenTokens = new Set<string>();
  let pageCount = 0;

  return {
    isPageCapReached(): boolean {
      return pageCount >= maxPages;
    },
    beginPage(): void {
      pageCount += 1;
      if (pageCount > maxPages) {
        throw new Error(`${operation} pagination exceeded ${maxPages} pages; aborting`);
      }
    },
    takeNextToken(token: string | undefined | null): string | undefined {
      const next = token ? String(token) : undefined;
      if (!next) return undefined;
      if (seenTokens.has(next)) {
        throw new Error(`${operation} pagination returned a repeated token; aborting`);
      }
      seenTokens.add(next);
      return next;
    }
  };
}

/** True when an error is a finite pagination abort (page cap or repeated token). */
export function isAwsPaginationAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /pagination exceeded \d+ pages; aborting|pagination returned a repeated token; aborting/.test(
    error.message
  );
}

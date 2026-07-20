/**
 * Validation-local pagination guard mirroring the package API Gateway contract:
 * 100-page cap and repeated-token rejection (never returns partial data on cycle/cap).
 */

/** Finite upper bound for validation harness NextToken/position loops. */
export const MAX_VALIDATION_PAGES = 100;

/**
 * Shared token/page guard for validation-script paginator loops.
 * Counts the initial page and every subsequent page; throws on page-cap exhaustion
 * or a repeated non-empty continuation token.
 *
 * @param {string} operation Label used in abort error messages (e.g. 'GetRoutes').
 * @returns {{ beginPage: () => void, takeNextToken: (token: string | undefined | null) => string | undefined }}
 */
export function createPaginationGuard(operation) {
  const seenTokens = new Set();
  let pageCount = 0;

  return {
    beginPage() {
      pageCount += 1;
      if (pageCount > MAX_VALIDATION_PAGES) {
        throw new Error(
          `${operation} pagination exceeded ${MAX_VALIDATION_PAGES} pages; aborting`
        );
      }
    },
    takeNextToken(token) {
      const next = token ? String(token) : undefined;
      if (!next) return undefined;
      if (seenTokens.has(next)) {
        throw new Error(
          `${operation} pagination returned a repeated token; aborting`
        );
      }
      seenTokens.add(next);
      return next;
    }
  };
}

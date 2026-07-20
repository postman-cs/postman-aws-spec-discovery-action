import { describe, expect, it } from 'vitest';

import { formatUserSafeError, sanitizeLogMessage } from '../src/lib/logging/sanitize.js';

const ACCOUNT_ID = '123456789012';
const ARN = `arn:aws:iam::${ACCOUNT_ID}:role/DiscoveryRole`;
const ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const SECRET_VALUE = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const ABS_PATH = '/home/runner/.aws/credentials';
const WIN_ABS_PATH = 'C:\\Users\\runner\\.aws\\credentials';
const HTTPS_URL = 'https://example.com/openapi.yaml';
const HTTP_URL = 'http://example.com/openapi.yaml';
const CAUSE = 'AccessDenied while calling GetRestApi';

function sensitiveError(): Error {
  return new Error(
    `${CAUSE}: account ${ACCOUNT_ID} arn ${ARN} key ${ACCESS_KEY} aws_secret_access_key=${SECRET_VALUE} path ${ABS_PATH}`
  );
}

function assertRedacted(formatted: string): void {
  expect(formatted).toContain(CAUSE);
  expect(formatted).not.toContain(ACCOUNT_ID);
  expect(formatted).not.toContain(ARN);
  expect(formatted).not.toContain(ACCESS_KEY);
  expect(formatted).not.toContain(SECRET_VALUE);
  expect(formatted).not.toContain(ABS_PATH);
  expect(formatted).toContain('[redacted-account-id]');
  expect(formatted).toContain('[redacted-arn]');
  expect(formatted).toContain('[redacted-access-key]');
  expect(formatted).toContain('[redacted-secret-key:');
  expect(formatted).toContain('[redacted-path]');
}

describe('formatUserSafeError', () => {
  it('redacts known sensitive values when ACTIONS_STEP_DEBUG is false', () => {
    assertRedacted(formatUserSafeError(sensitiveError(), { ACTIONS_STEP_DEBUG: 'false' }));
  });

  it('redacts known sensitive values when ACTIONS_STEP_DEBUG is true', () => {
    assertRedacted(formatUserSafeError(sensitiveError(), { ACTIONS_STEP_DEBUG: 'true' }));
  });

  it('stringifies and sanitizes non-Error input', () => {
    const formatted = formatUserSafeError(`boom ${ACCESS_KEY}`, { ACTIONS_STEP_DEBUG: 'true' });
    expect(formatted).toContain('boom');
    expect(formatted).not.toContain(ACCESS_KEY);
    expect(formatted).toContain('[redacted-access-key]');
  });
});

describe('sanitizeLogMessage URL and path handling', () => {
  it('preserves http(s) entity URLs while redacting absolute filesystem paths', () => {
    const formatted = sanitizeLogMessage(
      `fetch ${HTTPS_URL} also ${HTTP_URL} unix ${ABS_PATH} windows ${WIN_ABS_PATH}`
    );

    expect(formatted).toContain(HTTPS_URL);
    expect(formatted).toContain(HTTP_URL);
    expect(formatted).not.toContain(ABS_PATH);
    expect(formatted).not.toContain(WIN_ABS_PATH);
    expect(formatted).toContain('[redacted-path]');
    expect(formatted).not.toMatch(/https:\[redacted-path\]/);
    expect(formatted).not.toMatch(/http:\[redacted-path\]/);
  });
});

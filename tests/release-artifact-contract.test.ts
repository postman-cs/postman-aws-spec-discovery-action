import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error JavaScript CLI module exposes its tested pure verifier.
import { acceptedImmutableTags, validateReleaseArtifacts, verifyNpmIntegrity } from '../scripts/verify-release-artifacts.mjs';

const PACKAGE_NAME = '@postman-cs/onboarding-aws-spec-discovery';
const REPOSITORY = 'postman-cs/postman-aws-spec-discovery-action';
const COMMIT_SHA = 'abc123';
const TAG = 'v3.1.3';
const VERSION = '3.1.3';

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

function writeTarball(directory: string, packageJson: { name: string; version: string } = {
  name: PACKAGE_NAME,
  version: VERSION
}): void {
  mkdirSync(join(directory, 'package'));
  writeFileSync(join(directory, 'package', 'package.json'), JSON.stringify(packageJson));
  writeFileSync(join(directory, 'package', 'index.js'), 'export {};');
  execFileSync('tar', ['-czf', join(directory, 'release.tgz'), '-C', directory, 'package']);
  rmSync(join(directory, 'package'), { recursive: true, force: true });
}

function writeValidFixture(overrides: Record<string, unknown> = {}, options: {
  extraFile?: string;
  packageJson?: { name: string; version: string };
} = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'release-artifacts-'));
  writeTarball(directory, options.packageJson);
  if (options.extraFile) writeFileSync(join(directory, options.extraFile), 'extra');
  writeFileSync(join(directory, 'release-manifest.json'), JSON.stringify({
    schema_version: 1,
    repository: REPOSITORY,
    commit_sha: COMMIT_SHA,
    tag: TAG,
    package_name: PACKAGE_NAME,
    package_version: VERSION,
    artifacts: [{ path: 'release.tgz', sha256: sha256(readFileSync(join(directory, 'release.tgz'))) }],
    ...overrides
  }));
  return directory;
}

function validate(directory: string, overrides: Partial<{ repository: string; commitSha: string; tag: string }> = {}) {
  return validateReleaseArtifacts(directory, {
    repository: REPOSITORY,
    commitSha: COMMIT_SHA,
    tag: TAG,
    ...overrides
  });
}

describe('release artifact verifier', () => {
  it('accepts a valid allowlisted fixture bound to repository identity', () => {
    const directory = writeValidFixture();
    try {
      expect(() => validate(directory)).not.toThrow();
      expect(acceptedImmutableTags('3.1.0')).toEqual(['v3.1.0', 'v3.1']);
      expect(acceptedImmutableTags('3.1.3')).toEqual(['v3.1.3']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a wrong repository', () => {
    const directory = writeValidFixture({ repository: 'wrong/repository' });
    try {
      expect(() => validate(directory)).toThrow(/repository/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a wrong SHA', () => {
    const directory = writeValidFixture({ commit_sha: 'deadbeef' });
    try {
      expect(() => validate(directory)).toThrow(/commit_sha/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a wrong tag', () => {
    const directory = writeValidFixture({ tag: 'v9.9.9' });
    try {
      expect(() => validate(directory)).toThrow(/manifest tag does not match release input/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a wrong version', () => {
    const directory = writeValidFixture({ package_version: '9.9.9' });
    try {
      expect(() => validate(directory)).toThrow(/tag .* does not match package version/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a wrong checksum', () => {
    const directory = writeValidFixture({
      artifacts: [{ path: 'release.tgz', sha256: '0'.repeat(64) }]
    });
    try {
      expect(() => validate(directory)).toThrow(/checksum/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a hidden extra', () => {
    const directory = writeValidFixture({}, { extraFile: '.evil' });
    try {
      expect(() => validate(directory)).toThrow(/unexpected release artifact: \.evil/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects an arbitrary package name', () => {
    const directory = writeValidFixture(
      { package_name: '@evil/arbitrary-package' },
      { packageJson: { name: '@evil/arbitrary-package', version: VERSION } }
    );
    try {
      expect(() => validate(directory)).toThrow(/package_name must be @postman-cs\/onboarding-aws-spec-discovery/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('accepts a valid npm integrity', () => {
    const directory = writeValidFixture();
    try {
      const tarball = join(directory, 'release.tgz');
      const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
      expect(verifyNpmIntegrity(tarball, integrity)).toBe(integrity);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a mismatched npm integrity', () => {
    const directory = writeValidFixture();
    try {
      expect(() => verifyNpmIntegrity(join(directory, 'release.tgz'), 'sha512-not-the-staged-tarball')).toThrow(/integrity/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

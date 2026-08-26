import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EXPECTED_PACKAGE_NAME = '@postman-cs/onboarding-aws-spec-discovery';
const ALLOWED_ARTIFACT_PATHS = ['release.tgz', 'release-manifest.json'];
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
const TAR_TIMEOUT_MS = 10_000;

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

export function acceptedImmutableTags(version) {
  const [major, minor, patch] = version.split('.');
  return [`v${version}`, ...(patch === '0' ? [`v${major}.${minor}`] : [])];
}

export function verifyNpmIntegrity(tarballPath, publishedIntegrity) {
  const localIntegrity = `sha512-${createHash('sha512').update(readFileSync(tarballPath)).digest('base64')}`;
  if (publishedIntegrity !== localIntegrity) throw new Error('published npm integrity differs from staged tarball');
  return localIntegrity;
}

function assertRegularFile(path, label) {
  if (!existsSync(path)) throw new Error(`missing release artifact: ${label}`);
  const stats = statSync(path);
  if (!stats.isFile()) throw new Error(`release artifact must be a regular file: ${label}`);
  return stats;
}

export function validateReleaseArtifacts(directory, { repository, commitSha, tag }) {
  const entries = readdirSync(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  for (const name of names) {
    if (!ALLOWED_ARTIFACT_PATHS.includes(name)) throw new Error(`unexpected release artifact: ${name}`);
  }
  for (const expected of ALLOWED_ARTIFACT_PATHS) {
    if (!names.includes(expected)) throw new Error(`missing release artifact: ${expected}`);
  }
  for (const entry of entries) {
    if (!entry.isFile()) throw new Error(`release artifact must be a regular file: ${entry.name}`);
  }

  const manifestPath = join(directory, 'release-manifest.json');
  const tarballPath = join(directory, 'release.tgz');
  const manifestStats = assertRegularFile(manifestPath, 'release-manifest.json');
  const tarballStats = assertRegularFile(tarballPath, 'release.tgz');
  if (manifestStats.size > MAX_MANIFEST_BYTES) throw new Error('release-manifest.json exceeds size bound');
  if (tarballStats.size > MAX_TARBALL_BYTES) throw new Error('release.tgz exceeds size bound');

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.schema_version !== 1) throw new Error('manifest schema_version must be 1');
  for (const [field, expected] of Object.entries({ repository, commit_sha: commitSha, tag })) {
    if (manifest[field] !== expected) throw new Error(`manifest ${field} does not match release input`);
  }
  if (manifest.package_name !== EXPECTED_PACKAGE_NAME) {
    throw new Error(`manifest package_name must be ${EXPECTED_PACKAGE_NAME}`);
  }
  if (!acceptedImmutableTags(manifest.package_version).includes(tag)) {
    throw new Error(`tag ${tag} does not match package version ${manifest.package_version}`);
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 1) {
    throw new Error('manifest artifacts must contain exactly release.tgz');
  }
  for (const artifact of manifest.artifacts) {
    if (artifact.path !== 'release.tgz' || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) {
      throw new Error('manifest artifact is invalid');
    }
    if (sha256(join(directory, artifact.path)) !== artifact.sha256) {
      throw new Error(`checksum mismatch for ${artifact.path}`);
    }
  }

  const packageJsonText = execFileSync('tar', ['-xOf', tarballPath, 'package/package.json'], {
    encoding: 'utf8',
    timeout: TAR_TIMEOUT_MS,
    maxBuffer: MAX_PACKAGE_JSON_BYTES
  });
  const packageJson = JSON.parse(packageJsonText);
  if (packageJson.name !== EXPECTED_PACKAGE_NAME) throw new Error('tarball package name does not match repository package');
  if (packageJson.name !== manifest.package_name) throw new Error('tarball package name does not match manifest');
  if (packageJson.version !== manifest.package_version) throw new Error('tarball package version does not match manifest');
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    validateReleaseArtifacts(process.argv[2] ?? '.', {
      repository: process.env.GITHUB_REPOSITORY,
      commitSha: process.env.GITHUB_SHA,
      tag: process.env.GITHUB_REF_NAME
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

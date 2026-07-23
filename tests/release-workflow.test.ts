import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error JavaScript CLI module exposes its tested pure classifier.
import { classifyRelease } from '../scripts/classify-release.mjs';

const CHILD_TIMEOUT_MS = 10_000;
const ALIAS_TEST_TIMEOUT_MS = 30_000;
const workflowPath = join(process.cwd(), '.github/workflows/release.yml');
const workflow = readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n');
const policy = readFileSync(join(process.cwd(), 'RELEASE_POLICY.md'), 'utf8');
const parsed = parse(workflow) as {
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, Record<string, unknown>>;
};

const PACKAGE_NAME = '@postman-cse/onboarding-aws-spec-discovery';
const REPOSITORY = 'postman-cs/postman-aws-spec-discovery-action';
const COMMIT_SHA = 'abc123';
const TAG = 'v3.1.3';
const VERSION = '3.1.3';

function isValidGitExecutable(candidate: string): boolean {
  try {
    const version = execFileSync(candidate, ['--version'], {
      encoding: 'utf8',
      timeout: CHILD_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return /^git version /i.test(version);
  } catch {
    return false;
  }
}

function windowsGitCandidates(): string[] {
  const candidates: string[] = [];
  for (const root of [
    process.env.ProgramFiles,
    process.env.PROGRAMFILES,
    process.env['ProgramFiles(x86)'],
    process.env['PROGRAMFILES(X86)'],
    process.env.LocalAppData,
    process.env.LOCALAPPDATA
  ]) {
    if (!root) continue;
    candidates.push(join(root, 'Git', 'cmd', 'git.exe'));
    candidates.push(join(root, 'Git', 'bin', 'git.exe'));
  }
  try {
    const located = execFileSync('where.exe', ['git'], {
      encoding: 'utf8',
      timeout: CHILD_TIMEOUT_MS,
      maxBuffer: 1024 * 1024
    });
    for (const line of located.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) candidates.push(trimmed);
    }
  } catch {
    // where.exe returns non-zero when git is not on PATH.
  }
  return candidates;
}

function discoverRealGit(platform = process.platform): string {
  const candidates =
    platform === 'win32' ? windowsGitCandidates() : ['/opt/homebrew/bin/git', '/usr/bin/git'];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!existsSync(candidate)) continue;
    if (isValidGitExecutable(candidate)) return candidate;
  }
  throw new Error('unable to locate a real git binary for temporary alias fixtures');
}

function fixturePathWithBin(binDir: string, pathValue = process.env.PATH ?? ''): string {
  return [binDir, pathValue].filter((part) => part.length > 0).join(delimiter);
}

function windowsGitCmdShim(realGit: string): string {
  const quoted = `"${realGit.replace(/"/g, '""')}"`;
  return `@echo off\r\n${quoted} %*\r\n`;
}

function windowsGitBashShim(realGit: string): string {
  const escaped = realGit.replace(/'/g, `'\\''`);
  return `#!/usr/bin/env bash\nexec '${escaped}' "$@"\n`;
}

function installFixtureGitShim(binDir: string, realGit: string, platform = process.platform): void {
  if (platform === 'win32') {
    writeFileSync(join(binDir, 'git.cmd'), windowsGitCmdShim(realGit), { encoding: 'utf8' });
    // Exact alias body runs under bash; provide an extensionless forwarder bash can exec.
    writeFileSync(join(binDir, 'git'), windowsGitBashShim(realGit), {
      encoding: 'utf8',
      mode: 0o755
    });
    return;
  }
  symlinkSync(realGit, join(binDir, 'git'));
}

const REAL_GIT = discoverRealGit();

const temporaryDirectories: string[] = [];

function job(name: string): string {
  const match = workflow.match(new RegExp(`  ${name}:\\n[\\s\\S]*?(?=\\n  [a-zA-Z0-9_-]+:|$)`));
  return match?.[0] ?? '';
}

function assertOrder(earlier: string, later: string, haystack = workflow): void {
  expect(haystack.indexOf(earlier)).toBeGreaterThanOrEqual(0);
  expect(haystack.indexOf(later)).toBeGreaterThanOrEqual(0);
  expect(haystack.indexOf(earlier)).toBeLessThan(haystack.indexOf(later));
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function extractInlineVerifierBody(): string {
  const match = workflow.match(
    /name: Verify release artifacts\n\s+run: \|\n\s+node --input-type=module <<'NODE'\n([\s\S]*?)\n(\s+)NODE\n/
  );
  expect(match?.[1]).toBeTruthy();
  const indent = match?.[2] ?? '';
  return (match?.[1] ?? '')
    .split('\n')
    .map((line) => (indent && line.startsWith(indent) ? line.slice(indent.length) : line))
    .join('\n');
}

function extractAliasShellBody(): string {
  const match = workflow.match(
    /name: Advance rolling major alias monotonically\n\s+run: \|\n([\s\S]*)$/
  );
  expect(match?.[1]).toBeTruthy();
  const lines = (match?.[1] ?? '').replace(/\n+$/, '').split('\n');
  const indentMatch = lines[0]?.match(/^(\s*)/);
  const indent = indentMatch?.[1] ?? '';
  return lines.map((line) => (indent && line.startsWith(indent) ? line.slice(indent.length) : line)).join('\n');
}

function fixtureGitEnv(binDir: string, hooksDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: fixturePathWithBin(binDir),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hooksDir
  };
  // Temporary fixtures must use real git; clear shell-guard injection for non-interactive bash.
  delete env.BASH_ENV;
  delete env.ENV;
  return env;
}

function git(cwd: string, args: readonly string[], binDir: string, hooksDir: string): string {
  return execFileSync(REAL_GIT, args, {
    cwd,
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: fixtureGitEnv(binDir, hooksDir)
  }).trim();
}

function writePackageJson(directory: string, version: string): void {
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ name: PACKAGE_NAME, version }, null, 2)}\n`);
}

function createAliasFixture(options: {
  currentVersion: string;
  candidateVersion: string;
}): {
  root: string;
  work: string;
  remote: string;
  binDir: string;
  hooksDir: string;
  currentSha: string;
  candidateSha: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'alias-shell-'));
  temporaryDirectories.push(root);
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  const binDir = join(root, 'bin');
  const hooksDir = join(root, 'hooks');
  mkdirSync(remote);
  mkdirSync(work);
  mkdirSync(binDir);
  mkdirSync(hooksDir);
  installFixtureGitShim(binDir, REAL_GIT);

  execFileSync(REAL_GIT, ['init', '--bare', '-b', 'main', remote], {
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: fixtureGitEnv(binDir, hooksDir)
  });
  execFileSync(REAL_GIT, ['init', '-b', 'main', work], {
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: fixtureGitEnv(binDir, hooksDir)
  });
  git(work, ['config', 'user.name', 'alias-fixture'], binDir, hooksDir);
  git(work, ['config', 'user.email', 'alias-fixture@example.com'], binDir, hooksDir);
  git(work, ['remote', 'add', 'origin', remote], binDir, hooksDir);

  writePackageJson(work, options.currentVersion);
  writeFileSync(join(work, 'README.md'), 'current\n');
  git(work, ['add', 'package.json', 'README.md'], binDir, hooksDir);
  git(work, ['commit', '-m', 'current alias target'], binDir, hooksDir);
  const currentSha = git(work, ['rev-parse', 'HEAD'], binDir, hooksDir);
  git(work, ['tag', '-a', 'v3', '-m', 'Rolling v3 alias', currentSha], binDir, hooksDir);
  git(work, ['push', 'origin', 'HEAD:main', 'refs/tags/v3'], binDir, hooksDir);

  writePackageJson(work, options.candidateVersion);
  writeFileSync(join(work, 'README.md'), 'candidate\n');
  git(work, ['add', 'package.json', 'README.md'], binDir, hooksDir);
  git(work, ['commit', '-m', 'candidate release'], binDir, hooksDir);
  const candidateSha = git(work, ['rev-parse', 'HEAD'], binDir, hooksDir);
  expect(candidateSha).not.toBe(currentSha);
  git(work, ['push', 'origin', 'HEAD:main'], binDir, hooksDir);

  return { root, work, remote, binDir, hooksDir, currentSha, candidateSha };
}

function runAliasShell(
  cwd: string,
  binDir: string,
  hooksDir: string,
  env: { GITHUB_SHA: string; GITHUB_REF_NAME: string }
): ReturnType<typeof spawnSync> {
  return spawnSync('bash', ['-c', extractAliasShellBody()], {
    cwd,
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: {
      ...fixtureGitEnv(binDir, hooksDir),
      GITHUB_SHA: env.GITHUB_SHA,
      GITHUB_REF_NAME: env.GITHUB_REF_NAME
    }
  });
}

function remoteAliasCommit(remote: string, binDir: string, hooksDir: string): string {
  return execFileSync(REAL_GIT, ['--git-dir', remote, 'rev-parse', 'refs/tags/v3^{}'], {
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: fixtureGitEnv(binDir, hooksDir)
  }).trim();
}

function writeReleaseArtifactsFixture(root: string, options: { extraFile?: string } = {}): string {
  const directory = join(root, 'release-artifacts');
  mkdirSync(directory, { recursive: true });
  const packageDirectory = join(directory, 'package');
  mkdirSync(packageDirectory);
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: VERSION }));
  writeFileSync(join(packageDirectory, 'index.js'), 'export {};\n');
  execFileSync('tar', ['-czf', join(directory, 'release.tgz'), '-C', directory, 'package'], {
    timeout: CHILD_TIMEOUT_MS
  });
  rmSync(packageDirectory, { recursive: true, force: true });
  if (options.extraFile) writeFileSync(join(directory, options.extraFile), 'extra');
  writeFileSync(
    join(directory, 'release-manifest.json'),
    JSON.stringify({
      schema_version: 1,
      repository: REPOSITORY,
      commit_sha: COMMIT_SHA,
      tag: TAG,
      package_name: PACKAGE_NAME,
      package_version: VERSION,
      artifacts: [{ path: 'release.tgz', sha256: sha256(readFileSync(join(directory, 'release.tgz'))) }]
    })
  );
  return directory;
}

function runInlineVerifier(root: string) {
  return spawnSync(process.execPath, ['--input-type=module'], {
    cwd: root,
    encoding: 'utf8',
    input: extractInlineVerifierBody(),
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_SHA: COMMIT_SHA,
      GITHUB_REF_NAME: TAG
    }
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('release workflow contract', () => {
  it('classifies with the exported script before install and keeps zero-patch immutable publish tags with major alias no-op', () => {
    const classify = job('classify');
    expect(classify).toContain('name: Classify release tag');
    expect(classify).toContain('node scripts/classify-release.mjs');
    expect(classify).not.toContain('npm ci');
    assertOrder('node scripts/classify-release.mjs', '- run: npm ci');

    expect(classifyRelease({ ref: 'refs/tags/v3.1.3', refName: 'v3.1.3', packageVersion: '3.1.3' })).toEqual({
      release_kind: 'immutable',
      npm_publish: 'true'
    });
    expect(classifyRelease({ ref: 'refs/tags/v3.1', refName: 'v3.1', packageVersion: '3.1.0' })).toEqual({
      release_kind: 'immutable',
      npm_publish: 'true'
    });
    expect(classifyRelease({ ref: 'refs/tags/v3', refName: 'v3', packageVersion: '3.1.3' })).toEqual({
      release_kind: 'alias',
      npm_publish: 'false'
    });
    expect(() =>
      classifyRelease({ ref: 'refs/heads/main', refName: 'main', packageVersion: '3.1.3' })
    ).toThrow(/got refs\/heads\/main; expected v3\.1\.3, v3\.1 when patch is zero, or v3/);
    expect(() =>
      classifyRelease({ ref: 'refs/tags/v3.1.2', refName: 'v3.1.2', packageVersion: '3.1.3' })
    ).toThrow(/got v3\.1\.2; expected v3\.1\.3, v3\.1 when patch is zero, or v3/);

    expect(policy).toContain('When the package patch is `0`');
    expect(policy).toContain('`vMAJOR.MINOR`');
    expect(policy).toContain('MAJOR.MINOR.0');
    expect(policy).toContain('rolling major alias');
    expect(policy).toContain('versions that match exact immutable GitHub release tags');
    expect(policy).toContain('zero-patch minor immutable tags (`vMAJOR.MINOR`) map to package version `MAJOR.MINOR.0`');
  });

  it('gates every post-classifier job on immutable release_kind only', () => {
    for (const name of ['verify-package', 'publish', 'advance-major-alias'] as const) {
      const body = job(name);
      expect(body).toContain("if: ${{ needs.classify.outputs.release_kind == 'immutable' }}");
      expect(parsed.jobs[name].if).toBe("${{ needs.classify.outputs.release_kind == 'immutable' }}");
    }
    expect(workflow.match(/needs\.classify\.outputs\.release_kind == 'immutable'/g) ?? []).toHaveLength(3);
  });

  it('uses exact permissions, one bundle, and the exact gate set with ACTIONLINT_BIN', () => {
    const verify = job('verify-package');
    expect(verify).toMatch(/permissions:\n {6}contents: read/);
    expect(verify).not.toContain('NPM_TOKEN');
    expect(verify).not.toContain('id-token: write');
    expect(verify).toContain('ACTIONLINT_BIN="$RUNNER_TEMP/actionlint"');
    expect(verify).toContain('"$ACTIONLINT_BIN" -version');
    expect(verify).toContain('echo "ACTIONLINT_BIN=$ACTIONLINT_BIN" >> "$GITHUB_ENV"');
    expect(verify).toContain('download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"');
    expect(verify).toContain('MAX_PARALLEL_GATES=2');
    expect(verify).toContain('run lint npm run lint');
    expect(verify).toContain('run typecheck npm run typecheck');
    expect(verify).toContain('run test npm test');
    expect(verify).toContain('run dist npm run verify:dist:assert');
    expect(verify).toContain('run actionlint "$ACTIONLINT_BIN"');
    assertOrder('- run: npm run bundle', 'name: Run gates', verify);
    expect((verify.match(/npm run bundle/g) ?? []).length).toBe(1);
    expect(workflow).not.toContain('actions/setup-go');
    expect(workflow).not.toContain('go install github.com/rhysd/actionlint');
  });

  it('stages only the allowlisted artifact pair, verifies before upload, and names by run identity', () => {
    const verify = job('verify-package');
    expect(verify).toContain('mkdir release-stage');
    expect(verify).toContain('npm pack --pack-destination release-stage');
    expect(verify).toContain('release-stage/release.tgz');
    expect(verify).toContain('release-stage/release-manifest.json');
    expect(verify).toContain('node scripts/verify-release-artifacts.mjs release-stage');
    expect(verify).toContain('name: release-${{ github.run_id }}-${{ github.run_attempt }}');
    assertOrder('node scripts/verify-release-artifacts.mjs release-stage', 'actions/upload-artifact@v7', verify);
    expect(verify).toContain('release-stage/release.tgz');
    expect(verify).toContain('release-stage/release-manifest.json');
  });

  it('keeps an artifact-only publisher with inline identity checks and no repository source download', () => {
    const publish = job('publish');
    expect(publish).toMatch(/permissions:\n {6}contents: write\n {6}id-token: write/);
    expect(publish).toContain('actions/download-artifact@v8');
    expect(publish).toContain('name: release-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(publish).not.toContain('actions/checkout');
    expect(publish).not.toContain('npm ci');
    expect(publish).not.toContain('cache:');
    expect(publish).not.toMatch(/\bnpm pack\b/);
    expect(publish).not.toContain('npm run bundle');
    expect(publish).not.toMatch(/\bcurl\b/);
    expect(publish).not.toContain('Download immutable artifact verifier');
    expect(publish).not.toContain('raw/$GITHUB_SHA/scripts/verify-release-artifacts.mjs');
    expect(publish).toContain("const expectedPackageName = '@postman-cse/onboarding-aws-spec-discovery'");
    expect(publish).toContain("new Set(['release.tgz', 'release-manifest.json'])");
    expect(publish).toContain("execFileSync('tar', ['-xOf', tarballPath, 'package/package.json']");
    assertOrder('name: Verify release artifacts', 'name: Publish or verify npm package', publish);
    assertOrder('name: Publish or verify npm package', 'name: Publish GitHub release', publish);
  });

  it('executes the exact inline privileged verifier against accept and unexpected-artifact fixtures', () => {
    const root = mkdtempSync(join(tmpdir(), 'inline-verifier-'));
    temporaryDirectories.push(root);
    writeReleaseArtifactsFixture(root);

    const accepted = runInlineVerifier(root);
    expect(accepted.error).toBeUndefined();
    expect(accepted.status).toBe(0);

    writeFileSync(join(root, 'release-artifacts', '.evil'), 'extra');
    const rejected = runInlineVerifier(root);
    expect(rejected.error).toBeUndefined();
    expect(rejected.status).not.toBe(0);
    expect(rejected.status).toBeGreaterThan(0);
    expect(`${rejected.stderr}${rejected.stdout}`).toMatch(/unexpected release artifact: \.evil/);
  });

  it('builds portable fixture PATH and Windows git shims without shell or ln', () => {
    expect(delimiter).toBe(process.platform === 'win32' ? ';' : ':');
    expect(fixturePathWithBin('C:\\fixture\\bin', 'C:\\existing\\bin')).toBe(
      ['C:\\fixture\\bin', 'C:\\existing\\bin'].join(delimiter)
    );
    expect(fixturePathWithBin('/fixture/bin', '/existing/bin')).toBe(
      ['/fixture/bin', '/existing/bin'].join(delimiter)
    );
    expect(fixturePathWithBin('/fixture/bin')).toContain(delimiter);

    expect(windowsGitCmdShim('C:\\Program Files\\Git\\cmd\\git.exe')).toBe(
      '@echo off\r\n"C:\\Program Files\\Git\\cmd\\git.exe" %*\r\n'
    );
    expect(windowsGitCmdShim('C:\\path\\with"quote\\git.exe')).toBe(
      '@echo off\r\n"C:\\path\\with""quote\\git.exe" %*\r\n'
    );
    expect(windowsGitBashShim('C:\\Program Files\\Git\\cmd\\git.exe')).toBe(
      `#!/usr/bin/env bash\nexec 'C:\\Program Files\\Git\\cmd\\git.exe' "$@"\n`
    );
    expect(windowsGitBashShim("C:\\path\\with'quote\\git.exe")).toBe(
      `#!/usr/bin/env bash\nexec 'C:\\path\\with'\\''quote\\git.exe' "$@"\n`
    );

    const root = mkdtempSync(join(tmpdir(), 'alias-shim-'));
    temporaryDirectories.push(root);
    const winBin = join(root, 'win-bin');
    mkdirSync(winBin);
    installFixtureGitShim(winBin, REAL_GIT, 'win32');
    expect(readFileSync(join(winBin, 'git.cmd'), 'utf8')).toBe(windowsGitCmdShim(REAL_GIT));
    expect(readFileSync(join(winBin, 'git'), 'utf8')).toBe(windowsGitBashShim(REAL_GIT));

    if (process.platform !== 'win32') {
      const posixBin = join(root, 'posix-bin');
      mkdirSync(posixBin);
      installFixtureGitShim(posixBin, REAL_GIT, 'linux');
      expect(existsSync(join(posixBin, 'git'))).toBe(true);
      expect(existsSync(join(posixBin, 'git.cmd'))).toBe(false);
    }

    expect(isValidGitExecutable(REAL_GIT)).toBe(true);
    expect(discoverRealGit()).toBe(REAL_GIT);
  });

  it('computes Node SHA-512 SRI, publishes npm before GitHub, then advances the major alias monotonically', () => {
    const publish = job('publish');
    const alias = job('advance-major-alias');
    expect(publish).toContain("createHash('sha512').update(readFileSync('release-artifacts/release.tgz')).digest('base64')");
    expect(publish).not.toContain('openssl dgst');
    expect(publish).not.toContain('| base64');
    expect(publish).toContain('npm view "$PACKAGE_NAME@$PACKAGE_VERSION" dist.integrity');
    expect(publish).toContain('npm publish ./release-artifacts/release.tgz --provenance --access public');
    assertOrder('npm publish ./release-artifacts/release.tgz --provenance --access public', 'softprops/action-gh-release', publish);
    assertOrder('  publish:', '  advance-major-alias:');
    expect(alias).toContain('fetch-depth: 1');
    expect(alias).toContain('git fetch --tags --force');
    expect(alias).toContain('VERSION="$(node -p "require(\'./package.json\').version")"');
    expect(alias).not.toContain('VERSION="${GITHUB_REF_NAME#v}"');
    expect(alias).toContain('CANDIDATE="$GITHUB_SHA"');
    expect(alias).toContain('git show "$MAJOR^{}:package.json"');
    expect(alias).toContain('Not moving $MAJOR backward');
    expect(alias).toContain('sort -V');
    expect(alias).toContain('git push origin "$MAJOR" --force');
    expect(parsed.concurrency).toEqual({
      group: 'release-${{ github.repository }}',
      'cancel-in-progress': false
    });
  });

  it(
    'moves the major alias for a zero-patch same-version candidate when triggered as vMAJOR.MINOR',
    () => {
      const { work, remote, binDir, hooksDir, candidateSha } = createAliasFixture({
        currentVersion: '3.1.0',
        candidateVersion: '3.1.0'
      });
      expect(remoteAliasCommit(remote, binDir, hooksDir)).not.toBe(candidateSha);

      const result = runAliasShell(work, binDir, hooksDir, {
        GITHUB_SHA: candidateSha,
        GITHUB_REF_NAME: 'v3.1'
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(remoteAliasCommit(remote, binDir, hooksDir)).toBe(candidateSha);
    },
    ALIAS_TEST_TIMEOUT_MS
  );

  it(
    'keeps the major alias when the candidate package version is older than the current alias target',
    () => {
      const { work, remote, binDir, hooksDir, currentSha, candidateSha } = createAliasFixture({
        currentVersion: '3.2.0',
        candidateVersion: '3.1.0'
      });
      expect(remoteAliasCommit(remote, binDir, hooksDir)).toBe(currentSha);

      const result = runAliasShell(work, binDir, hooksDir, {
        GITHUB_SHA: candidateSha,
        GITHUB_REF_NAME: 'v3.1'
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        '::notice::Not moving v3 backward from 3.2.0 to 3.1.0'
      );
      expect(remoteAliasCommit(remote, binDir, hooksDir)).toBe(currentSha);
    },
    ALIAS_TEST_TIMEOUT_MS
  );
});

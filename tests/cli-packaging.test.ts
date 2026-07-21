import { execFile, spawnSync } from 'node:child_process';
import { access, constants, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const npmCommand = process.platform === 'win32' ? process.execPath : 'npm';
const npmCliArgs = process.platform === 'win32' ? [process.env.npm_execpath || ''] : [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('CLI packaging contract', () => {
  it('commits a Node shebang and git-index executable mode on dist/cli.cjs', async () => {
    const cliPath = path.join(repoRoot, 'dist', 'cli.cjs');
    const contents = await readFile(cliPath, 'utf8');
    expect(contents.startsWith('#!/usr/bin/env node\n')).toBe(true);

    if (process.platform !== 'win32') {
      const mode = (await stat(cliPath)).mode & 0o777;
      expect(mode & 0o111).not.toBe(0);
      await access(cliPath, constants.X_OK);
    }

    const staged = await execFileAsync('git', ['ls-files', '--stage', 'dist/cli.cjs'], {
      cwd: repoRoot,
      encoding: 'utf8'
    });
    expect(staged.stdout).toMatch(/^100755 /);
  });

  it('keeps an exact dist census of cli/index entrypoints', async () => {
    const distDir = path.join(repoRoot, 'dist');
    const entries = (
      await execFileAsync('git', ['ls-files', '--', 'dist'], {
        cwd: repoRoot,
        encoding: 'utf8'
      })
    ).stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((filePath) => path.basename(filePath))
      .sort();
    expect(entries).toEqual(['cli.cjs', 'index.cjs']);

    const onDisk = await (await import('node:fs/promises')).readdir(distDir);
    expect(onDisk.filter((name) => !name.startsWith('.')).sort()).toEqual(['cli.cjs', 'index.cjs']);
  });

  it('splits bundle/build and keeps the assert-only dist contract read-only', async () => {
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.bundle).toContain('--banner:js="#!/usr/bin/env node"');
    expect(packageJson.scripts.bundle).toContain("process.platform!=='win32'");
    expect(packageJson.scripts.build).toBe('npm run typecheck && npm run bundle');
    expect(packageJson.scripts['verify:dist:assert']).toBe(
      'git diff --ignore-space-at-eol --text --exit-code -- dist && node scripts/verify-dist-artifact.mjs'
    );
    expect(packageJson.scripts['verify:dist']).toBe('npm run build && npm run verify:dist:assert');
  });

  it('does not rebuild dist from any test', async () => {
    const testEntries = await readdir(path.join(repoRoot, 'tests'), { recursive: true });
    const testSources = await Promise.all(
      testEntries
        .filter((entry) => entry.endsWith('.test.ts'))
        .map((entry) => readFile(path.join(repoRoot, 'tests', entry), 'utf8'))
    );
    const allTests = testSources.join('\n');
    const rebuildInvocation = new RegExp(
      String.raw`(?:execFile|spawn)\w*\([\s\S]{0,200}(?:npm[\s'",]+run[\s'",]+(?:build|bundle)|esbuild)`,
      'i'
    );
    expect(allTests).not.toMatch(rebuildInvocation);
    // Build the forbidden cleanup token at runtime so this assertion text cannot self-match.
    const rebuildCleanup = ['rm', '-rf', 'dist'].join(' ');
    expect(allTests.includes(rebuildCleanup)).toBe(false);
  });

  it('bundles once before CI fan-out and runs only the read-only dist assertion in-gate', async () => {
    const workflow = await readFile(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(workflow.match(/npm run bundle/g)).toHaveLength(2);
    expect(workflow).toContain('runs-on: windows-latest');
    expect(workflow).toContain('run dist       npm run verify:dist:assert');
    expect(workflow).toContain('MAX_PARALLEL_GATES=2');
    expect(workflow).toContain('wait -n -p finished_pid');
    expect(workflow).not.toContain('run dist       npm run verify:dist\n');
    expect(workflow.indexOf('- run: npm run bundle')).toBeLessThan(workflow.indexOf('- name: Run gates'));
  });

  it('packs, installs, and runs .bin --help via symlink invocation', async () => {
    const packDir = await makeTempDir('postman-aws-spec-pack-');
    const prefixDir = await makeTempDir('postman-aws-spec-prefix-');

    const packResult = await execFileAsync(
      npmCommand,
      [...npmCliArgs, 'pack', '--json', '--pack-destination', packDir],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          NPM_CONFIG_CACHE: path.join(packDir, '.npm-cache'),
          PATH: process.env.PATH ?? ''
        },
        maxBuffer: 20 * 1024 * 1024
      }
    );
    const [packed] = JSON.parse(packResult.stdout) as Array<{
      filename: string;
      name: string;
    }>;
    expect(packed.name).toBe('@postman-cse/onboarding-aws-spec-discovery');

    const tarballPath = path.join(packDir, packed.filename);
    await mkdir(prefixDir, { recursive: true });
    await execFileAsync(npmCommand, [...npmCliArgs, 'install', '--prefix', prefixDir, tarballPath], {
      encoding: 'utf8',
      env: {
        NPM_CONFIG_CACHE: path.join(packDir, '.npm-cache'),
        PATH: process.env.PATH ?? ''
      },
      maxBuffer: 20 * 1024 * 1024
    });

    const binPath = path.join(
      prefixDir,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'postman-aws-spec-discovery.cmd' : 'postman-aws-spec-discovery'
    );

    if (process.platform !== 'win32') {
      const binStat = await lstat(binPath);
      expect(binStat.isSymbolicLink() || binStat.isFile()).toBe(true);
    }

    const installedCli = path.join(
      prefixDir,
      'node_modules',
      '@postman-cse',
      'onboarding-aws-spec-discovery',
      'dist',
      'cli.cjs'
    );
    const help = await execFileAsync(process.execPath, [installedCli, '--help'], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        INPUT_AWS_REGION: '',
        AWS_REGION: '',
        AWS_DEFAULT_REGION: '',
        INPUT_POSTMAN_API_KEY: '',
        POSTMAN_API_KEY: ''
      },
      maxBuffer: 1024 * 1024
    });

    expect(help.stdout).toMatch(/Usage:\s+postman-aws-spec-discovery/i);
    expect(help.stderr).not.toMatch(/permission denied|exec format|syntax error|unexpected token|"use strict"/i);
    expect(help.stdout).not.toMatch(/"use strict"/);

    const version = await execFileAsync(process.execPath, [installedCli, '--version'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
      maxBuffer: 1024 * 1024
    });
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(version.stdout.trim()).toBe(packageJson.version);

    if (process.platform !== 'win32') {
      const symlinkDir = await makeTempDir('postman-aws-spec-symlink-');
      const symlinkPath = path.join(symlinkDir, 'postman-aws-spec-discovery');
      await symlink(installedCli, symlinkPath);
      const symlinkHelp = spawnSync(symlinkPath, ['--help'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' }
      });
      expect(symlinkHelp.status).toBe(0);
      expect(symlinkHelp.stdout).toMatch(/Usage:\s+postman-aws-spec-discovery/i);
    }
    // npm pack/install exercises the published-package path and can require a cold local npm cache.
  }, 120000);

  it('runs the direct dist/cli.cjs artifact with a shebang path', async () => {
    if (process.platform === 'win32') return;
    const cliPath = path.join(repoRoot, 'dist', 'cli.cjs');
    const help = await execFileAsync(cliPath, ['--help'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
      maxBuffer: 1024 * 1024
    });
    expect(help.stdout).toMatch(/Usage:\s+postman-aws-spec-discovery/i);
  }, 20000);

  it('runs node dist/cli.cjs --help', async () => {
    const cliPath = path.join(repoRoot, 'dist', 'cli.cjs');
    const help = await execFileAsync(process.execPath, [cliPath, '--help'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
      maxBuffer: 1024 * 1024
    });
    expect(help.stdout).toMatch(/Usage:\s+postman-aws-spec-discovery/i);
  }, 20000);

  it('does not auto-run when dist/cli.cjs is imported', async () => {
    const cliPath = path.join(repoRoot, 'dist', 'cli.cjs');
    const imported = await execFileAsync(process.execPath, ['-e', `require(${JSON.stringify(cliPath)})`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
      maxBuffer: 1024 * 1024
    });
    expect(imported.stdout).toBe('');
    expect(imported.stderr).toBe('');
  }, 20000);
});

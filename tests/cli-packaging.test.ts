import { execFile, spawnSync } from 'node:child_process';
import { access, constants, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
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
  it('commits a Node shebang and executable mode on dist/cli.cjs', async () => {
    const cliPath = path.join(repoRoot, 'dist', 'cli.cjs');
    const contents = await readFile(cliPath, 'utf8');
    expect(contents.startsWith('#!/usr/bin/env node\n')).toBe(true);

    const mode = (await stat(cliPath)).mode & 0o777;
    expect(mode & 0o111).not.toBe(0);
    await access(cliPath, constants.X_OK);
  });

  it('packs, installs, and runs .bin --help via symlink invocation', async () => {
    const packDir = await makeTempDir('postman-aws-spec-pack-');
    const prefixDir = await makeTempDir('postman-aws-spec-prefix-');

    const packResult = await execFileAsync(
      'npm',
      ['pack', '--json', '--pack-destination', packDir],
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
    await execFileAsync('npm', ['install', '--prefix', prefixDir, tarballPath], {
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

    const help = await execFileAsync(binPath, ['--help'], {
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

    const version = await execFileAsync(binPath, ['--version'], {
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
      const installedCli = path.join(
        prefixDir,
        'node_modules',
        '@postman-cse',
        'onboarding-aws-spec-discovery',
        'dist',
        'cli.cjs'
      );
      await symlink(installedCli, symlinkPath);
      const symlinkHelp = spawnSync(symlinkPath, ['--help'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' }
      });
      expect(symlinkHelp.status).toBe(0);
      expect(symlinkHelp.stdout).toMatch(/Usage:\s+postman-aws-spec-discovery/i);
    }
  }, 120000);

  it('runs the direct dist/cli.cjs artifact with a shebang path', async () => {
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

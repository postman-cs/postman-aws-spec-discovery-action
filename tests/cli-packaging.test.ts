import { execFile, spawnSync } from 'node:child_process';
import {
  access,
  constants,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const npmCliFallback = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

function resolveNpmCliArgs(platform: NodeJS.Platform, npmExecPath: string | undefined): readonly string[] {
  if (platform !== 'win32') return [];
  return [npmExecPath || npmCliFallback];
}

const npmCommand = process.platform === 'win32' ? process.execPath : 'npm';
const npmCliArgs = resolveNpmCliArgs(process.platform, process.env.npm_execpath);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs: string[] = [];

const EXPECTED_PACKAGE_NAME = '@postman-cse/onboarding-aws-spec-discovery';
const EXPECTED_BIN_NAME = 'postman-aws-spec-discovery';
const EXPECTED_PACK_CENSUS = [
  'action.yml',
  'dist/cli.cjs',
  'dist/index.cjs',
  'README.md',
  'SECURITY.md',
  'SUPPORT.md',
  'RELEASE_POLICY.md'
] as const;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type PackStrategy = 'posix-install' | 'win32-native-shim';

function resolvePackStrategy(platform: NodeJS.Platform = process.platform): PackStrategy {
  return platform === 'win32' ? 'win32-native-shim' : 'posix-install';
}

type PlannedCommand = Readonly<{ file: string; args: readonly string[] }>;

type PackedPackageMeta = {
  name: string;
  version: string;
  binName: string;
  binTarget: string;
};

type Win32NativeShimPlan = {
  strategy: 'win32-native-shim';
  plannedCommands: PlannedCommand[];
  extractRoot: string;
  proxyRoot: string;
  tarballPath: string;
  packageRoot: string;
  installedPackageDir: string;
  cmdShimPath: string;
  cliPath: string;
  meta: PackedPackageMeta;
};

const CMD_UNSAFE_CHARS = /[\r\n"%!^&|<>]/;
const SAFE_PACKAGE_NAME = /^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/;
const SAFE_BIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FIXED_NATIVE_CMD_ARGS = new Set(['--help', '--version']);

function assertPathInsideRoot(candidate: string, root: string, label: string): string {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes root: ${resolvedCandidate} not under ${resolvedRoot}`);
  }
  return resolvedCandidate;
}

function assertNoCmdMetacharacters(value: string, label: string): string {
  if (value.length === 0) {
    throw new Error(`${label} must be non-empty`);
  }
  if (CMD_UNSAFE_CHARS.test(value)) {
    throw new Error(`${label} contains unsafe cmd metacharacters`);
  }
  return value;
}

function assertSafePackageName(name: string): string {
  assertNoCmdMetacharacters(name, 'package name');
  if (!SAFE_PACKAGE_NAME.test(name)) {
    throw new Error(`unsafe package-name syntax: ${name}`);
  }
  return name;
}

function assertSafeBinName(binName: string): string {
  assertNoCmdMetacharacters(binName, 'bin name');
  if (!SAFE_BIN_NAME.test(binName)) {
    throw new Error(`unsafe bin-name syntax: ${binName}`);
  }
  return binName;
}

function assertSafeBinTarget(binTarget: string): string {
  assertNoCmdMetacharacters(binTarget, 'bin target');
  const normalized = binTarget.replace(/\\/g, '/');
  if (
    path.isAbsolute(binTarget) ||
    path.win32.isAbsolute(binTarget) ||
    path.posix.isAbsolute(normalized) ||
    normalized.split('/').includes('..') ||
    normalized.startsWith('~')
  ) {
    throw new Error(`bin target must be a relative path without ..: ${binTarget}`);
  }
  return binTarget;
}

function quoteCmdArg(value: string): string {
  // Reject rather than silently strip quotes or other cmd metacharacters.
  assertNoCmdMetacharacters(value, 'cmd arg');
  return `"${value}"`;
}

function resolveComSpec(): string {
  return process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
}

function planNativeCmdInvocation(cmdShimPath: string, args: readonly string[]): PlannedCommand {
  assertNoCmdMetacharacters(cmdShimPath, 'cmdShimPath');
  for (const arg of args) {
    if (!FIXED_NATIVE_CMD_ARGS.has(arg)) {
      throw new Error(`native cmd arg not allowed: ${arg}`);
    }
    assertNoCmdMetacharacters(arg, 'cmd arg');
  }
  const commandPayload = [quoteCmdArg(cmdShimPath), ...args.map((arg) => quoteCmdArg(arg))].join(' ');
  // Node's Windows shell contract: ComSpec /d /s /c "<command>", with the payload quoted.
  return {
    file: resolveComSpec(),
    args: ['/d', '/s', '/c', `"${commandPayload}"`]
  };
}

function packageDirSegments(packageName: string): string[] {
  assertSafePackageName(packageName);
  return packageName.startsWith('@') ? packageName.split('/') : [packageName];
}

function resolveBinEntry(
  bin: string | Record<string, string> | undefined,
  packageName: string
): { binName: string; binTarget: string } {
  assertSafePackageName(packageName);
  if (typeof bin === 'string') {
    const binName = packageName.includes('/') ? packageName.split('/')[1]! : packageName;
    return {
      binName: assertSafeBinName(binName),
      binTarget: assertSafeBinTarget(bin)
    };
  }
  if (!bin || typeof bin !== 'object') {
    throw new Error('packed package.json is missing a bin entry');
  }
  const entries = Object.entries(bin);
  expect(entries.length).toBeGreaterThan(0);
  const [binName, binTarget] = entries[0]!;
  return {
    binName: assertSafeBinName(binName),
    binTarget: assertSafeBinTarget(binTarget)
  };
}

async function npmPackJson(packDir: string): Promise<{ filename: string; name: string; files: Array<{ path: string }> }> {
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
    files: Array<{ path: string }>;
  }>;
  expect(packed.name).toBe(EXPECTED_PACKAGE_NAME);
  return packed;
}

function assertPackedCensus(files: Array<{ path: string }>): void {
  const filePaths = new Set(files.map((file) => file.path));
  for (const required of EXPECTED_PACK_CENSUS) {
    expect(filePaths.has(required), `npm pack must include ${required}`).toBe(true);
  }
}

async function extractPackedTarball(tarballPath: string, extractRoot: string): Promise<string> {
  await mkdir(extractRoot, { recursive: true });
  await execFileAsync('tar', ['-xzf', tarballPath, '-C', extractRoot], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  return path.join(extractRoot, 'package');
}

async function readPackedMeta(packageRoot: string): Promise<PackedPackageMeta> {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    bin?: string | Record<string, string>;
  };
  const { binName, binTarget } = resolveBinEntry(packageJson.bin, packageJson.name);
  return {
    name: packageJson.name,
    version: packageJson.version,
    binName,
    binTarget
  };
}

function planWin32NativeShim(args: {
  extractRoot: string;
  proxyRoot: string;
  tarballPath: string;
  meta: PackedPackageMeta;
}): Win32NativeShimPlan {
  assertSafePackageName(args.meta.name);
  assertSafeBinName(args.meta.binName);
  assertSafeBinTarget(args.meta.binTarget);
  assertNoCmdMetacharacters(args.extractRoot, 'extractRoot');
  assertNoCmdMetacharacters(args.proxyRoot, 'proxyRoot');
  assertNoCmdMetacharacters(args.tarballPath, 'tarballPath');

  const packageRoot = path.join(args.extractRoot, 'package');
  const installedPackageDir = path.join(args.proxyRoot, 'node_modules', ...packageDirSegments(args.meta.name));
  const binDir = path.join(args.proxyRoot, 'node_modules', '.bin');
  const cmdShimPath = path.join(binDir, `${args.meta.binName}.cmd`);
  const cliPath = path.join(installedPackageDir, args.meta.binTarget);

  assertPathInsideRoot(packageRoot, args.extractRoot, 'packageRoot');
  assertPathInsideRoot(installedPackageDir, args.proxyRoot, 'installedPackageDir');
  assertPathInsideRoot(cmdShimPath, args.proxyRoot, 'cmdShimPath');
  assertPathInsideRoot(cliPath, args.proxyRoot, 'cliPath');
  assertNoCmdMetacharacters(cmdShimPath, 'cmdShimPath');
  assertNoCmdMetacharacters(cliPath, 'cliPath');

  const plannedCommands: PlannedCommand[] = [
    { file: npmCommand, args: [...npmCliArgs, 'pack', '--json', '--pack-destination', path.dirname(args.tarballPath)] },
    { file: 'tar', args: ['-xzf', args.tarballPath, '-C', args.extractRoot] },
    planNativeCmdInvocation(cmdShimPath, ['--help']),
    planNativeCmdInvocation(cmdShimPath, ['--version'])
  ];

  for (const command of plannedCommands) {
    expect(command.file).not.toMatch(/install/i);
    expect(command.args.join(' ')).not.toMatch(/(?:^|\s)install(?:\s|$)/i);
  }

  return {
    strategy: 'win32-native-shim',
    plannedCommands,
    extractRoot: args.extractRoot,
    proxyRoot: args.proxyRoot,
    tarballPath: args.tarballPath,
    packageRoot,
    installedPackageDir,
    cmdShimPath,
    cliPath,
    meta: args.meta
  };
}

async function materializeWin32NativeShim(plan: Win32NativeShimPlan): Promise<void> {
  await mkdir(path.dirname(plan.installedPackageDir), { recursive: true });
  await cp(plan.packageRoot, plan.installedPackageDir, { recursive: true });
  await mkdir(path.dirname(plan.cmdShimPath), { recursive: true });

  const cliPath = assertPathInsideRoot(plan.cliPath, plan.proxyRoot, 'cliPath');
  const body = ['@ECHO off', `${quoteCmdArg(process.execPath)} ${quoteCmdArg(cliPath)} %*`, ''].join('\r\n');
  await writeFile(plan.cmdShimPath, body, 'utf8');
}

async function executeNativeCmd(cmdShimPath: string, args: string[]): Promise<{ stdout: string; stderr: string; status: number | null }> {
  const planned = planNativeCmdInvocation(cmdShimPath, args);
  const result = spawnSync(planned.file, [...planned.args], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
    env: {
      PATH: process.env.PATH ?? '',
      INPUT_AWS_REGION: '',
      AWS_REGION: '',
      AWS_DEFAULT_REGION: '',
      INPUT_POSTMAN_API_KEY: '',
      POSTMAN_API_KEY: ''
    },
    timeout: 20_000,
    maxBuffer: 1024 * 1024
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status
  };
}

async function runPosixInstallPackaging(): Promise<void> {
  const packDir = await makeTempDir('postman-aws-spec-pack-');
  const prefixDir = await makeTempDir('postman-aws-spec-prefix-');

  const packed = await npmPackJson(packDir);
  assertPackedCensus(packed.files);

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

  const binPath = path.join(prefixDir, 'node_modules', '.bin', EXPECTED_BIN_NAME);
  const binStat = await lstat(binPath);
  expect(binStat.isSymbolicLink() || binStat.isFile()).toBe(true);

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

  const symlinkDir = await makeTempDir('postman-aws-spec-symlink-');
  const symlinkPath = path.join(symlinkDir, EXPECTED_BIN_NAME);
  await symlink(installedCli, symlinkPath);
  const symlinkHelp = spawnSync(symlinkPath, ['--help'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' }
  });
  expect(symlinkHelp.status).toBe(0);
  expect(symlinkHelp.stdout).toMatch(/Usage:\s+postman-aws-spec-discovery/i);
}

async function runWin32NativeShimPackaging(options: { executeCmd: boolean }): Promise<Win32NativeShimPlan> {
  const packDir = await makeTempDir('postman-aws-spec-pack-');
  const extractRoot = await makeTempDir('postman-aws-spec-extract-');
  const proxyRoot = await makeTempDir('postman-aws-spec-proxy-');

  const packed = await npmPackJson(packDir);
  assertPackedCensus(packed.files);
  const tarballPath = path.join(packDir, packed.filename);

  const packageRoot = await extractPackedTarball(tarballPath, extractRoot);
  const meta = await readPackedMeta(packageRoot);
  expect(meta.name).toBe(EXPECTED_PACKAGE_NAME);
  expect(meta.binName).toBe(EXPECTED_BIN_NAME);
  expect(meta.binTarget.replace(/\\/g, '/')).toBe('dist/cli.cjs');

  const plan = planWin32NativeShim({ extractRoot, proxyRoot, tarballPath, meta });
  expect(plan.strategy).toBe('win32-native-shim');
  expect(plan.plannedCommands.some((command) => command.args.includes('install'))).toBe(false);

  await materializeWin32NativeShim(plan);
  await access(plan.cliPath, constants.F_OK);

  if (options.executeCmd) {
    const help = await executeNativeCmd(plan.cmdShimPath, ['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/Usage:\s+postman-aws-spec-discovery/i);
    expect(help.stderr).not.toMatch(/permission denied|exec format|syntax error|unexpected token|"use strict"/i);

    const version = await executeNativeCmd(plan.cmdShimPath, ['--version']);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(meta.version);
  }

  return plan;
}

describe('CLI packaging contract', () => {
  it('keeps Windows npm CLI args non-empty under node --run', () => {
    const underNodeRun = resolveNpmCliArgs('win32', undefined);
    expect(underNodeRun).toEqual([npmCliFallback]);
    expect(underNodeRun.every((arg) => arg.length > 0)).toBe(true);
    expect(resolveNpmCliArgs('win32', '/custom/npm-cli.js')).toEqual(['/custom/npm-cli.js']);
    expect(resolveNpmCliArgs('linux', undefined)).toEqual([]);
    expect(npmCliArgs.every((arg) => arg.length > 0)).toBe(true);
  });

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

    const onDisk = await readdir(distDir);
    expect(onDisk.filter((name) => !name.startsWith('.')).sort()).toEqual(['cli.cjs', 'index.cjs']);
  });

  it('splits bundle/build and keeps the assert-only dist contract read-only', async () => {
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.bundle).toContain('--banner:js="#!/usr/bin/env node"');
    expect(packageJson.scripts.bundle).toContain("process.platform!=='win32'");
    expect(packageJson.scripts.build).toBe('npm run typecheck && npm run bundle');
    expect(packageJson.scripts['verify:dist:shape']).toBe('node scripts/verify-dist-artifact.mjs');
    expect(packageJson.scripts['verify:dist:parity']).toBe('git diff --ignore-space-at-eol --text --exit-code -- dist');
    expect(packageJson.scripts['verify:dist:assert']).toBe('npm run verify:dist:shape && npm run verify:dist:parity');
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
    expect(workflow).toContain('run dist-shape npm run verify:dist:shape');
    expect(workflow).toContain('npm run verify:dist:parity');
    expect(workflow).toContain('MAX_PARALLEL_GATES=2');
    expect(workflow).toContain('wait -n -p finished_pid');
    expect(workflow).not.toContain('run dist       npm run verify:dist:assert');
    expect(workflow).not.toContain('run dist       npm run verify:dist\n');
    expect(workflow.indexOf('- run: npm run bundle')).toBeLessThan(workflow.indexOf('- name: Run gates'));
    expect(workflow).toContain('candidate-dist');
    expect(workflow).toContain('expected-dist');
    expect(workflow).toContain('needs: [gate, dist-parity, windows]');
  });

  it('selects posix install off Windows and win32 native shim on Windows', () => {
    expect(resolvePackStrategy('linux')).toBe('posix-install');
    expect(resolvePackStrategy('darwin')).toBe('posix-install');
    expect(resolvePackStrategy('win32')).toBe('win32-native-shim');
    expect(resolvePackStrategy()).toBe(process.platform === 'win32' ? 'win32-native-shim' : 'posix-install');
  });

  it(
    'packs and exercises the platform packaging seam without a cold Windows production install',
    async () => {
      const strategy = resolvePackStrategy();
      if (strategy === 'posix-install') {
        await runPosixInstallPackaging();
      } else {
        await runWin32NativeShimPackaging({ executeCmd: true });
      }
    },
    90_000
  );

  it(
    'Linux-local win32 strategy plans a native .cmd seam with no npm install',
    async () => {
      // Explicitly target win32 even on Linux/macOS so the command plan is proven here.
      expect(resolvePackStrategy('win32')).toBe('win32-native-shim');
      const plan = await runWin32NativeShimPackaging({ executeCmd: process.platform === 'win32' });
      expect(plan.strategy).toBe('win32-native-shim');
      expect(plan.plannedCommands.map((command) => [command.file, ...command.args].join(' ')).join('\n')).not.toMatch(
        /(?:^|\s)(?:npm(?:\.cmd)?\s+)?install(?:\s|$)/i
      );
      for (const command of plan.plannedCommands) {
        expect(command.args).not.toContain('install');
        expect(command.file.toLowerCase()).not.toContain('install');
      }
      expect(plan.cmdShimPath.endsWith(`${path.sep}${EXPECTED_BIN_NAME}.cmd`)).toBe(true);
      await access(plan.cmdShimPath, constants.F_OK);
      const shimBody = await readFile(plan.cmdShimPath, 'utf8');
      expect(shimBody).toContain(quoteCmdArg(plan.cliPath));
      expect(shimBody).toMatch(/\.cmd|\.cjs|node/i);
    },
    60_000
  );

  it('rejects malicious bin metadata and path tokens before spawn', () => {
    expect(() => assertSafeBinName('evil&whoami')).toThrow(/unsafe cmd metacharacters/);
    expect(() => assertSafeBinName('evil|calc')).toThrow(/unsafe cmd metacharacters/);
    expect(() => assertSafeBinName('x%PATH%')).toThrow(/unsafe cmd metacharacters/);
    expect(() => assertSafeBinName('x!var!')).toThrow(/unsafe cmd metacharacters/);
    expect(() => assertSafeBinName('x^y')).toThrow(/unsafe cmd metacharacters/);
    expect(() => assertSafeBinName('x<y')).toThrow(/unsafe cmd metacharacters/);
    expect(() => assertSafeBinName('x>y')).toThrow(/unsafe cmd metacharacters/);
    expect(() => assertSafeBinName('quoted"name')).toThrow(/unsafe cmd metacharacters/);
    expect(() => assertSafeBinName('line\rname')).toThrow(/unsafe cmd metacharacters/);
    expect(() => assertSafeBinName('line\nname')).toThrow(/unsafe cmd metacharacters/);
    expect(() => assertSafeBinTarget('dist/cli.cjs&calc')).toThrow(/unsafe cmd metacharacters/);
    expect(() => assertSafeBinTarget('../escape.cjs')).toThrow(/relative path/);
    expect(() => assertSafeBinTarget('/abs/cli.cjs')).toThrow(/relative path/);
    expect(() => assertSafePackageName('@scope/evil&name')).toThrow(/unsafe cmd metacharacters/);
    expect(() => quoteCmdArg('has"quote')).toThrow(/unsafe cmd metacharacters/);
    expect(() => planNativeCmdInvocation('C:\\safe\\bin.cmd', ['--help&whoami'])).toThrow(/not allowed/);
    expect(() => planNativeCmdInvocation('C:\\safe\\bin&evil.cmd', ['--help'])).toThrow(/unsafe cmd metacharacters/);

    const extractRoot = path.join(tmpdir(), 'safe-extract');
    const proxyRoot = path.join(tmpdir(), 'safe-proxy');
    expect(() =>
      planWin32NativeShim({
        extractRoot,
        proxyRoot,
        tarballPath: path.join(extractRoot, 'pkg.tgz'),
        meta: {
          name: EXPECTED_PACKAGE_NAME,
          version: '0.0.0',
          binName: 'postman&aws',
          binTarget: 'dist/cli.cjs'
        }
      })
    ).toThrow(/unsafe cmd metacharacters/);
  });

  it('plans a quoted cmd.exe invocation for safe metadata without shell true', () => {
    const safeShim = path.join(tmpdir(), 'proxy', 'node_modules', '.bin', `${EXPECTED_BIN_NAME}.cmd`);
    const planned = planNativeCmdInvocation(safeShim, ['--help']);
    const commandPayload = [quoteCmdArg(safeShim), quoteCmdArg('--help')].join(' ');
    expect(planned.file).toBe(process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe');
    expect(planned.args).toEqual(['/d', '/s', '/c', `"${commandPayload}"`]);
    expect(planned.args[3]).toContain(quoteCmdArg(safeShim));
    expect(planned.args[3]).toContain(quoteCmdArg('--help'));
    expect(planned.args.join(' ')).not.toMatch(/\beval\b/);
  });

  it('keeps native shim execution source free of shell true', async () => {
    const source = await readFile(fileURLToPath(import.meta.url), 'utf8');
    // Build the forbidden token at runtime so this assertion text cannot self-match.
    const shellTrue = ['shell', 'true'].join(': ');
    expect(source.includes(shellTrue)).toBe(false);
    expect(source).not.toMatch(/shell\s*:\s*true/);
  });

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

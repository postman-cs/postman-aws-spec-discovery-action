import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeMock, resolveInputsMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  resolveInputsMock: vi.fn()
}));

vi.mock('../src/runtime.js', () => ({
  defaultWriteSpecFile: vi.fn(),
  execute: executeMock,
  resolveInputs: resolveInputsMock
}));

vi.mock('../src/lib/aws/client.js', () => ({
  AwsApiGatewaySdkClient: class {
    public constructor() {}
  }
}));

import { parseCliArgs, runCli } from '../src/cli.js';

describe('parseCliArgs', () => {
  it('rejects unknown, positional, missing, and duplicate arguments', () => {
    expect(() => parseCliArgs(['--unknown', 'value'], {})).toThrow(/Unknown option: --unknown/);
    expect(() => parseCliArgs(['us-east-1'], {})).toThrow(/Unexpected positional argument/);
    expect(() => parseCliArgs(['--aws-region'], {})).toThrow(/Missing value for --aws-region/);
    expect(() => parseCliArgs(['--aws-region', '--dry-run', 'true'], {})).toThrow(/Missing value for --aws-region/);
    expect(() => parseCliArgs(['--dry-run'], {})).toThrow(/Missing value for --dry-run/);
    expect(() => parseCliArgs(['--dry-run=false', '--dry-run', 'true'], {})).toThrow(/Duplicate option: --dry-run/);
    expect(() => parseCliArgs(['--help', '--version'], {})).toThrow(/cannot be combined/);
  });

  it('lets explicit CLI values override normalized INPUT environment values', () => {
    const parsed = parseCliArgs(['--dry-run', 'false'], { INPUT_DRY_RUN: 'true' });
    expect(parsed.kind).toBe('run');
    if (parsed.kind !== 'run') {
      return;
    }
    expect(parsed.inputEnv.INPUT_DRY_RUN).toBe('false');
  });
});

describe('runCli integration boundary', () => {
  beforeEach(() => {
    executeMock.mockReset();
    resolveInputsMock.mockReset();
  });

  it.each([
    ['--help', /Usage: postman-aws-spec-discovery/],
    ['--version', /^2\.0\.0\n$/]
  ])('handles %s without resolving inputs, telemetry, execution, or files', async (flag, expected) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runCli([flag], { writeStdout: (chunk) => process.stdout.write(chunk) });

    expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')).toMatch(expected);
    expect(resolveInputsMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    stdout.mockRestore();
  });

  it('ignores malformed input environment when printing help', async () => {
    let stdout = '';
    await runCli(['--help'], {
      env: { INPUT_UNKNOWN: 'value', INPUT_DRY_RUN: 'not-a-boolean' },
      writeStdout: (chunk) => {
        stdout += chunk;
      }
    });
    expect(stdout).toContain('Usage: postman-aws-spec-discovery');
    expect(resolveInputsMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('rejects malformed dry-run before input resolution or execution', async () => {
    await expect(runCli(['--dry-run'])).rejects.toThrow(/Missing value for --dry-run/);
    expect(resolveInputsMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('writes result JSON and dotenv artifacts', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-cli-test-'));
    const oldCwd = process.cwd();
    try {
      process.chdir(tempDir);
      resolveInputsMock.mockReturnValue({
        mode: 'resolve-one',
        awsRegion: 'us-east-1',
        repoRoot: '.',
        repoContext: { provider: 'unknown' },
        expectedGatewayIds: [],
        serviceMapping: {},
        outputDir: 'discovered-specs',
        allowPartialFailure: false,
        maxCandidates: 50,
        dryRun: false,
        preflightChecks: true,
        preflightPermissionProbe: true,
        requestTimeoutMs: 30000,
        maxAttempts: 3,
        includeV2: true
      });
      executeMock.mockResolvedValue({
        mode: 'resolve-one',
        discovered: [],
        outputs: {
          'resolution-json': '{"status":"resolved"}',
          'resolution-status': 'resolved',
          'source-type': 'repo-spec',
          'mapping-confidence': '90',
          'spec-path': 'openapi.yaml',
          'gateway-id': '',
          'service-name': 'svc',
          'services-json': '[]',
          'service-count': '0',
          'export-summary-json': '{"attempted":0,"exported":0,"failed":0,"skipped":0}'
        }
      });
      await runCli([
        '--aws-region',
        'us-east-1',
        '--result-json',
        'result.json',
        '--dotenv-path',
        'result.env'
      ]);
      const resultJson = await readFile(path.join(tempDir, 'result.json'), 'utf8');
      const dotenv = await readFile(path.join(tempDir, 'result.env'), 'utf8');
      expect(resultJson).toContain('"mode": "resolve-one"');
      expect(dotenv).toContain('POSTMAN_AWS_SPEC_RESOLUTION_STATUS=');
      expect(dotenv).toContain('POSTMAN_AWS_SPEC_EXPORT_SUMMARY_JSON=');
    } finally {
      process.chdir(oldCwd);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects file outputs outside workspace', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-cli-test-'));
    const oldCwd = process.cwd();
    try {
      process.chdir(tempDir);
      resolveInputsMock.mockReturnValue({
        mode: 'resolve-one',
        awsRegion: 'us-east-1',
        repoRoot: '.',
        repoContext: { provider: 'unknown' },
        expectedGatewayIds: [],
        serviceMapping: {},
        outputDir: 'discovered-specs',
        allowPartialFailure: false,
        maxCandidates: 50,
        dryRun: false,
        preflightChecks: true,
        preflightPermissionProbe: true,
        requestTimeoutMs: 30000,
        maxAttempts: 3,
        includeV2: true
      });
      executeMock.mockResolvedValue({
        mode: 'resolve-one',
        discovered: [],
        outputs: {}
      });
      await expect(
        runCli(['--aws-region', 'us-east-1', '--result-json', '../escape.json'])
      ).rejects.toThrow(/must stay within workspace/);
    } finally {
      process.chdir(oldCwd);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

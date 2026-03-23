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

import { runCli } from '../src/cli.js';

describe('runCli integration boundary', () => {
  beforeEach(() => {
    executeMock.mockReset();
    resolveInputsMock.mockReset();
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

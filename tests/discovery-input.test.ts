import { describe, expect, it } from 'vitest';

import { readActionInputs, resolveInputs } from '../src/index.js';
import { createCoreStub } from './helpers/discovery-fixtures.js';

describe('input parsing', () => {
  it('reads the simplified public action inputs', () => {
    const { core } = createCoreStub({
      'aws-region': 'us-west-2',
      'gateway-id': 'rest-1',
      stage: 'prod',
      'output-dir': 'out/specs'
    });

    // Clear CI workspace env vars to avoid fallback pollution in test
    const origGH = process.env.GITHUB_WORKSPACE;
    const origGL = process.env.CI_PROJECT_DIR;
    const origBB = process.env.BITBUCKET_CLONE_DIR;
    const origADO = process.env.BUILD_SOURCESDIRECTORY;
    delete process.env.GITHUB_WORKSPACE;
    delete process.env.CI_PROJECT_DIR;
    delete process.env.BITBUCKET_CLONE_DIR;
    delete process.env.BUILD_SOURCESDIRECTORY;

    try {
      const inputs = readActionInputs(core);

      expect(inputs.mode).toBe('resolve-one');
      expect(inputs.awsRegion).toBe('us-west-2');
      expect(inputs.repoRoot).toBe('.');
      expect(inputs.expectedGatewayIds).toEqual(['rest-1']);
      expect(inputs.stage).toBe('prod');
      expect(inputs.outputDir).toBe('out/specs');
      expect(inputs.includeV2).toBe(true);
    } finally {
      if (origGH !== undefined) process.env.GITHUB_WORKSPACE = origGH;
      if (origGL !== undefined) process.env.CI_PROJECT_DIR = origGL;
      if (origBB !== undefined) process.env.BITBUCKET_CLONE_DIR = origBB;
      if (origADO !== undefined) process.env.BUILD_SOURCESDIRECTORY = origADO;
    }
  });

  it('fails fast on invalid include-v2 values', () => {
    expect(() =>
      resolveInputs({
        INPUT_MODE: 'resolve-one',
        INPUT_AWS_REGION: 'us-east-1',
        INPUT_INCLUDE_V2: 'sometimes'
      })
    ).toThrow(/include-v2 must be a boolean-like value/);
  });

  it('resolves AWS region by input, AWS_REGION, then AWS_DEFAULT_REGION', () => {
    expect(resolveInputs({ INPUT_AWS_REGION: 'input-region', AWS_REGION: 'aws-region', AWS_DEFAULT_REGION: 'default-region' }).awsRegion).toBe(
      'input-region'
    );
    expect(resolveInputs({ AWS_REGION: 'aws-region', AWS_DEFAULT_REGION: 'default-region' }).awsRegion).toBe('aws-region');
    expect(resolveInputs({ AWS_DEFAULT_REGION: 'default-region' }).awsRegion).toBe('default-region');
    expect(() => resolveInputs({})).toThrow(/aws-region is required/);
  });

  it('accepts runner-form INPUT aliases and rejects conflicting alias values', () => {
    expect(resolveInputs({ INPUT_AWS_REGION: 'us-east-1', 'INPUT_DRY-RUN': 'true' } as NodeJS.ProcessEnv).dryRun).toBe(true);
    expect(() =>
      resolveInputs({
        INPUT_AWS_REGION: 'us-east-1',
        INPUT_DRY_RUN: 'false',
        'INPUT_DRY-RUN': 'true'
      } as NodeJS.ProcessEnv)
    ).toThrow(/Conflicting values for dry-run/);
    expect(() =>
      resolveInputs({ INPUT_AWS_REGION: 'us-east-1', 'INPUT_DRY-RUN': 'not-a-boolean' } as NodeJS.ProcessEnv)
    ).toThrow(/dry-run must be a boolean-like value/);
  });

  it.each([
    ['INPUT_MAX_CANDIDATES', '10items', 'max-candidates'],
    ['INPUT_MAX_CANDIDATES', '10001', 'max-candidates'],
    ['INPUT_REQUEST_TIMEOUT_MS', '1.5', 'request-timeout-ms'],
    ['INPUT_REQUEST_TIMEOUT_MS', '300001', 'request-timeout-ms'],
    ['INPUT_MAX_ATTEMPTS', '+3', 'max-attempts'],
    ['INPUT_MAX_ATTEMPTS', '101', 'max-attempts']
  ])('rejects non-full-string or out-of-bounds numeric %s=%s', (envName, value, inputName) => {
    expect(() => resolveInputs({ INPUT_AWS_REGION: 'us-east-1', [envName]: value })).toThrow(
      new RegExp(`${inputName} must be a non-negative integer between`)
    );
  });

  it('accepts bounded integer controls', () => {
    const inputs = resolveInputs({
      INPUT_AWS_REGION: 'us-east-1',
      INPUT_MAX_CANDIDATES: '10000',
      INPUT_REQUEST_TIMEOUT_MS: '300000',
      INPUT_MAX_ATTEMPTS: '100'
    });
    expect(inputs.maxCandidates).toBe(10000);
    expect(inputs.requestTimeoutMs).toBe(300000);
    expect(inputs.maxAttempts).toBe(100);
  });

  it('auto-resolves repo-root from CI workspace variables when omitted', () => {
    const inputs = resolveInputs({
      INPUT_MODE: 'resolve-one',
      INPUT_AWS_REGION: 'us-east-1',
      GITHUB_WORKSPACE: '/tmp/github-workspace'
    });

    expect(inputs.repoRoot).toBe('/tmp/github-workspace');
  });

  it('auto-resolves repo-root from Bitbucket BITBUCKET_CLONE_DIR', () => {
    const inputs = resolveInputs({
      INPUT_MODE: 'resolve-one',
      INPUT_AWS_REGION: 'us-east-1',
      BITBUCKET_CLONE_DIR: '/opt/atlassian/pipelines/agent/build'
    });

    expect(inputs.repoRoot).toBe('/opt/atlassian/pipelines/agent/build');
  });

  it('auto-resolves repo-root from Azure DevOps BUILD_SOURCESDIRECTORY', () => {
    const inputs = resolveInputs({
      INPUT_MODE: 'resolve-one',
      INPUT_AWS_REGION: 'us-east-1',
      BUILD_SOURCESDIRECTORY: '/home/vsts/work/1/s'
    });

    expect(inputs.repoRoot).toBe('/home/vsts/work/1/s');
  });

  it('explicit repo-root input overrides all CI env vars', () => {
    const inputs = resolveInputs({
      INPUT_MODE: 'resolve-one',
      INPUT_AWS_REGION: 'us-east-1',
      INPUT_REPO_ROOT: '/explicit/path',
      GITHUB_WORKSPACE: '/tmp/github-workspace',
      CI_PROJECT_DIR: '/tmp/gitlab',
      BITBUCKET_CLONE_DIR: '/tmp/bitbucket',
      BUILD_SOURCESDIRECTORY: '/tmp/azure'
    });

    expect(inputs.repoRoot).toBe('/explicit/path');
  });
});

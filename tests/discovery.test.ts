import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { DiscoveredService } from '../src/contracts.js';
import { readActionInputs, resolveInputs, runDiscovery, runAction } from '../src/index.js';
import { AwsApiGatewayCliClient } from '../src/lib/aws/client.js';
import { findExistingRepoSpec } from '../src/lib/repo/specs.js';
import { collectRepoSignals } from '../src/lib/repo/signals.js';
import { resolveServiceCandidate } from '../src/lib/resolve/service-resolver.js';
import { chooseSource } from '../src/lib/resolve/source-selector.js';

function createCoreStub(values: Record<string, string> = {}) {
  const outputs: Record<string, string> = {};
  const infos: string[] = [];
  const warnings: string[] = [];

  return {
    core: {
      getInput: (name: string, options?: { required?: boolean }) => {
        const value = values[name] ?? '';
        if (options?.required && !value) {
          throw new Error(`Input required and not supplied: ${name}`);
        }
        return value;
      },
      group: async (_name: string, fn: () => Promise<any>) => fn(),
      info: (message: string) => {
        infos.push(message);
      },
      warning: (message: string) => {
        warnings.push(message);
      },
      setOutput: (name: string, value: string) => {
        outputs[name] = value;
      },
      setFailed: vi.fn()
    },
    outputs,
    infos,
    warnings
  };
}

describe('input parsing', () => {
  it('reads required and optional action inputs', () => {
    const { core } = createCoreStub({
      mode: 'resolve-one',
      'aws-region': 'us-west-2',
      'repo-url': 'git@github.com:postman/payments.git',
      'repo-slug': 'postman/payments',
      'git-provider': 'github',
      ref: 'main',
      sha: 'abc123',
      'repo-root': '.',
      'expected-service-name': 'payments',
      'expected-gateway-ids-json': '["rest-1"]',
      stage: 'prod',
      'api-filter': '^payments',
      'service-mapping-json': '{"abc":"payments-service"}',
      'output-dir': 'out/specs',
      'include-v2': 'true'
    });

    const inputs = readActionInputs(core);

    expect(inputs.mode).toBe('resolve-one');
    expect(inputs.awsRegion).toBe('us-west-2');
    expect(inputs.repoContext.provider).toBe('github');
    expect(inputs.repoContext.repoUrl).toBe('https://github.com/postman/payments');
    expect(inputs.repoContext.repoSlug).toBe('postman/payments');
    expect(inputs.repoContext.ref).toBe('main');
    expect(inputs.repoContext.sha).toBe('abc123');
    expect(inputs.repoRoot).toBe('.');
    expect(inputs.expectedServiceName).toBe('payments');
    expect(inputs.expectedGatewayIds).toEqual(['rest-1']);
    expect(inputs.stage).toBe('prod');
    expect(inputs.apiFilter?.test('payments-api')).toBe(true);
    expect(inputs.serviceMapping).toEqual({ abc: 'payments-service' });
    expect(inputs.outputDir).toBe('out/specs');
    expect(inputs.includeV2).toBe(true);
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

  it('auto-resolves repo-root from CI workspace variables when omitted', () => {
    const inputs = resolveInputs({
      INPUT_MODE: 'resolve-one',
      INPUT_AWS_REGION: 'us-east-1',
      GITHUB_WORKSPACE: '/tmp/github-workspace'
    });

    expect(inputs.repoRoot).toBe('/tmp/github-workspace');
  });
});

describe('runDiscovery', () => {
  it('exports REST and HTTP specs, resolves names by priority, and continues on single API failure', async () => {
    const { core, warnings } = createCoreStub();
    const written = new Map<string, string>();

    const aws = {
      listRestApis: vi.fn().mockResolvedValue([
        { id: 'rest-1', name: 'rest-api-one' },
        { id: 'rest-2', name: 'legacy-name' }
      ]),
      listHttpApis: vi.fn().mockResolvedValue([{ id: 'http-1', name: 'checkout-http', protocolType: 'HTTP' }]),
      getRestApi: vi.fn(),
      getHttpApi: vi.fn(),
      listRestStages: vi
        .fn()
        .mockImplementation(async (id: string) => (id === 'rest-2' ? ['staging'] : ['prod'])),
      listHttpStages: vi.fn().mockResolvedValue(['$default']),
      getRestTags: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'rest-1') {
          return {
            'postman:project-name': 'payments-core',
            Name: 'ignored'
          };
        }

        return {
          Name: 'name-tag-service'
        };
      }),
      getHttpTags: vi.fn().mockResolvedValue({}),
      exportRestApi: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'rest-2') {
          throw new Error('simulated export failure');
        }
        return `openapi: 3.0.1\ninfo:\n  title: ${id}`;
      }),
      exportHttpApi: vi.fn().mockResolvedValue('openapi: 3.0.1\ninfo:\n  title: http')
    };

    const discovered = await runDiscovery(
      {
        mode: 'discover-many',
        awsRegion: 'us-east-1',
        repoRoot: '.',
        repoContext: { provider: 'unknown' },
        expectedGatewayIds: [],
        stage: undefined,
        apiFilter: undefined,
        serviceMapping: {
          'http-1': 'checkout-service'
        },
        outputDir: 'discovered-specs',
        includeV2: true
      },
      {
        core,
        aws,
        writeSpecFile: async (outputPath: string, content: string) => {
          written.set(outputPath.replace(/\\/g, '/'), content);
        }
      }
    );

    expect(discovered).toEqual<DiscoveredService[]>([
      {
        serviceName: 'payments-core',
        specPath: 'discovered-specs/payments-core/index.yaml',
        gatewayId: 'rest-1',
        gatewayType: 'REST',
        stage: 'prod'
      },
      {
        serviceName: 'checkout-service',
        specPath: 'discovered-specs/checkout-service/index.yaml',
        gatewayId: 'http-1',
        gatewayType: 'HTTP',
        stage: '$default'
      }
    ]);

    expect(
      [...written.keys()].some((entry) => entry.endsWith('/discovered-specs/payments-core/index.yaml'))
    ).toBe(true);
    expect(
      [...written.keys()].some((entry) => entry.endsWith('/discovered-specs/checkout-service/index.yaml'))
    ).toBe(true);
    expect(warnings.some((message) => message.includes('simulated export failure'))).toBe(true);
  });

  it('skips HTTP discovery when include-v2=false and applies API filter', async () => {
    const { core } = createCoreStub();

    const aws = {
      listRestApis: vi.fn().mockResolvedValue([
        { id: 'rest-a', name: 'payments-public' },
        { id: 'rest-b', name: 'internal-tools' }
      ]),
      listHttpApis: vi.fn().mockResolvedValue([{ id: 'http-1', name: 'payments-http', protocolType: 'HTTP' }]),
      getRestApi: vi.fn(),
      getHttpApi: vi.fn(),
      listRestStages: vi.fn().mockResolvedValue(['prod']),
      listHttpStages: vi.fn().mockResolvedValue(['prod']),
      getRestTags: vi.fn().mockResolvedValue({}),
      getHttpTags: vi.fn().mockResolvedValue({}),
      exportRestApi: vi.fn().mockResolvedValue('openapi: 3.0.1'),
      exportHttpApi: vi.fn().mockResolvedValue('openapi: 3.0.1')
    };

    const discovered = await runDiscovery(
      {
        mode: 'discover-many',
        awsRegion: 'us-east-1',
        repoRoot: '.',
        repoContext: { provider: 'unknown' },
        expectedGatewayIds: [],
        stage: 'prod',
        apiFilter: /^payments/,
        serviceMapping: {},
        outputDir: 'discovered-specs',
        includeV2: false
      },
      {
        core,
        aws,
        writeSpecFile: async () => undefined
      }
    );

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.gatewayId).toBe('rest-a');
    expect(aws.listHttpApis).not.toHaveBeenCalled();
    expect(aws.exportHttpApi).not.toHaveBeenCalled();
  });
});

describe('runAction', () => {
  it('emits resolution outputs in resolve-one mode', async () => {
    const { core, outputs } = createCoreStub({
      'aws-region': 'us-east-1',
      mode: 'resolve-one',
      'include-v2': 'false',
      'repo-root': '.',
      'repo-slug': 'postman/billing',
      'expected-gateway-ids-json': '["rest-1"]'
    });

    const execStub = {
      getExecOutput: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({
            id: 'rest-1',
            name: 'billing'
          }),
          stderr: ''
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ tags: {} }),
          stderr: ''
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({
            item: [{ stageName: 'prod' }]
          }),
          stderr: ''
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'openapi: 3.0.1\ninfo:\n  title: billing',
          stderr: ''
        })
    };

    const result = await runAction(core, execStub);

    expect(result).toHaveLength(0);
    expect(outputs['resolution-status']).toBe('resolved');
    expect(outputs['source-type']).toBe('gateway-export');
    expect(outputs['service-name']).toBe('billing');
    expect(outputs['gateway-id']).toBe('rest-1');
    expect(outputs['spec-path']).toContain('discovered-specs/billing/index.yaml');
    expect(() => JSON.parse(outputs['resolution-json'] ?? '{}')).not.toThrow();
  });

  it('downgrades export bad request errors to manual review', async () => {
    const { core, outputs } = createCoreStub({
      'aws-region': 'us-east-1',
      mode: 'resolve-one',
      'repo-root': '.',
      'expected-gateway-ids-json': '["http-1"]'
    });

    const execStub = {
      getExecOutput: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'NotFoundException'
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({
            ApiId: 'http-1',
            Name: 'http-service',
            ProtocolType: 'HTTP'
          }),
          stderr: ''
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ tags: {} }),
          stderr: ''
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ Items: [] }),
          stderr: ''
        })
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'BadRequestException: Unable to deploy API because no valid routes exist in this API'
        })
    };

    await runAction(core, execStub);

    expect(outputs['resolution-status']).toBe('unresolved');
    expect(outputs['source-type']).toBe('manual-review');
  });
});

describe('hardening helpers', () => {
  it('marks equal-confidence candidates as ambiguous', () => {
    const candidate = resolveServiceCandidate(
      [
        { id: 'aaaaabbbbb', name: 'payments-api', gatewayType: 'REST', tags: {} },
        { id: 'ccccdddddd', name: 'payments-api-copy', gatewayType: 'REST', tags: {} }
      ],
      {
        serviceHints: ['payments'],
        explicitGatewayIdHints: [],
        inferredGatewayIdHints: [],
        evidence: []
      }
    );

    expect(candidate?.ambiguous).toBe(true);
  });

  it('routes ambiguous candidates to manual review', () => {
    const result = chooseSource({
      fallbackServiceName: 'payments',
      candidate: {
        serviceName: 'payments',
        gatewayId: 'aaaaabbbbb',
        gatewayType: 'REST',
        confidence: 50,
        ambiguous: true,
        evidence: ['ambiguous']
      }
    });

    expect(result.status).toBe('unresolved');
    expect(result.sourceType).toBe('manual-review');
  });

  it('finds only valid OpenAPI repo specs', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-spec-test-'));
    try {
      await writeFile(path.join(tempDir, 'swagger.yml'), 'not actually yaml for openapi', 'utf8');
      await writeFile(path.join(tempDir, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'x', version: '1.0.0' } }), 'utf8');

      const result = await findExistingRepoSpec(tempDir);

      expect(result).toBe('openapi.json');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('extracts only contextual gateway IDs from repo files', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-signal-test-'));
    try {
      await writeFile(
        path.join(tempDir, 'README.md'),
        'URL https://abc123def4.execute-api.us-east-1.amazonaws.com/prod and random token qwerty1234',
        'utf8'
      );

      const signals = await collectRepoSignals(tempDir, 'postman/payments', undefined, []);

      expect(signals.inferredGatewayIdHints).toEqual(['abc123def4']);
      expect(signals.inferredGatewayIdHints).not.toContain('qwerty1234');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('AwsApiGatewayCliClient', () => {
  it('decodes base64 output body when AWS CLI returns encoded text', async () => {
    const encoded = Buffer.from('openapi: 3.0.1\ninfo:\n  title: rest', 'utf8').toString('base64');
    const execStub = {
      getExecOutput: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: encoded,
        stderr: ''
      })
    };

    const client = new AwsApiGatewayCliClient(execStub, 'us-east-1');
    const body = await client.exportRestApi('rest-1', 'prod');

    expect(body).toContain('openapi: 3.0.1');
  });
});

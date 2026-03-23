import { describe, expect, it, vi } from 'vitest';

import type { DiscoveredService } from '../src/contracts.js';
import { readActionInputs, resolveInputs, runDiscovery, runAction } from '../src/index.js';
import { AwsApiGatewayCliClient } from '../src/lib/aws/client.js';

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
      listHttpApis: vi.fn().mockResolvedValue([{ id: 'http-1', name: 'checkout-http' }]),
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
      listHttpApis: vi.fn().mockResolvedValue([{ id: 'http-1', name: 'payments-http' }]),
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
            items: [{ id: 'rest-1', name: 'billing' }]
          }),
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
          stdout: JSON.stringify({
            tags: {}
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

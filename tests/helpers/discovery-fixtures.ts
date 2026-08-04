import { vi } from 'vitest';

import type { AwsGatewayClient } from '../../src/lib/aws/client.js';

export function createCoreStub(values: Record<string, string> = {}) {
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
      group: async <T>(_name: string, fn: () => Promise<T>) => fn(),
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

export function createAwsClientStub(overrides: Partial<AwsGatewayClient> = {}): AwsGatewayClient {
  return {
    listRestApis: vi.fn().mockResolvedValue([]),
    listHttpApis: vi.fn().mockResolvedValue([]),
    getRestApi: vi.fn().mockResolvedValue(undefined),
    getHttpApi: vi.fn().mockResolvedValue(undefined),
    listRestStages: vi.fn().mockResolvedValue([]),
    listHttpStages: vi.fn().mockResolvedValue([]),
    getRestTags: vi.fn().mockResolvedValue({}),
    getHttpTags: vi.fn().mockResolvedValue({}),
    exportRestApi: vi.fn().mockResolvedValue('openapi: 3.0.1'),
    exportHttpApi: vi.fn().mockResolvedValue('openapi: 3.0.1'),
    exportWebSocketApi: vi.fn().mockResolvedValue('openapi: 3.0.3'),
    getCallerIdentity: vi.fn().mockResolvedValue({
      accountId: '123456789012',
      arn: 'arn:aws:iam::123456789012:role/test'
    }),
    probeApiGatewayReadAccess: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

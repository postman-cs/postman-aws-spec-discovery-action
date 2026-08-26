import { describe, expect, it, vi } from 'vitest';
import { createLogger, type LogSink } from '@postman-cs/automation-core';

import { runAction } from '../src/index.js';

/**
 * A log line is evidence. These tests pin the properties that make it worth
 * trusting: credentials never survive into it, a failure names the phase it
 * died in, and debug output is opt-in rather than always-on.
 */

function recordingSink(): { sink: LogSink; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    sink: {
      debug: (message) => lines.push(`debug ${message}`),
      info: (message) => lines.push(`info ${message}`),
      warning: (message) => lines.push(`warning ${message}`),
      error: (message) => lines.push(`error ${message}`)
    }
  };
}

const PMAK = 'PMAK-awsdiscoverytestkey-0123456789';

function coreStub(values: Record<string, string> = {}) {
  const secrets: string[] = [];
  return {
    secrets,
    core: {
      getInput: (name: string, options?: { required?: boolean }) => {
        const value = values[name] ?? '';
        if (options?.required && !value) throw new Error(`Input required and not supplied: ${name}`);
        return value;
      },
      group: async <T,>(_name: string, fn: () => Promise<T>) => fn(),
      info: () => {},
      warning: () => {},
      setOutput: () => {},
      setFailed: vi.fn(),
      setSecret: (value: string) => {
        secrets.push(value);
      }
    }
  };
}

describe('aws-spec-discovery logging', () => {
  it('never emits the credential it was handed', async () => {
    const { sink, lines } = recordingSink();
    const logger = createLogger({ sink, level: 'debug' });
    const { core, secrets } = coreStub({ 'aws-region': 'us-east-1' });

    // The action reads its Postman credentials through the runner's INPUT_*
    // environment, not the injected core facade, so the test supplies the key
    // the same way a real workflow does.
    const previous = process.env.INPUT_POSTMAN_API_KEY;
    process.env.INPUT_POSTMAN_API_KEY = PMAK;
    try {
      await expect(
        runAction(core, {
          logger,
          createAwsClient: () => {
            // An upstream that reflects the credential back must not turn a
            // diagnostic line into a leak.
            throw new Error(`upstream echoed ${PMAK}`);
          }
        })
      ).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.INPUT_POSTMAN_API_KEY;
      else process.env.INPUT_POSTMAN_API_KEY = previous;
    }

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(PMAK);
    // The runner masks it too, so the same value is redacted in raw step output.
    expect(secrets).toContain(PMAK);
  });

  it('names the phase that failed instead of leaving only a stack', async () => {
    const { sink, lines } = recordingSink();
    const logger = createLogger({ sink, level: 'debug' });
    const { core } = coreStub({ 'aws-region': 'us-east-1' });

    await expect(
      runAction(core, {
        logger,
        createAwsClient: () => {
          throw new Error('AccessDenied: apigateway:GET');
        }
      })
    ).rejects.toThrow(/AccessDenied/);

    const all = lines.join('\n');
    expect(all).toContain('phase=discover');
    expect(all).toContain('phase failed');
    expect(all).toContain('AccessDenied');
  });

  it('keeps debug chatter out of a default run and opens it under RUNNER_DEBUG', async () => {
    async function run(env: NodeJS.ProcessEnv): Promise<string[]> {
      const { sink, lines } = recordingSink();
      const { core } = coreStub({ 'aws-region': 'us-east-1' });
      await runAction(core, {
        logger: createLogger({ sink, env }),
        createAwsClient: () => {
          throw new Error('stop here');
        }
      }).catch(() => undefined);
      return lines;
    }

    expect((await run({})).filter((line) => line.startsWith('debug'))).toHaveLength(0);
    expect(
      (await run({ RUNNER_DEBUG: '1' })).filter((line) => line.startsWith('debug')).length
    ).toBeGreaterThan(0);
  });
});

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AwsApiGatewaySdkClient } from './lib/aws/client.js';
import { defaultWriteSpecFile, execute, resolveInputs, type ReporterLike } from './runtime.js';

interface CliConfig {
  inputEnv: NodeJS.ProcessEnv;
  resultJsonPath: string;
  dotenvPath?: string;
}

class ConsoleReporter implements ReporterLike {
  public async group<T>(name: string, fn: () => Promise<T>): Promise<T> {
    console.error(`[group] ${name}`);
    return await fn();
  }

  public info(message: string): void {
    console.error(message);
  }

  public warning(message: string): void {
    console.error(`warning: ${message}`);
  }
}

function readFlag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === `--${name}`) {
      return argv[index + 1];
    }
    if (arg?.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return undefined;
}

function normalizeCliFlag(name: string): string {
  return `INPUT_${name.replace(/-/g, '_').toUpperCase()}`;
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliConfig {
  const inputNames = [
    'mode',
    'aws-region',
    'repo-url',
    'repo-slug',
    'git-provider',
    'ref',
    'sha',
    'repo-root',
    'expected-service-name',
    'expected-gateway-ids-json',
    'stage',
    'api-filter',
    'service-mapping-json',
    'output-dir',
    'include-v2'
  ];

  const inputEnv: NodeJS.ProcessEnv = { ...env };
  for (const name of inputNames) {
    const value = readFlag(argv, name);
    if (value !== undefined) {
      inputEnv[normalizeCliFlag(name)] = value;
    }
  }

  return {
    inputEnv,
    resultJsonPath: readFlag(argv, 'result-json') ?? 'postman-aws-spec-discovery-result.json',
    dotenvPath: readFlag(argv, 'dotenv-path')
  };
}

export function toDotenv(outputs: Record<string, string>): string {
  const envPairs = {
    POSTMAN_AWS_SPEC_RESOLUTION_JSON: outputs['resolution-json'] ?? '',
    POSTMAN_AWS_SPEC_RESOLUTION_STATUS: outputs['resolution-status'] ?? '',
    POSTMAN_AWS_SPEC_SOURCE_TYPE: outputs['source-type'] ?? '',
    POSTMAN_AWS_SPEC_MAPPING_CONFIDENCE: outputs['mapping-confidence'] ?? '',
    POSTMAN_AWS_SPEC_PATH: outputs['spec-path'] ?? '',
    POSTMAN_AWS_SPEC_GATEWAY_ID: outputs['gateway-id'] ?? '',
    POSTMAN_AWS_SPEC_SERVICE_NAME: outputs['service-name'] ?? '',
    POSTMAN_AWS_SPEC_SERVICES_JSON: outputs['services-json'] ?? '',
    POSTMAN_AWS_SPEC_SERVICE_COUNT: outputs['service-count'] ?? ''
  };

  return Object.entries(envPairs)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n');
}

async function writeOptionalFile(filePath: string | undefined, content: string): Promise<void> {
  if (!filePath) {
    return;
  }
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(path.resolve(filePath), content, 'utf8');
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const config = parseCliArgs(argv, process.env);
  const inputs = resolveInputs(config.inputEnv);
  const result = await execute(inputs, {
    core: new ConsoleReporter(),
    aws: new AwsApiGatewaySdkClient(inputs.awsRegion),
    writeSpecFile: defaultWriteSpecFile
  });

  await writeOptionalFile(config.resultJsonPath, JSON.stringify(result, null, 2));
  await writeOptionalFile(config.dotenvPath, toDotenv(result.outputs));

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const currentModulePath = typeof __filename === 'string' ? __filename : '';
const entrypoint = process.argv[1];

if (entrypoint && currentModulePath === entrypoint) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

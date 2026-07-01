import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AwsApiGatewaySdkClient } from './lib/aws/client.js';
import { formatUserSafeError, sanitizeLogMessage } from './lib/logging/sanitize.js';
import { defaultWriteSpecFile, execute, resolveInputs, type ReporterLike } from './runtime.js';
import { prepareTelemetryCredentials } from './lib/postman/telemetry-credentials.js';
import { createTelemetryContext } from '@postman-cse/automation-telemetry-core';
import { resolveActionVersion } from './action-version.js';

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
    console.error(`warning: ${sanitizeLogMessage(message)}`);
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
    'gateway-id',
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
    'max-candidates',
    'dry-run',
    'preflight-checks',
    'preflight-permission-probe',
    'request-timeout-ms',
    'max-attempts',
    'include-v2',
    'postman-api-key',
    'postman-access-token'
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
    POSTMAN_AWS_SPEC_EXPORT_SUMMARY_JSON: outputs['export-summary-json'] ?? '',
    POSTMAN_AWS_SPEC_SERVICES_JSON: outputs['services-json'] ?? '',
    POSTMAN_AWS_SPEC_SERVICE_COUNT: outputs['service-count'] ?? '',
    POSTMAN_AWS_SPEC_CANDIDATES_JSON: outputs['candidates-json'] ?? '',
    POSTMAN_AWS_SPEC_PROVIDER_TYPE: outputs['provider-type'] ?? '',
    POSTMAN_AWS_SPEC_FORMAT: outputs['spec-format'] ?? '',
    POSTMAN_AWS_SPEC_CONTRACT_ORIGIN: outputs['contract-origin'] ?? '',
    POSTMAN_AWS_SPEC_CONTRACT_METADATA_PATH: outputs['contract-metadata-path'] ?? '',
    POSTMAN_AWS_SPEC_VARIANT_COUNT: outputs['variant-count'] ?? '',
    POSTMAN_AWS_SPEC_DERIVED_OPENAPI_PATH: outputs['derived-openapi-path'] ?? '',
    POSTMAN_AWS_SPEC_DERIVED_OPENAPI_VERSION: outputs['derived-openapi-version'] ?? '',
    POSTMAN_AWS_SPEC_DERIVED_OPENAPI_COMPLETENESS: outputs['derived-openapi-completeness'] ?? '',
    POSTMAN_AWS_SPEC_DERIVED_OPENAPI_FORMAT: outputs['derived-openapi-format'] ?? '',
    POSTMAN_AWS_SPEC_DERIVED_OPENAPI_EVIDENCE_JSON: outputs['derived-openapi-evidence-json'] ?? ''
  };

  return Object.entries(envPairs)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n');
}

async function writeOptionalFile(filePath: string | undefined, content: string): Promise<void> {
  if (!filePath) {
    return;
  }
  const workspaceRoot = path.resolve(process.cwd());
  const resolved = path.resolve(workspaceRoot, filePath);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Output path must stay within workspace: ${filePath}`);
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, content, 'utf8');
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const config = parseCliArgs(argv, process.env);
  const inputs = resolveInputs(config.inputEnv);
  const reporter = new ConsoleReporter();
  const telemetry = createTelemetryContext({ action: 'postman-aws-spec-discovery-action', actionVersion: resolveActionVersion(), logger: reporter });
  telemetry.setTeamId(config.inputEnv.POSTMAN_TEAM_ID ?? process.env.POSTMAN_TEAM_ID);
  // Optional telemetry enrichment (D1): mint/re-mint access token when PMAK is
  // present, resolve account_type once, best-effort, before either completion emit.
  const { accountType } = await prepareTelemetryCredentials({
    postmanApiKey: config.inputEnv.INPUT_POSTMAN_API_KEY ?? process.env.POSTMAN_API_KEY,
    postmanAccessToken: config.inputEnv.INPUT_POSTMAN_ACCESS_TOKEN ?? process.env.POSTMAN_ACCESS_TOKEN
  });
  try {
    const result = await execute(inputs, {
      core: reporter,
      aws: new AwsApiGatewaySdkClient(inputs.awsRegion, {
        requestTimeoutMs: inputs.requestTimeoutMs,
        maxAttempts: inputs.maxAttempts
      }),
      writeSpecFile: defaultWriteSpecFile
    });

    await writeOptionalFile(config.resultJsonPath, JSON.stringify(result, null, 2));
    await writeOptionalFile(config.dotenvPath, toDotenv(result.outputs));

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    telemetry.setAccountType(accountType);
    telemetry.emitCompletion('success');
  } catch (error) {
    telemetry.setAccountType(accountType);
    telemetry.emitCompletion('failure');
    throw error;
  }
}

const currentModulePath = typeof __filename === 'string' ? __filename : '';
const entrypoint = process.argv[1];

if (entrypoint && currentModulePath === entrypoint) {
  runCli().catch((error) => {
    const message = formatUserSafeError(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

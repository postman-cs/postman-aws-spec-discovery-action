import * as core from '@actions/core';

import { contractOutputNames, type DiscoveredService } from './contracts.js';
import { AwsApiGatewaySdkClient, type AwsGatewayClient } from './lib/aws/client.js';
import {
  defaultWriteSpecFile,
  execute,
  readActionInputs,
  type InputReaderLike,
  type ReporterLike
} from './runtime.js';

export interface CoreLike extends InputReaderLike, ReporterLike {
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
}

export interface GitHubActionDependencies {
  createAwsClient?: (region: string) => AwsGatewayClient;
  writeSpecFile?: (outputPath: string, content: string) => Promise<void>;
}

export async function runAction(
  actionCore: CoreLike = core,
  dependencies: GitHubActionDependencies = {}
): Promise<DiscoveredService[]> {
  const inputs = readActionInputs(actionCore);
  const awsClient = dependencies.createAwsClient?.(inputs.awsRegion) ?? new AwsApiGatewaySdkClient(inputs.awsRegion);
  const result = await execute(inputs, {
    core: actionCore,
    aws: awsClient,
    writeSpecFile: dependencies.writeSpecFile ?? defaultWriteSpecFile
  });

  for (const [name, value] of Object.entries(result.outputs)) {
    actionCore.setOutput(name, value);
  }

  actionCore.info(
    result.mode === 'discover-many'
      ? `Discovered ${result.discovered.length} service(s)`
      : `Resolution status: ${result.resolution?.status ?? 'unresolved'} (${result.resolution?.sourceType ?? 'manual-review'})`
  );

  return result.discovered;
}

const currentModulePath = typeof __filename === 'string' ? __filename : '';
const entrypoint = process.argv[1];

if (entrypoint && currentModulePath === entrypoint) {
  runAction().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);
  });
}

export * from './runtime.js';
export const outputNames = contractOutputNames;

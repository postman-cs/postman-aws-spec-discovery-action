// GitHub Action shell -- see runtime.ts for the core execution logic (execute, resolveInputs).
import * as core from '@actions/core';

import { contractOutputNames, type DiscoveredService } from './contracts.js';
import { AwsApiGatewaySdkClient, type AwsGatewayClient } from './lib/aws/client.js';
import { formatUserSafeError } from './lib/logging/sanitize.js';
import { ProviderRegistry } from './lib/providers/registry.js';
import { ApiGatewayProvider } from './lib/providers/api-gateway.js';
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
  providerRegistry?: ProviderRegistry;
}

export async function runAction(
  actionCore: CoreLike = core,
  dependencies: GitHubActionDependencies = {}
): Promise<DiscoveredService[]> {
  const inputs = readActionInputs(actionCore);
  const awsClient =
    dependencies.createAwsClient?.(inputs.awsRegion) ??
    new AwsApiGatewaySdkClient(inputs.awsRegion, {
      requestTimeoutMs: inputs.requestTimeoutMs,
      maxAttempts: inputs.maxAttempts
    });

  // When a custom AWS client is injected (tests), build a minimal registry with only API Gateway
  // to avoid probing real AWS services. In production, omit providerRegistry so execute() auto-detects.
  let providerRegistry = dependencies.providerRegistry;
  if (!providerRegistry && dependencies.createAwsClient) {
    providerRegistry = new ProviderRegistry();
    providerRegistry.register(new ApiGatewayProvider(awsClient, { includeV2: inputs.includeV2, apiFilter: inputs.apiFilter }));
  }

  const result = await execute(inputs, {
    core: actionCore,
    aws: awsClient,
    writeSpecFile: dependencies.writeSpecFile ?? defaultWriteSpecFile,
    providerRegistry
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
    const message = formatUserSafeError(error);
    core.setFailed(message);
  });
}

export * from './runtime.js';
export {
  normalizeOpenApiYaml,
  type OperationIdRename,
  type NormalizeOpenApiResult
} from './lib/spec/normalize-openapi.js';
export { collectRepoSignals } from './lib/repo/signals.js';
export { detectCatalogApis } from './lib/repo/catalog.js';
export { LambdaUrlProvider } from './lib/providers/lambda-url.js';
export { CloudFormationProvider } from './lib/providers/cloudformation.js';
export { AppSyncEventsProvider } from './lib/providers/appsync-events.js';
export { EventBridgeSurfaceProvider } from './lib/providers/eventbridge-surfaces.js';
export { BedrockActionGroupProvider } from './lib/providers/bedrock-action-groups.js';
export { AlbListenerRulesProvider } from './lib/providers/alb-listener-rules.js';
export { LambdaEventSourceProvider } from './lib/providers/lambda-event-source.js';
export { VerifiedPermissionsProvider } from './lib/providers/verified-permissions.js';
export { StepFunctionsProvider } from './lib/providers/step-functions.js';
export type { LambdaSpecClient } from './lib/aws/lambda-client.js';
export type { AppSyncEventsSpecClient } from './lib/aws/appsync-events-client.js';
export type { EventBridgeSurfaceSpecClient } from './lib/aws/eventbridge-client.js';
export type { BedrockActionGroupsSpecClient } from './lib/aws/bedrock-agent-client.js';
export type { AlbListenerRulesSpecClient } from './lib/aws/alb-client.js';
export type { LambdaEventSourceSpecClient } from './lib/aws/lambda-event-source-client.js';
export type { VerifiedPermissionsSpecClient } from './lib/aws/verified-permissions-client.js';
export type { StepFunctionsSpecClient } from './lib/aws/step-functions-client.js';
export {
  synthesizeWebSocketOpenApi,
  type WebSocketOpenApiInput,
  type WebSocketRouteSummary
} from './lib/spec/websocket-openapi.js';
export { synthesizeRestApiFallbackOpenApi } from './lib/spec/rest-api-fallback-openapi.js';
export {
  deriveOpenApiDocument,
  type OpenApiDerivationInput,
  type OpenApiDerivationResult
} from './lib/spec/oas-derivation.js';
export const outputNames = contractOutputNames;

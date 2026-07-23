// GitHub Action shell -- see runtime.ts for the core execution logic (execute, resolveInputs).
import * as core from '@actions/core';

import { contractOutputNames, type DiscoveredService } from './contracts.js';
import { AwsApiGatewaySdkClient, type AwsGatewayClient } from './lib/aws/client.js';
import { formatUserSafeError } from './lib/logging/sanitize.js';
import { appendAmbiguityStepSummary } from './lib/logging/step-summary.js';
import { ProviderRegistry } from './lib/providers/registry.js';
import { ApiGatewayProvider } from './lib/providers/api-gateway.js';
import {
  defaultWriteSpecFile,
  execute,
  getInput,
  readActionInputs,
  type InputReaderLike,
  type ReporterLike
} from './runtime.js';
import {
  prepareTelemetryCredentials,
  resolveTelemetryTeamId
} from './lib/postman/telemetry-credentials.js';
import { createTelemetryContext } from '@postman-cse/automation-telemetry-core';
import { resolveActionVersion } from './action-version.js';

export interface CoreLike extends InputReaderLike, ReporterLike {
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
  setSecret?(value: string): void;
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
  const telemetry = createTelemetryContext({ action: 'postman-aws-spec-discovery-action', actionVersion: resolveActionVersion(), logger: actionCore });
  telemetry.setTeamId(resolveTelemetryTeamId(process.env));
  const postmanApiKey = getInput('postman-api-key');
  const postmanAccessToken = getInput('postman-access-token');
  if (postmanApiKey) {
    actionCore.setSecret?.(postmanApiKey);
  }
  if (postmanAccessToken) {
    actionCore.setSecret?.(postmanAccessToken);
  }
  // Optional telemetry enrichment (D1): mint/re-mint access token when PMAK is
  // present, resolve account_type once, best-effort, before either completion emit.
  const { accountType } = await prepareTelemetryCredentials({
    postmanApiKey,
    postmanAccessToken,
    onToken: (token) => actionCore.setSecret?.(token),
    onWarning: (message) => actionCore.warning(message)
  });
  try {
    const result = await runActionInner(actionCore, dependencies);
    telemetry.setAccountType(accountType);
    telemetry.emitCompletion('success');
    return result;
  } catch (error) {
    telemetry.setAccountType(accountType);
    telemetry.emitCompletion('failure');
    throw error;
  }
}

async function runActionInner(
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

  const ambiguityResolution = result.resolution;
  if (
    result.mode !== 'discover-many' &&
    ambiguityResolution?.status === 'unresolved' &&
    (ambiguityResolution.rankedCandidates?.length ?? 0) >= 2
  ) {
    await appendAmbiguityStepSummary(
      {
        status: ambiguityResolution.status,
        sourceType: ambiguityResolution.sourceType,
        narrowingTier: ambiguityResolution.narrowing?.tier ?? 'none',
        candidates: ambiguityResolution.rankedCandidates ?? [],
        probes: ambiguityResolution.providerProbes ?? []
      },
      process.env,
      (message) => actionCore.warning(message)
    );
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
  auditOpenApiContractCoverage,
  formatOpenApiContractAuditWarning,
  normalizeOpenApiYaml,
  type OperationIdRename,
  type NormalizeOpenApiResult
} from './lib/spec/normalize-openapi.js';
export { collectRepoSignals } from './lib/repo/signals.js';
export { detectCatalogApis } from './lib/repo/catalog.js';
export { LambdaUrlProvider } from './lib/providers/lambda-url.js';
export { CloudFormationProvider } from './lib/providers/cloudformation.js';
export { AppSyncEventsProvider } from './lib/providers/appsync-events.js';
export { AppSyncProvider } from './lib/providers/appsync.js';
export { EventBridgeSurfaceProvider } from './lib/providers/eventbridge-surfaces.js';
export { BedrockActionGroupProvider } from './lib/providers/bedrock-action-groups.js';
export { AlbListenerRulesProvider } from './lib/providers/alb-listener-rules.js';
export { LambdaEventSourceProvider } from './lib/providers/lambda-event-source.js';
export { VerifiedPermissionsProvider } from './lib/providers/verified-permissions.js';
export { StepFunctionsProvider } from './lib/providers/step-functions.js';
export type { LambdaSpecClient } from './lib/aws/lambda-client.js';
export type { AppSyncEventsSpecClient } from './lib/aws/appsync-events-client.js';
export { AppSyncSdkClient } from './lib/aws/appsync-client.js';
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
export { mergeRestApiModelsAndValidators, synthesizeRestApiFallbackOpenApi } from './lib/spec/rest-api-fallback-openapi.js';
export {
  deriveOpenApiDocument,
  type OpenApiDerivationInput,
  type OpenApiDerivationResult
} from './lib/spec/oas-derivation.js';
export const outputNames = contractOutputNames;

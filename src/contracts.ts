import type { SnsContractOrigin } from './lib/providers/sns.js';

export interface ActionInputContract {
  description: string;
  required: boolean;
  default?: string;
}

export interface ActionOutputContract {
  description: string;
}

export interface AwsSpecDiscoveryActionContract {
  name: string;
  description: string;
  inputs: Record<string, ActionInputContract>;
  outputs: Record<string, ActionOutputContract>;
}

export type GatewayType = 'REST' | 'HTTP' | 'WEBSOCKET' | 'SNS' | 'LAMBDA_URL';

export type ActionMode = 'resolve-one' | 'discover-many';

export type ResolutionStatus = 'resolved' | 'unresolved';

export type SourceType =
  | 'repo-spec'
  | 'gateway-export'
  | 'appsync-schema'
  | 'appsync-event-api'
  | 'eventbridge-schema'
  | 'eventbridge-surface'
  | 'cfn-embedded'
  | 'glue-schema'
  | 'bedrock-action-group'
  | 'alb-listener-rule'
  | 'sns-contract'
  | 'ssm-registry'
  | 'lambda-url-export'
  | 'lambda-event-source'
  | 'verified-permissions-schema'
  | 'step-functions-asl'
  | 'manual-review'
  | 'discover-many';

export type ProviderType =
  | 'api-gateway'
  | 'appsync'
  | 'appsync-events'
  | 'eventbridge-schemas'
  | 'eventbridge'
  | 'cloudformation'
  | 'glue'
  | 'bedrock-action-group'
  | 'alb-listener-rule'
  | 'sns'
  | 'ssm'
  | 'lambda-url'
  | 'lambda-event-source'
  | 'verified-permissions'
  | 'step-functions';

export type SpecFormat =
  | 'openapi-yaml'
  | 'openapi-json'
  | 'graphql-sdl'
  | 'graphql-introspection-json'
  | 'asyncapi-yaml'
  | 'asyncapi-json'
  | 'json-schema'
  | 'postman-collection'
  | 'smithy'
  | 'avro'
  | 'protobuf'
  | 'wsdl'
  | 'mcp-json';

export type DerivedOpenApiVersion = '3.0.3' | '3.1.0';

export type DerivedOpenApiCompleteness = 'full' | 'partial';

export type DerivedOpenApiFormat = 'openapi-json' | 'openapi-yaml';

export interface OpenApiContractAudit {
  schemaVersion: 1;
  status: 'schema-complete' | 'schema-incomplete';
  operationCount: number;
  responseCount: number;
  responsesWithoutContent: number;
  responseMediaTypesWithoutSchema: number;
  requestMediaTypesWithoutSchema: number;
  defaultOnlyOperationCount: number;
}

export interface ResolvedServiceCandidate {
  serviceName: string;
  gatewayId: string;
  gatewayType: GatewayType;
  stage?: string;
  confidence: number;
  evidence: string[];
  ambiguous?: boolean;
}

export type ConfigurationMode = 'deployed-stage' | 'latest-configuration' | 'partial-control-plane';

export interface AppSyncSourceAssociationProvenance {
  associationId?: string;
  sourceApiId?: string;
  associationStatus?: string;
  denied?: boolean;
}

export interface DeployedSourceProvenance {
  partition?: string;
  /** Redacted account identity indicator (for example `***9012`); never a raw 12-digit account ID. */
  accountIndicator?: string;
  region?: string;
  apiArn?: string;
  apiId?: string;
  protocol?: string;
  configurationMode?: ConfigurationMode;
  stage?: string;
  deploymentId?: string;
  exportOptions?: Record<string, unknown>;
  sourceTier?: string;
  sourceTagContract?: string;
  queryTimestamp?: string;
  artifactHash?: string;
  providerProbes?: ProviderProbeResult[];
  truncation?: {
    truncated: boolean;
    reason?: string;
  };
  appsyncSourceAssociations?: AppSyncSourceAssociationProvenance[];
  appsyncAssociationEvidence?: 'complete' | 'partial' | 'denied';
}

export interface ResolutionResult {
  status: ResolutionStatus;
  sourceType: SourceType;
  serviceName: string;
  confidence: number;
  specPath?: string;
  gatewayId?: string;
  gatewayType?: GatewayType;
  providerType?: ProviderType;
  specFormat?: SpecFormat;
  contractOrigin?: SnsContractOrigin;
  metadataPath?: string;
  variantCount?: number;
  stage?: string;
  provenance?: DeployedSourceProvenance;
  derivedOpenApiPath?: string;
  derivedOpenApiVersion?: DerivedOpenApiVersion;
  derivedOpenApiCompleteness?: DerivedOpenApiCompleteness;
  derivedOpenApiFormat?: DerivedOpenApiFormat;
  derivedOpenApiEvidence?: string[];
  openapiContractAudit?: OpenApiContractAudit;
  narrowing?: NarrowingMetadata;
  providerProbes?: ProviderProbeResult[];
  rankedCandidates?: AmbiguousCandidateView[];
  evidence: string[];
}

export interface NarrowingMetadata {
  tier: string;
  mode: 'select' | 'narrow';
  droppedCount: number;
}

export type ProviderProbeReason = 'iam' | 'timeout' | 'error';

export interface ProviderProbeResult {
  provider: ProviderType;
  status: 'available' | 'skipped';
  reason?: ProviderProbeReason;
}

export interface AmbiguousCandidateView {
  rank: number;
  serviceName: string;
  gatewayId: string;
  gatewayType: GatewayType;
  confidence: number;
  evidence: string[];
}

export interface DiscoveredService {
  serviceName: string;
  specPath: string;
  gatewayId: string;
  gatewayType: GatewayType;
  stage: string;
  providerType?: ProviderType;
  specFormat?: SpecFormat;
  contractOrigin?: SnsContractOrigin;
  metadataPath?: string;
  variantCount?: number;
  provenance?: DeployedSourceProvenance;
  derivedOpenApiPath?: string;
  derivedOpenApiVersion?: DerivedOpenApiVersion;
  derivedOpenApiCompleteness?: DerivedOpenApiCompleteness;
  derivedOpenApiFormat?: DerivedOpenApiFormat;
  derivedOpenApiEvidence?: string[];
  openapiContractAudit?: OpenApiContractAudit;
}

export const actionContract: AwsSpecDiscoveryActionContract = {
  name: 'postman-aws-spec-discovery-action',
  description: 'Resolve the best API spec source for the current service repository.',
  inputs: {
    'aws-region': {
      description: 'AWS region used to resolve API Gateway, AppSync, SNS, EventBridge, Lambda, and other discovery providers.',
      required: true
    },
    'gateway-id': {
      description: 'Optional known API Gateway ID for this service. Use this when you want to bypass broader account discovery.',
      required: false,
      default: ''
    },
    stage: {
      description: 'Optional API Gateway stage override (for example prod or staging).',
      required: false,
      default: ''
    },
    'expected-account-id': {
      description:
        'Optional AWS account ID that must match sts:GetCallerIdentity before export. Mismatch fails closed with a sanitized error.',
      required: false,
      default: ''
    },
    'expected-partition': {
      description:
        'Optional AWS partition (aws, aws-us-gov, or aws-cn) that must match the caller identity ARN before export. Mismatch fails closed with a sanitized error.',
      required: false,
      default: ''
    },
    'expected-region': {
      description:
        'Optional AWS region that must exactly match aws-region before discovery or export. Mismatch fails closed.',
      required: false,
      default: ''
    },
    'spec-path': {
      description:
        'Optional explicit path to a repository specification relative to repo-root. When set, resolution uses this contract and skips same-tier auto-selection.',
      required: false,
      default: ''
    },
    'service-root': {
      description:
        'Optional monorepo service root relative to repo-root. Scopes Backstage entities and repository contract inventory to that directory.',
      required: false,
      default: ''
    },
    'remote-fetch-allowlist-json': {
      description:
        'Optional JSON array of exact remote-fetch allowlist entries ({"hostname","pathPrefix"} or {"host","path"}). Absent or empty denies all remote spec fetches (Backstage, SSM, SNS).',
      required: false,
      default: ''
    },
    'terraform-state-paths-json': {
      description:
        'Optional JSON array of repo-relative local Terraform state/output artifact paths (for example terraform.tfstate). Default []. .tfstate is never auto-discovered; only listed paths are read. Remote Terraform state remains forbidden.',
      required: false,
      default: '[]'
    },
    'output-dir': {
      description: 'Directory under the repository root where generated specs are written.',
      required: false,
      default: 'discovered-specs'
    },
    'postman-api-key': {
      description:
        'Optional service-account PMAK used to mint or re-mint a postman-access-token for telemetry enrichment (account_type). Not used for any AWS or Postman asset operation.',
      required: false,
      default: ''
    },
    'postman-access-token': {
      description:
        'Optional Postman service-account access token, used only to enrich anonymous telemetry with the session account_type. When omitted, postman-api-key alone can mint one for the same purpose. Not used for any AWS or Postman asset operation.',
      required: false,
      default: ''
    }
  },
  outputs: {
    'resolution-json': {
      description: 'JSON resolution result describing status, source type, confidence, and evidence.'
    },
    'resolution-status': {
      description: 'Resolution status: resolved or unresolved.'
    },
    'source-type': {
      description:
        'Resolved source type: repo-spec, gateway-export, appsync-schema, appsync-event-api, eventbridge-schema, eventbridge-surface, cfn-embedded, glue-schema, bedrock-action-group, alb-listener-rule, sns-contract, ssm-registry, lambda-url-export, lambda-event-source, verified-permissions-schema, step-functions-asl, manual-review, or discover-many.'
    },
    'mapping-confidence': {
      description: 'Numeric confidence score for selected service candidate.'
    },
    'spec-path': {
      description: 'Path to resolved or generated specification when available.'
    },
    'gateway-id': {
      description: 'Resolved API Gateway ID when available.'
    },
    'service-name': {
      description: 'Resolved service name.'
    },
    'services-json': {
      description: 'Legacy discover-many output: JSON array of exported services.'
    },
    'service-count': {
      description: 'Legacy discover-many output: number of exported services.'
    },
    'export-summary-json': {
      description:
        'discover-many summary JSON containing attempted, exported, failed, and skipped counts.'
    },
    'candidates-json': {
      description:
        'JSON array of top candidates when resolution is ambiguous. Useful for downstream decision-making or Job Summary rendering.'
    },
    'provider-type': {
      description:
        'Provider that resolved the spec: api-gateway, appsync, appsync-events, eventbridge-schemas, eventbridge, cloudformation, glue, bedrock-action-group, alb-listener-rule, sns, ssm, lambda-url, lambda-event-source, verified-permissions, or step-functions.'
    },
    'spec-format': {
      description:
        'Format of the resolved spec: openapi-yaml, openapi-json, graphql-sdl, graphql-introspection-json, asyncapi-yaml, asyncapi-json, json-schema, postman-collection, smithy, avro, protobuf, wsdl, or mcp-json.'
    },
    'contract-origin': {
      description:
        'SNS contract provenance when available: repo-asyncapi, repo-json-schema, generated-asyncapi, ssm-content, ssm-url, catalog-url, eventbridge-derived, code-derived, or manual-review.'
    },
    'contract-metadata-path': {
      description: 'Path to SNS resolution metadata sidecar when available.'
    },
    'variant-count': {
      description: 'Number of SNS delivery variants discovered when available.'
    },
    'derived-openapi-path': {
      description: 'Path to the canonical derived OpenAPI JSON sidecar when available.'
    },
    'derived-openapi-version': {
      description: 'OpenAPI version of the derived sidecar when available.'
    },
    'derived-openapi-completeness': {
      description: 'Derived OpenAPI completeness: full or partial.'
    },
    'derived-openapi-format': {
      description: 'Format of the derived OpenAPI sidecar, currently openapi-json.'
    },
    'derived-openapi-evidence-json': {
      description: 'JSON array of evidence entries explaining derived OpenAPI quality and limitations.'
    },
    'narrowing-strategy': {
      description:
        'Progressive narrowing tier applied to API Gateway candidates (iac-fingerprint, cfn-correlation, tag-prefilter, naming-heuristic), or none when no tier matched.'
    }
  }
};

export const contractInputNames = Object.keys(actionContract.inputs);
export const contractOutputNames = Object.keys(actionContract.outputs);

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

export type GatewayType = 'REST' | 'HTTP' | 'WEBSOCKET' | 'SNS';

export type ActionMode = 'resolve-one' | 'discover-many';

export type ResolutionStatus = 'resolved' | 'unresolved';

export type SourceType =
  | 'repo-spec'
  | 'gateway-export'
  | 'appsync-schema'
  | 'eventbridge-schema'
  | 'cfn-embedded'
  | 'glue-schema'
  | 'sns-contract'
  | 'ssm-registry'
  | 'manual-review'
  | 'discover-many';

export type ProviderType =
  | 'api-gateway'
  | 'appsync'
  | 'eventbridge-schemas'
  | 'cloudformation'
  | 'glue'
  | 'sns'
  | 'ssm';

export type SpecFormat =
  | 'openapi-yaml'
  | 'openapi-json'
  | 'graphql-sdl'
  | 'asyncapi-yaml'
  | 'asyncapi-json'
  | 'json-schema'
  | 'avro'
  | 'protobuf';

export interface ResolvedServiceCandidate {
  serviceName: string;
  gatewayId: string;
  gatewayType: GatewayType;
  stage?: string;
  confidence: number;
  evidence: string[];
  ambiguous?: boolean;
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
  stage?: string;
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
}

export const actionContract: AwsSpecDiscoveryActionContract = {
  name: 'postman-aws-spec-discovery-action',
  description: 'Resolve the best API spec source for the current service repository.',
  inputs: {
    'aws-region': {
      description: 'AWS region used to resolve API Gateway resources',
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
    'output-dir': {
      description: 'Directory under the repository root where generated specs are written.',
      required: false,
      default: 'discovered-specs'
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
        'Resolved source type: repo-spec, gateway-export, appsync-schema, eventbridge-schema, cfn-embedded, glue-schema, sns-contract, ssm-registry, manual-review, or discover-many.'
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
        'Provider that resolved the spec: api-gateway, appsync, eventbridge-schemas, cloudformation, glue, sns, or ssm.'
    },
    'spec-format': {
      description:
        'Format of the resolved spec: openapi-yaml, openapi-json, graphql-sdl, asyncapi-yaml, asyncapi-json, json-schema, avro, or protobuf.'
    }
  }
};

export const contractInputNames = Object.keys(actionContract.inputs);
export const contractOutputNames = Object.keys(actionContract.outputs);

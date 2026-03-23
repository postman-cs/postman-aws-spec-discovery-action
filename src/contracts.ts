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

export type GatewayType = 'REST' | 'HTTP';

export interface DiscoveredService {
  projectName: string;
  specPath: string;
  gatewayId: string;
  gatewayType: GatewayType;
  stage: string;
}

export const actionContract: AwsSpecDiscoveryActionContract = {
  name: 'postman-aws-spec-discovery-action',
  description: 'Discover API Gateway APIs and export OpenAPI 3.0 specs for downstream onboarding.',
  inputs: {
    'aws-region': {
      description: 'AWS region to scan for API Gateway instances',
      required: true
    },
    stage: {
      description:
        'API Gateway stage to export (e.g., prod, staging). When empty, exports the first available stage.',
      required: false,
      default: ''
    },
    'api-filter': {
      description: 'Regex pattern to filter API Gateway names. Only matching APIs are exported.',
      required: false,
      default: ''
    },
    'service-mapping-json': {
      description: 'JSON map of API Gateway ID to project-name for explicit naming override.',
      required: false,
      default: '{}'
    },
    'output-dir': {
      description: 'Directory to write discovered spec files.',
      required: false,
      default: 'discovered-specs'
    },
    'include-v2': {
      description: 'Whether to include HTTP API (v2) gateways in addition to REST APIs.',
      required: false,
      default: 'true'
    }
  },
  outputs: {
    'services-json': {
      description:
        'JSON array of discovered services with projectName, specPath, gatewayId, gatewayType, and stage.'
    },
    'service-count': {
      description: 'Total number of discovered and exported services.'
    }
  }
};

export const contractInputNames = Object.keys(actionContract.inputs);
export const contractOutputNames = Object.keys(actionContract.outputs);

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

export type ActionMode = 'resolve-one' | 'discover-many';

export type ResolutionStatus = 'resolved' | 'unresolved';

export type SourceType = 'repo-spec' | 'gateway-export' | 'manual-review' | 'discover-many';

export interface ResolvedServiceCandidate {
  serviceName: string;
  gatewayId: string;
  gatewayType: GatewayType;
  stage: string;
  confidence: number;
  evidence: string[];
}

export interface ResolutionResult {
  status: ResolutionStatus;
  sourceType: SourceType;
  serviceName: string;
  confidence: number;
  specPath?: string;
  gatewayId?: string;
  gatewayType?: GatewayType;
  stage?: string;
  evidence: string[];
  driftStatus: 'not-checked' | 'clean' | 'drift-detected';
}

export interface DiscoveredService {
  serviceName: string;
  specPath: string;
  gatewayId: string;
  gatewayType: GatewayType;
  stage: string;
}

export const actionContract: AwsSpecDiscoveryActionContract = {
  name: 'postman-aws-spec-discovery-action',
  description: 'Resolve the best API spec source for the current service repository.',
  inputs: {
    mode: {
      description:
        'Execution mode. Auto-defaults to resolve-one when empty; discover-many preserves legacy bulk export behavior.',
      required: false,
      default: 'resolve-one'
    },
    'aws-region': {
      description: 'AWS region used to resolve API Gateway resources',
      required: true
    },
    'repo-url': {
      description: 'Repository URL override (HTTPS or SSH). Auto-detected from CI metadata when empty.',
      required: false,
      default: ''
    },
    'repo-slug': {
      description: 'Repository slug override (for example org/repo or group/project). Auto-detected from CI metadata when empty.',
      required: false,
      default: ''
    },
    'git-provider': {
      description: 'Git provider override (github or gitlab). Auto-detected from CI when empty.',
      required: false,
      default: ''
    },
    ref: {
      description: 'Git ref override. Auto-detected from CI when empty.',
      required: false,
      default: ''
    },
    sha: {
      description: 'Git commit SHA override. Auto-detected from CI when empty.',
      required: false,
      default: ''
    },
    'repo-root': {
      description: 'Repository root path for local file inspection. Defaults to current workspace root when empty.',
      required: false,
      default: '.'
    },
    'expected-service-name': {
      description: 'Optional expected service name hint for resolver scoring.',
      required: false,
      default: ''
    },
    'expected-gateway-ids-json': {
      description: 'Optional JSON array of expected API Gateway IDs.',
      required: false,
      default: '[]'
    },
    stage: {
      description: 'API Gateway stage override (for example prod, staging). Auto-selects the first available stage when empty.',
      required: false,
      default: ''
    },
    'api-filter': {
      description: 'Regex pattern to filter API Gateway names. Only matching APIs are exported.',
      required: false,
      default: ''
    },
    'service-mapping-json': {
      description: 'Legacy discover-many mode only: JSON map of API Gateway ID to service name.',
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
    'resolution-json': {
      description: 'JSON resolution result describing status, source type, confidence, and evidence.'
    },
    'resolution-status': {
      description: 'Resolution status: resolved or unresolved.'
    },
    'source-type': {
      description: 'Resolved source type: repo-spec, gateway-export, manual-review, or discover-many.'
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
    }
  }
};

export const contractInputNames = Object.keys(actionContract.inputs);
export const contractOutputNames = Object.keys(actionContract.outputs);

import type { GatewayType, SpecFormat } from '../../contracts.js';

/** Freshness / authorship class for static IaC candidates. */
export type IacArtifactClass =
  | 'authored'
  | 'generated-fresh'
  | 'generated-stale'
  | 'freshness-unknown';

export type IacSourceKind =
  | 'cloudformation'
  | 'sam'
  | 'cdk'
  | 'terraform'
  | 'serverless';

export type IacCandidateKind =
  | 'openapi-inline'
  | 'openapi-local-ref'
  | 'openapi-s3-ref'
  | 'physical-api-id'
  | 'unresolved-evidence';

export type IacResolutionErrorCode =
  | 'path-escape'
  | 'bounds-exceeded'
  | 'unreadable'
  | 'missing-file'
  | 'unsupported-manifest'
  | 'unresolved-expression'
  | 'sensitive-redacted'
  | 'malformed';

export interface IacResolutionError {
  code: IacResolutionErrorCode;
  path: string;
  message: string;
}

/**
 * Clean candidate API for runtime integration.
 * Content-bearing candidates carry OpenAPI bytes; physical-api-id candidates
 * hand exact REST/v2 IDs to gateway resolution. Unresolved forms never invent routes.
 */
export interface IacSpecCandidate {
  id: string;
  source: IacSourceKind;
  kind: IacCandidateKind;
  artifactClass: IacArtifactClass;
  /** Relative posix path of the primary evidence file. */
  sourcePath: string;
  /** Logical resource / output name when known. */
  logicalId?: string;
  gatewayType?: GatewayType;
  /** Exact physical REST or HTTP API ID when kind is physical-api-id. */
  physicalApiId?: string;
  content?: string;
  format?: SpecFormat;
  filename?: string;
  evidence: string[];
  /** Schema / package version metadata (e.g. CDK assembly version). */
  schemaVersion?: string;
  /** Opaque unresolved intrinsic or expression text preserved as evidence. */
  unresolvedExpression?: string;
}

export interface StaticIacResolution {
  candidates: IacSpecCandidate[];
  /** Exact physical API IDs eligible for gateway handoff. */
  physicalApiIds: string[];
  errors: IacResolutionError[];
}

export interface ResolveStaticIacOptions {
  maxDepth?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxCumulativeBytes?: number;
  /** Optional injected S3 client for exact BodyS3Location / s3:// DefinitionUri refs. */
  s3Client?: {
    getObject(bucket: string, key: string, versionId?: string): Promise<string>;
  };
  /**
   * Optional deployed CloudFormation stack outputs keyed by stack name.
   * Used by Serverless correlation only; never downloads remote state.
   */
  deployedStackOutputs?: Record<string, Record<string, string>>;
  /** Disable individual source classes without code changes. */
  enabledSources?: Partial<Record<IacSourceKind, boolean>>;
}

export const DEFAULT_IAC_BOUNDS = {
  maxDepth: 8,
  maxFiles: 100,
  maxFileBytes: 1_048_576,
  maxCumulativeBytes: 8_388_608
} as const;

/** CDK cloud-assembly schema majors we safely understand. */
export const SUPPORTED_CDK_ASSEMBLY_MAJOR_MAX = 48;

export const API_RESOURCE_TYPES = {
  'AWS::ApiGateway::RestApi': 'REST',
  'AWS::Serverless::Api': 'REST',
  'AWS::ApiGatewayV2::Api': 'HTTP',
  'AWS::Serverless::HttpApi': 'HTTP'
} as const satisfies Record<string, GatewayType>;

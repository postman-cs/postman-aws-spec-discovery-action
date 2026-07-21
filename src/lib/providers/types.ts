import type {
  DeployedSourceProvenance,
  DerivedOpenApiCompleteness,
  OpenApiContractAudit,
  ProviderType,
  SpecFormat
} from '../../contracts.js';

export type { ProviderProbeReason, ProviderProbeResult } from '../../contracts.js';

export interface ProviderProbeSummary {
  availableProviders: SpecProvider[];
  probes: import('../../contracts.js').ProviderProbeResult[];
}

export interface SpecCandidate {
  id: string;
  name: string;
  providerType: ProviderType;
  tags: Record<string, string>;
  evidence: string[];
  meta: Record<string, string>;
}

export interface ExportOptions {
  stage?: string;
  dryRun?: boolean;
  resolutionContext?: {
    serviceHints?: string[];
    bridgeEvidence?: string[];
  };
}

/**
 * Authoritative definition member already owned by a provider/repo source set.
 * Never used for metadata, derived OpenAPI, webhook sidecars, or service config.
 */
export interface SpecDefinitionArtifact {
  /** Path relative to the service export folder (POSIX, no `..`). */
  relativePath: string;
  content: string;
  role: 'root' | 'dependency';
}

export interface SpecExportResult {
  content: string;
  format: SpecFormat;
  filename: string;
  stage?: string;
  evidence: string[];
  provenance?: DeployedSourceProvenance;
  derivedOpenApiCompleteness?: DerivedOpenApiCompleteness;
  openapiContractAudit?: OpenApiContractAudit;
  /**
   * Generic non-definition companions (SNS metadata, webhook OpenAPI, pointers).
   * Never included in `spec-files-json`.
   */
  sidecars?: Array<{
    filename: string;
    content: string;
  }>;
  /**
   * Provider/repo-owned definition members for multi-file closures.
   * Emitted into `spec-files-json` only when completeness is `full` and size > 1.
   */
  definitionArtifacts?: SpecDefinitionArtifact[];
  definitionCompleteness?: 'full' | 'partial';
}

export interface SpecProvider {
  readonly type: ProviderType;
  /** Return true if the caller has the IAM permissions needed for this provider. */
  probe(): Promise<boolean>;
  listCandidates(): Promise<SpecCandidate[]>;
  exportSpec(candidate: SpecCandidate, options: ExportOptions): Promise<SpecExportResult>;
}
import type { DerivedOpenApiCompleteness, ProviderType, SpecFormat } from '../../contracts.js';

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

export interface SpecExportResult {
  content: string;
  format: SpecFormat;
  filename: string;
  stage?: string;
  evidence: string[];
  derivedOpenApiCompleteness?: DerivedOpenApiCompleteness;
  sidecars?: Array<{
    filename: string;
    content: string;
  }>;
}

export interface SpecProvider {
  readonly type: ProviderType;
  /** Return true if the caller has the IAM permissions needed for this provider. */
  probe(): Promise<boolean>;
  listCandidates(): Promise<SpecCandidate[]>;
  exportSpec(candidate: SpecCandidate, options: ExportOptions): Promise<SpecExportResult>;
}

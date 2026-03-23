import type { ResolutionResult, ResolvedServiceCandidate } from '../../contracts.js';

export interface SourceSelectionInput {
  existingSpecPath?: string;
  candidate?: ResolvedServiceCandidate;
  fallbackServiceName?: string;
}

export function chooseSource(input: SourceSelectionInput): ResolutionResult {
  if (input.existingSpecPath) {
    return {
      status: 'resolved',
      sourceType: 'repo-spec',
      serviceName: input.candidate?.serviceName ?? input.fallbackServiceName ?? 'unknown-service',
      confidence: input.candidate ? Math.max(80, input.candidate.confidence) : 70,
      specPath: input.existingSpecPath,
      gatewayId: input.candidate?.gatewayId,
      gatewayType: input.candidate?.gatewayType,
      stage: input.candidate?.stage,
      evidence: ['Resolved from existing repository specification', ...(input.candidate?.evidence ?? [])]
    };
  }

  if (input.candidate && !input.candidate.ambiguous && input.candidate.confidence >= 40) {
    return {
      status: 'resolved',
      sourceType: 'gateway-export',
      serviceName: input.candidate.serviceName,
      confidence: input.candidate.confidence,
      gatewayId: input.candidate.gatewayId,
      gatewayType: input.candidate.gatewayType,
      stage: input.candidate.stage,
      evidence: input.candidate.evidence
    };
  }

  return {
    status: 'unresolved',
    sourceType: 'manual-review',
    serviceName: input.candidate?.serviceName ?? input.fallbackServiceName ?? 'unknown-service',
    confidence: input.candidate?.confidence ?? 0,
    gatewayId: input.candidate?.gatewayId,
    gatewayType: input.candidate?.gatewayType,
    stage: input.candidate?.stage,
    evidence: input.candidate?.evidence ?? ['No matching source found']
  };
}

import type { ResolutionResult, ResolvedServiceCandidate } from '../../contracts.js';
import type { SnsContractOrigin } from '../providers/sns.js';

export interface SourceSelectionInput {
  existingSpecPath?: string;
  candidate?: ResolvedServiceCandidate;
  snsCandidate?: SnsResolvedCandidate;
  fallbackServiceName?: string;
}

export interface SnsResolvedCandidate {
  serviceName: string;
  topicArn: string;
  confidence: number;
  origin?: SnsContractOrigin | 'unknown';
  specFormat: 'asyncapi-yaml' | 'asyncapi-json' | 'json-schema';
  evidence: string[];
}

const MINIMUM_RESOLVED_CONFIDENCE = 40;

function isResolvedGatewayCandidate(candidate: ResolvedServiceCandidate | undefined): candidate is ResolvedServiceCandidate {
  return Boolean(candidate && !candidate.ambiguous && candidate.confidence >= MINIMUM_RESOLVED_CONFIDENCE);
}

function isResolvedSnsCandidate(candidate: SnsResolvedCandidate | undefined): candidate is SnsResolvedCandidate {
  return Boolean(candidate && candidate.confidence >= MINIMUM_RESOLVED_CONFIDENCE);
}

function isRepoLocalSnsOrigin(origin: SnsResolvedCandidate['origin']): boolean {
  return origin === 'repo-asyncapi' || origin === 'repo-json-schema';
}

function manualReviewEvidence(input: SourceSelectionInput): string[] {
  const evidence = [...(input.candidate?.evidence ?? []), ...(input.snsCandidate?.evidence ?? [])];
  return evidence.length > 0 ? evidence : ['No matching source found'];
}

export function chooseSource(input: SourceSelectionInput): ResolutionResult {
  const hasGatewayCandidate = Boolean(input.candidate);
  const hasSnsCandidate = Boolean(input.snsCandidate);
  const bestObservedConfidence = Math.max(input.candidate?.confidence ?? 0, input.snsCandidate?.confidence ?? 0);

  if (input.existingSpecPath) {
    return {
      status: 'resolved',
      sourceType: 'repo-spec',
      serviceName: input.candidate?.serviceName ?? input.snsCandidate?.serviceName ?? input.fallbackServiceName ?? 'unknown-service',
      confidence: hasGatewayCandidate || hasSnsCandidate ? Math.max(80, bestObservedConfidence) : 70,
      specPath: input.existingSpecPath,
      gatewayId: input.candidate?.gatewayId,
      gatewayType: input.candidate?.gatewayType,
      stage: input.candidate?.stage,
      evidence: ['Resolved from existing repository specification', ...(input.candidate?.evidence ?? [])]
    };
  }

  const resolvedGateway = isResolvedGatewayCandidate(input.candidate) ? input.candidate : undefined;
  const resolvedSns = isResolvedSnsCandidate(input.snsCandidate) ? input.snsCandidate : undefined;

  if (resolvedGateway && resolvedSns) {
    if (resolvedSns.confidence > resolvedGateway.confidence) {
      return {
        status: 'resolved',
        sourceType: 'sns-contract',
        serviceName: resolvedSns.serviceName,
        confidence: resolvedSns.confidence,
        gatewayId: resolvedSns.topicArn,
        gatewayType: 'SNS',
        providerType: 'sns',
        specFormat: resolvedSns.specFormat,
        evidence: resolvedSns.evidence
      };
    }

    if (resolvedGateway.confidence > resolvedSns.confidence || !isRepoLocalSnsOrigin(resolvedSns.origin)) {
      return {
        status: 'resolved',
        sourceType: 'gateway-export',
        serviceName: resolvedGateway.serviceName,
        confidence: resolvedGateway.confidence,
        gatewayId: resolvedGateway.gatewayId,
        gatewayType: resolvedGateway.gatewayType,
        stage: resolvedGateway.stage,
        evidence: resolvedGateway.evidence
      };
    }

    return {
      status: 'resolved',
      sourceType: 'sns-contract',
      serviceName: resolvedSns.serviceName,
      confidence: resolvedSns.confidence,
      gatewayId: resolvedSns.topicArn,
      gatewayType: 'SNS',
      providerType: 'sns',
      specFormat: resolvedSns.specFormat,
      evidence: resolvedSns.evidence
    };
  }

  if (resolvedGateway) {
    return {
      status: 'resolved',
      sourceType: 'gateway-export',
      serviceName: resolvedGateway.serviceName,
      confidence: resolvedGateway.confidence,
      gatewayId: resolvedGateway.gatewayId,
      gatewayType: resolvedGateway.gatewayType,
      stage: resolvedGateway.stage,
      evidence: resolvedGateway.evidence
    };
  }

  if (resolvedSns) {
    return {
      status: 'resolved',
      sourceType: 'sns-contract',
      serviceName: resolvedSns.serviceName,
      confidence: resolvedSns.confidence,
      gatewayId: resolvedSns.topicArn,
      gatewayType: 'SNS',
      providerType: 'sns',
      specFormat: resolvedSns.specFormat,
      evidence: resolvedSns.evidence
    };
  }

  return {
    status: 'unresolved',
    sourceType: 'manual-review',
    serviceName: input.fallbackServiceName ?? 'unknown-service',
    confidence: bestObservedConfidence,
    gatewayId: input.candidate?.gatewayId ?? input.snsCandidate?.topicArn,
    gatewayType: input.candidate?.gatewayType ?? (input.snsCandidate?.topicArn ? 'SNS' : undefined),
    stage: input.candidate?.stage,
    evidence: manualReviewEvidence(input)
  };
}

import type { GatewayType, ResolvedServiceCandidate } from '../../contracts.js';
import type { RepoSignals } from '../repo/signals.js';

export interface GatewayCandidateInput {
  id: string;
  name: string;
  gatewayType: GatewayType;
  tags: Record<string, string>;
  evidence?: string[];
}

function includesIgnoreCase(value: string, candidates: string[]): boolean {
  const v = value.toLowerCase();
  return candidates.some((candidate) => candidate.toLowerCase() === v);
}

function scoreCandidate(candidate: GatewayCandidateInput, signals: RepoSignals): { score: number; evidence: string[] } {
  let score = 0;
  const evidence: string[] = [];

  if (includesIgnoreCase(candidate.id, signals.explicitGatewayIdHints)) {
    score += 100;
    evidence.push(`Matched explicit gateway ID ${candidate.id}`);
  } else if (includesIgnoreCase(candidate.id, signals.inferredGatewayIdHints)) {
    score += 25;
    evidence.push(`Matched inferred gateway ID ${candidate.id}`);
  }

  const serviceHints = signals.serviceHints.map((hint) => hint.toLowerCase());
  if (serviceHints.some((hint) => hint && candidate.name.toLowerCase().includes(hint))) {
    score += 30;
    evidence.push(`Gateway name "${candidate.name}" matches service hint`);
  }

  const tagValues = Object.values(candidate.tags).map((value) => value.toLowerCase());
  if (serviceHints.some((hint) => hint && tagValues.some((tag) => tag.includes(hint)))) {
    score += 40;
    evidence.push('Gateway tags match service hint');
  }

  return { score, evidence };
}

function toResolved(candidate: GatewayCandidateInput, signals: RepoSignals, score: number, evidence: string[]): ResolvedServiceCandidate {
  const mergedEvidence = [...signals.evidence, ...(candidate.evidence ?? []), ...evidence];
  const serviceName =
    (candidate.tags['postman:project-name'] ?? '').trim() ||
    (candidate.tags.Name ?? '').trim() ||
    candidate.name;
  return {
    serviceName,
    gatewayId: candidate.id,
    gatewayType: candidate.gatewayType,
    confidence: score,
    evidence: mergedEvidence.length > 0 ? mergedEvidence : ['No strong resolver evidence found']
  };
}

/**
 * Deterministic ranking of every gateway candidate.
 * Sort: confidence descending, then gatewayId ascending. This is the single source of
 * truth for candidate ordering; resolveServiceCandidate() consumes it so the ranked view
 * surfaced for ambiguity can never diverge from resolution.
 */
export function rankServiceCandidates(
  gateways: GatewayCandidateInput[],
  signals: RepoSignals
): ResolvedServiceCandidate[] {
  const ranked = gateways.map((candidate) => {
    const scored = scoreCandidate(candidate, signals);
    return toResolved(candidate, signals, scored.score, scored.evidence);
  });
  ranked.sort((left, right) => right.confidence - left.confidence || (left.gatewayId < right.gatewayId ? -1 : left.gatewayId > right.gatewayId ? 1 : 0));
  return ranked;
}

export function resolveServiceCandidate(
  gateways: GatewayCandidateInput[],
  signals: RepoSignals
): ResolvedServiceCandidate | undefined {
  const ranked = rankServiceCandidates(gateways, signals);
  if (ranked.length === 0) return undefined;
  const best = ranked[0];
  // Equal top confidence across more than one candidate is ambiguous.
  const tied = ranked.filter((candidate) => candidate.confidence === best.confidence);
  if (tied.length > 1 && best.confidence > 0) {
    best.ambiguous = true;
    best.evidence = [
      ...best.evidence,
      `Ambiguous match: ${tied.map((candidate) => candidate.gatewayId).join(' and ')} have equal confidence ${best.confidence}`
    ];
  }
  return best;
}

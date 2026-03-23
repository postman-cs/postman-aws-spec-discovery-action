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

  return {
    score,
    evidence
  };
}

export function resolveServiceCandidate(
  gateways: GatewayCandidateInput[],
  signals: RepoSignals
): ResolvedServiceCandidate | undefined {
  let best: ResolvedServiceCandidate | undefined;

  for (const candidate of gateways) {
    const scored = scoreCandidate(candidate, signals);
    const mergedEvidence = [...signals.evidence, ...(candidate.evidence ?? []), ...scored.evidence];
    const serviceName =
      (candidate.tags['postman:project-name'] ?? '').trim() ||
      (candidate.tags.Name ?? '').trim() ||
      candidate.name;
    const resolved: ResolvedServiceCandidate = {
      serviceName,
      gatewayId: candidate.id,
      gatewayType: candidate.gatewayType,
      confidence: scored.score,
      evidence: mergedEvidence.length > 0 ? mergedEvidence : ['No strong resolver evidence found']
    };
    if (!best || resolved.confidence > best.confidence || (resolved.confidence === best.confidence && resolved.gatewayId < best.gatewayId)) {
      best = resolved;
    } else if (best && resolved.confidence === best.confidence && resolved.confidence > 0) {
      best.ambiguous = true;
      best.evidence = [
        ...best.evidence,
        `Ambiguous match: ${best.gatewayId} and ${resolved.gatewayId} have equal confidence ${resolved.confidence}`
      ];
    }
  }

  return best;
}

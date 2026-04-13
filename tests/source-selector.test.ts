import { describe, expect, it } from 'vitest';

import type { ResolvedServiceCandidate } from '../src/contracts.js';
import { chooseSource } from '../src/lib/resolve/source-selector.js';

function createGatewayCandidate(overrides: Partial<ResolvedServiceCandidate> = {}): ResolvedServiceCandidate {
  return {
    serviceName: 'payments-gateway',
    gatewayId: 'gw-123',
    gatewayType: 'REST',
    confidence: 60,
    evidence: ['gateway-evidence'],
    ...overrides
  };
}

function createSnsCandidate(
  overrides: Partial<{
    serviceName: string;
    topicArn: string;
    confidence: number;
    origin: 'repo-asyncapi' | 'repo-json-schema' | 'ssm-content' | 'unknown';
    specFormat: 'asyncapi-yaml' | 'asyncapi-json' | 'json-schema';
    evidence: string[];
  }> = {}
) {
  return {
    serviceName: 'payments-sns',
    topicArn: 'arn:aws:sns:us-east-1:123456789012:payments-events',
    confidence: 60,
    origin: 'repo-asyncapi' as const,
    specFormat: 'asyncapi-yaml' as const,
    evidence: ['sns-evidence'],
    ...overrides
  };
}

describe('chooseSource (source-agnostic)', () => {
  it('prefers repo spec over gateway and sns candidates', () => {
    const result = chooseSource({
      existingSpecPath: 'openapi.yaml',
      candidate: createGatewayCandidate({ confidence: 95 }),
      snsCandidate: createSnsCandidate({ confidence: 99 })
    });

    expect(result.sourceType).toBe('repo-spec');
    expect(result.specPath).toBe('openapi.yaml');
    expect(result.confidence).toBe(99);
  });

  it('chooses higher-confidence gateway over sns', () => {
    const result = chooseSource({
      candidate: createGatewayCandidate({ confidence: 90 }),
      snsCandidate: createSnsCandidate({ confidence: 60 })
    });

    expect(result.sourceType).toBe('gateway-export');
    expect(result.serviceName).toBe('payments-gateway');
  });

  it('chooses higher-confidence sns over gateway and propagates sns metadata', () => {
    const result = chooseSource({
      candidate: createGatewayCandidate({ confidence: 60 }),
      snsCandidate: createSnsCandidate({
        confidence: 90,
        serviceName: 'payments-events',
        topicArn: 'arn:aws:sns:us-east-1:123456789012:payments-events',
        specFormat: 'json-schema'
      })
    });

    expect(result.sourceType).toBe('sns-contract');
    expect(result.serviceName).toBe('payments-events');
    expect(result.providerType).toBe('sns');
    expect(result.specFormat).toBe('json-schema');
    expect(result.gatewayType).toBe('SNS');
    expect(result.gatewayId).toBe('arn:aws:sns:us-east-1:123456789012:payments-events');
  });

  it('uses tie-break matrix: repo-local sns wins ties, ssm/unknown lose ties to gateway', () => {
    const repoAsyncApi = chooseSource({
      candidate: createGatewayCandidate({ confidence: 80 }),
      snsCandidate: createSnsCandidate({ confidence: 80, origin: 'repo-asyncapi' })
    });
    const repoJsonSchema = chooseSource({
      candidate: createGatewayCandidate({ confidence: 80 }),
      snsCandidate: createSnsCandidate({ confidence: 80, origin: 'repo-json-schema' })
    });
    const ssm = chooseSource({
      candidate: createGatewayCandidate({ confidence: 80 }),
      snsCandidate: createSnsCandidate({ confidence: 80, origin: 'ssm-content' })
    });
    const unknown = chooseSource({
      candidate: createGatewayCandidate({ confidence: 80 }),
      snsCandidate: createSnsCandidate({ confidence: 80, origin: 'unknown' })
    });

    expect(repoAsyncApi.sourceType).toBe('sns-contract');
    expect(repoJsonSchema.sourceType).toBe('sns-contract');
    expect(ssm.sourceType).toBe('gateway-export');
    expect(unknown.sourceType).toBe('gateway-export');
  });

  it('selects a single resolved source when only one exists', () => {
    const gatewayOnly = chooseSource({
      candidate: createGatewayCandidate({ confidence: 80 })
    });
    const snsOnly = chooseSource({
      snsCandidate: createSnsCandidate({ confidence: 80 })
    });

    expect(gatewayOnly.sourceType).toBe('gateway-export');
    expect(snsOnly.sourceType).toBe('sns-contract');
  });

  it('returns manual-review with combined evidence when neither source resolves', () => {
    const result = chooseSource({
      candidate: createGatewayCandidate({
        confidence: 20,
        evidence: ['gateway-sub-threshold']
      }),
      snsCandidate: createSnsCandidate({
        confidence: 0,
        evidence: ['sns-unresolved']
      }),
      fallbackServiceName: 'fallback-service'
    });

    expect(result.status).toBe('unresolved');
    expect(result.sourceType).toBe('manual-review');
    expect(result.serviceName).toBe('fallback-service');
    expect(result.evidence).toEqual(expect.arrayContaining(['gateway-sub-threshold', 'sns-unresolved']));
  });

  it('treats ambiguous gateway as unresolved and defers to sns or manual-review', () => {
    const withSns = chooseSource({
      candidate: createGatewayCandidate({ confidence: 90, ambiguous: true }),
      snsCandidate: createSnsCandidate({ confidence: 60 })
    });
    const withoutSns = chooseSource({
      candidate: createGatewayCandidate({ confidence: 90, ambiguous: true }),
      fallbackServiceName: 'fallback-service'
    });

    expect(withSns.sourceType).toBe('sns-contract');
    expect(withoutSns.sourceType).toBe('manual-review');
  });

  it('treats sub-threshold gateway as unresolved and defers to sns or manual-review', () => {
    const withSns = chooseSource({
      candidate: createGatewayCandidate({ confidence: 39 }),
      snsCandidate: createSnsCandidate({ confidence: 61 })
    });
    const withoutSns = chooseSource({
      candidate: createGatewayCandidate({ confidence: 39 }),
      fallbackServiceName: 'fallback-service'
    });

    expect(withSns.sourceType).toBe('sns-contract');
    expect(withoutSns.sourceType).toBe('manual-review');
  });

  it('preserves legacy behavior when snsCandidate is omitted or undefined', () => {
    const omitted = chooseSource({
      candidate: createGatewayCandidate({ confidence: 80 })
    });
    const explicitUndefined = chooseSource({
      candidate: createGatewayCandidate({ confidence: 80 }),
      snsCandidate: undefined
    });

    expect(omitted).toEqual(explicitUndefined);
    expect(omitted.sourceType).toBe('gateway-export');
  });

  it('is deterministic and stateless for identical input', () => {
    const input = {
      candidate: createGatewayCandidate({ confidence: 75 }),
      snsCandidate: createSnsCandidate({ confidence: 75, origin: 'repo-asyncapi' })
    };

    const first = chooseSource(input);
    const second = chooseSource(input);

    expect(first).toEqual(second);
  });
});

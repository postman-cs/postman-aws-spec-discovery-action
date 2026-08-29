import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { classifySpecContent, looksLikeWsdl } from '../src/lib/spec/classify-format.js';
import { extractXmlSchemaDependencyRefs } from '../src/lib/spec/definition-file-inventory.js';

function expectLinearTime(operation: () => unknown): void {
  const started = performance.now();
  operation();
  expect(performance.now() - started).toBeLessThan(500);
}

describe('spec parser complexity bounds', () => {
  it('recognizes a WSDL root after XML declarations and comments', () => {
    expect(looksLikeWsdl([
      '<?xml version="1.0"?>',
      '<!-- generated contract -->',
      '<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/">',
      '</wsdl:definitions>'
    ].join('\n'))).toBe(true);
  });

  it('bounds malformed WSDL root scanning', () => {
    expectLinearTime(() => expect(looksLikeWsdl('<a'.repeat(100_000))).toBe(false));
  });

  it('bounds protobuf service scanning when rpc is absent', () => {
    expectLinearTime(() => {
      expect(classifySpecContent('service a{'.repeat(20_000))?.format).not.toBe('protobuf');
    });
  });

  it('bounds GraphQL scanning across unterminated description lines', () => {
    expectLinearTime(() => {
      expect(classifySpecContent('"""\n'.repeat(50_000))).toBeUndefined();
    });
  });

  it('bounds malformed XML dependency scanning', () => {
    expectLinearTime(() => {
      expect(extractXmlSchemaDependencyRefs('<import '.repeat(25_000))).toEqual([]);
    });
  });
});

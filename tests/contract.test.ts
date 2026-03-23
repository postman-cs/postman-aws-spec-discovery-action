import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { actionContract, contractInputNames, contractOutputNames } from '../src/contracts.js';
import { resolveInputs } from '../src/index.js';

const repoRoot = resolve(import.meta.dirname, '..');
const actionManifest = parse(
  readFileSync(resolve(repoRoot, 'action.yml'), 'utf8')
) as {
  inputs: Record<string, { required?: boolean; default?: string }>;
  outputs: Record<string, unknown>;
};

describe('action contract', () => {
  it('keeps action.yml aligned with declared contract', () => {
    expect(Object.keys(actionManifest.inputs)).toEqual(contractInputNames);
    expect(Object.keys(actionManifest.outputs)).toEqual(contractOutputNames);
  });

  it('keeps expected defaults for optional inputs', () => {
    expect(actionContract.inputs['service-mapping-json'].default).toBe('{}');
    expect(actionContract.inputs['output-dir'].default).toBe('discovered-specs');
    expect(actionContract.inputs['include-v2'].default).toBe('true');
    expect(actionManifest.inputs['service-mapping-json'].default).toBe('{}');
    expect(actionManifest.inputs['output-dir'].default).toBe('discovered-specs');
    expect(actionManifest.inputs['include-v2'].default).toBe('true');
  });

  it('parses include-v2 and service mapping values from inputs', () => {
    const parsed = resolveInputs({
      INPUT_AWS_REGION: 'us-east-1',
      INPUT_INCLUDE_V2: 'false',
      INPUT_SERVICE_MAPPING_JSON: '{"a1":"payments"}',
      INPUT_OUTPUT_DIR: 'custom-dir'
    });

    expect(parsed.awsRegion).toBe('us-east-1');
    expect(parsed.includeV2).toBe(false);
    expect(parsed.serviceMapping).toEqual({ a1: 'payments' });
    expect(parsed.outputDir).toBe('custom-dir');
  });
});

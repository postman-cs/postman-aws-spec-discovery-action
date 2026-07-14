import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');

/**
 * P3 drift gate (.plans/e2e-suite-tuneup.md): the CLI maintains a hard-coded
 * input-name array (CLI_INPUT_NAMES) separate from action.yml. The CLI is a
 * deliberate SUPERSET of the action manifest: repo-scan / expected-service
 * discovery modes are CLI-only surfaces (driven by the e2e harness and local
 * runs), not action inputs. Assert both directions with that explicit
 * allowlist so new manifest inputs cannot ship without a CLI flag and new CLI
 * flags must either join the manifest or be added here deliberately.
 */

const CLI_ONLY_INPUTS = [
  'mode',
  'repo-url',
  'repo-slug',
  'git-provider',
  'ref',
  'sha',
  'repo-root',
  'expected-service-name',
  'expected-gateway-ids-json',
  'api-filter',
  'service-mapping-json',
  'max-candidates',
  'dry-run',
  'preflight-checks',
  'preflight-permission-probe',
  'request-timeout-ms',
  'max-attempts',
  'include-v2'
];

function actionManifestInputs(): string[] {
  const manifest = parse(readFileSync(resolve(repoRoot, 'action.yml'), 'utf8')) as {
    inputs?: Record<string, unknown>;
  };
  return Object.keys(manifest.inputs ?? {});
}

function cliInputNames(): string[] {
  const source = readFileSync(resolve(repoRoot, 'src/cli.ts'), 'utf8');
  const match = source.match(/const CLI_INPUT_NAMES = \[([^\]]*)\]/);
  if (!match) throw new Error('CLI_INPUT_NAMES array not found in src/cli.ts');
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

describe('action.yml <-> CLI flag parity', () => {
  it('every action.yml input has a CLI flag', () => {
    const cli = new Set(cliInputNames());
    const missing = actionManifestInputs().filter((name) => !cli.has(name));
    expect(missing).toEqual([]);
  });

  it('every CLI input flag is an action.yml input, minus the explicit CLI-only allowlist', () => {
    const manifest = new Set(actionManifestInputs());
    const extras = cliInputNames().filter(
      (name) => !manifest.has(name) && !CLI_ONLY_INPUTS.includes(name)
    );
    expect(extras).toEqual([]);
  });

  it('keeps the CLI-only allowlist minimal: every entry is a real CLI flag and not a manifest input', () => {
    const cli = new Set(cliInputNames());
    const manifest = new Set(actionManifestInputs());
    expect(CLI_ONLY_INPUTS.filter((name) => !cli.has(name))).toEqual([]);
    expect(CLI_ONLY_INPUTS.filter((name) => manifest.has(name))).toEqual([]);
  });
});

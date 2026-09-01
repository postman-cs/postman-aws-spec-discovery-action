import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const workflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

/** Extract one top-level job block: `  <id>:` through the next job header or EOF. */
function jobText(source: string, jobId: string): string {
  const jobsBody = source.match(/^jobs:\n([\s\S]*)$/m)?.[1] ?? '';
  const header = `  ${jobId}:\n`;
  const start = jobsBody.indexOf(header);
  if (start < 0) return '';
  const rest = jobsBody.slice(start + header.length);
  const nextJob = rest.search(/^ {2}[a-zA-Z0-9_-]+:\n/m);
  return header + (nextJob < 0 ? rest : rest.slice(0, nextJob));
}

function namedStep(source: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`      - name: ${escapedName}\\n[\\s\\S]*?(?=\\n      - |\\n?$)`));
  return match?.[0] ?? '';
}

/** Ordered gate names launched via `run <name> ...` (excludes the `run()` helper definition). */
function linuxQueuedGates(runGates: string): string[] {
  return [...runGates.matchAll(/^\s+run ([a-zA-Z0-9_-]+)\s+/gm)].map((m) => m[1]!);
}

const linux = jobText(workflow, 'gate');
const distParity = jobText(workflow, 'dist-parity');
const ready = jobText(workflow, 'ready');
const windows = jobText(workflow, 'windows');

describe('CI workflow contract', () => {
  it('keeps independent Linux/Windows jobs with no needs edges and adds dist-parity + ready aggregation', () => {
    const jobsSection = workflow.slice(workflow.indexOf('\njobs:\n'));
    const jobMatches = jobsSection.match(/^ {2}[a-zA-Z0-9_-]+:$/gm) ?? [];
    expect(jobMatches).toEqual(['  gate:', '  dist-parity:', '  windows:', '  ready:']);
    expect(linux).not.toMatch(/^\s*needs:/m);
    expect(windows).not.toMatch(/^\s*needs:/m);
    expect(distParity).toMatch(/^\s*needs:\s*gate\s*$/m);
    expect(ready).toContain('needs: [gate, dist-parity, windows]');
    expect(ready).toContain('if: always()');
  });

  it('supersedes PRs only and bundles once before bounded Linux gates', () => {
    expect(workflow).toContain('group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}');
    expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");

    expect(linux.match(/^\s*- run: npm run bundle\s*$/gm) ?? []).toHaveLength(1);
    expect(linux.indexOf('- run: npm run bundle')).toBeLessThan(linux.indexOf('- name: Run gates'));

    const runGates = namedStep(linux, 'Run gates');
    expect(runGates).toContain('MAX_PARALLEL_GATES=2');
    expect(runGates).toContain('while [ "${#pid[@]}" -ge "$MAX_PARALLEL_GATES" ]; do finish_one; done');
    expect(runGates).toContain('while [ "${#pid[@]}" -gt 0 ]; do finish_one; done');
    expect(runGates).toContain('wait -n -p finished_pid');

    expect(linuxQueuedGates(runGates)).toEqual([
      'lint',
      'typecheck',
      'test',
      'dist-shape',
      'actionlint',
      'docs-pins',
      'commitlint',
    ]);
    expect(runGates).toContain('run lint       npm run lint');
    expect(runGates).toContain('run typecheck  npm run typecheck');
    expect(runGates).toContain('run test       npm test');
    expect(runGates).toContain('run dist-shape npm run verify:dist:shape');
    expect(runGates).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(runGates).toContain('run docs-pins  npm run docs:pins');
    expect(runGates).toContain('if [ "${{ github.event_name }}" = "pull_request" ]; then');
    expect(runGates).toContain('run commitlint npx commitlint \\');
    expect(runGates).toContain('--from "${{ github.event.pull_request.base.sha }}"');
    expect(runGates).toContain('--to "${{ github.event.pull_request.head.sha }}"');

    expect(runGates).toContain('gate:$n=pass');
    expect(runGates).toContain('gate:$n=fail');
    expect(runGates).toContain('::group::$n');
    expect(runGates).toContain('exit $fail');

    expect(runGates).not.toContain('verify:dist:assert');
    expect(runGates).not.toContain('verify:dist:parity');
    expect(runGates).not.toMatch(/npm run verify:dist(?:\s|$|"|')/);
  });

  it('runs the budgeted AWS emulator transport lane after the gate fan-out, Linux only', () => {
    const lane = namedStep(linux, 'AWS emulator transport lane');
    expect(lane).toContain('docker run -d --rm --name aws-emulator -p 4566:4566');
    expect(lane).toContain('localstack/localstack:4.9');
    expect(lane).not.toContain('localstack:latest');
    expect(workflow).not.toMatch(/^\s*services:/m);
    expect(lane).toContain('curl -sf http://127.0.0.1:4566/_localstack/health');
    expect(lane).toContain('npm run test:emulator:aws');
    expect(lane).toContain('docker rm -f aws-emulator');
    expect(lane).toContain('if [ "$elapsed" -gt 47 ]; then');
    expect(windows).not.toContain('emulator');
    expect(lane.indexOf('docker run')).toBeGreaterThanOrEqual(0);
    expect(linux.indexOf('- name: Run gates')).toBeLessThan(linux.indexOf('- name: AWS emulator transport lane'));
  });

  it('pins actionlint 1.7.11 at $RUNNER_TEMP/actionlint with PR-only commitlint history', () => {
    const ACTIONLINT_DOWNLOADER_COMMIT = '393031adb9afb225ee52ae2ccd7a5af5525e03e8';
    const install = namedStep(linux, 'Install actionlint');
    expect(ACTIONLINT_DOWNLOADER_COMMIT).toHaveLength(40);
    expect(install).toContain(
      `https://raw.githubusercontent.com/rhysd/actionlint/${ACTIONLINT_DOWNLOADER_COMMIT}/scripts/download-actionlint.bash`,
    );
    expect(install.match(/393031adb9afb225ee52ae2ccd7a5af5525e03e8/)?.[0]).toHaveLength(40);
    expect(install).toContain('download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"');
    expect(install).not.toContain('/main/scripts');
    expect(workflow).not.toContain('/main/scripts/download-actionlint.bash');
    expect(install).toContain('ACTIONLINT_BIN="$RUNNER_TEMP/actionlint"');
    expect(install).toContain('"$ACTIONLINT_BIN" -version');
    expect(install).toContain('echo "ACTIONLINT_BIN=$ACTIONLINT_BIN" >> "$GITHUB_ENV"');
    expect(workflow).not.toContain('actions/setup-go');
    expect(workflow).not.toContain('go install github.com/rhysd/actionlint');

    expect(linux).toContain('fetch-depth: 0');
    expect(windows).not.toMatch(/^\s*fetch-depth:\s*/m);
    expect(windows).not.toContain('commitlint');
    expect(windows).not.toContain('actionlint');
  });

  it('preserves the current no-NPM-token policy on both jobs', () => {
    expect(workflow).not.toMatch(/NODE_AUTH_TOKEN\s*:/);
    expect(workflow).not.toContain('secrets.NPM_TOKEN');
    expect(workflow).not.toContain('NPM_TOKEN');
  });

  it('caches Windows node_modules with pinned actions/cache and cache-miss-only install', () => {
    expect(windows).toContain('name: Windows gate');
    expect(windows).toContain('runs-on: windows-latest');
    expect(windows).toContain("node-version: '24'");
    expect(windows).not.toMatch(/^\s*cache:\s*npm\s*$/m);

    expect(windows).toContain('id: windows-node-modules');
    // Semantic pin: any 40-char hex SHA, consistent across file, with semver comment
    {
      const cachePins = [...workflow.matchAll(/actions\/cache@([0-9a-f]{40})/g)].map((m) => m[1]!);
      expect(cachePins.length).toBeGreaterThanOrEqual(1);
      for (const sha of cachePins) expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(new Set(cachePins).size).toBe(1);
      expect(windows).toMatch(/uses:\s*actions\/cache@[0-9a-f]{40}\s+#\s*v\d+\.\d+\.\d+/);
    }
    expect(windows).toContain('path: node_modules');
    expect(windows).toContain("key: Windows/node-24/exact-${{ hashFiles('package-lock.json') }}");
    expect(windows).not.toContain('restore-keys');
    expect(windows).not.toContain('restore-key');
    expect(windows).not.toContain('enableCrossOsArchive');

    expect(windows).toContain("if: steps.windows-node-modules.outputs.cache-hit != 'true'");
    expect(windows).toContain('run: npm ci --prefer-offline --no-audit --no-fund');
    expect(windows.match(/npm ci --prefer-offline --no-audit --no-fund/g) ?? []).toHaveLength(1);
    expect(windows.match(/^\s*- run: npm ci\s*$/gm) ?? []).toHaveLength(0);
  });

  it('runs direct unfiltered node --run test unconditionally and skips only install on cache hit', () => {
    expect(windows.match(/^\s*- run: node --run test\s*$/gm) ?? []).toHaveLength(1);
    expect(windows).not.toMatch(/npm test --/);
    expect(windows).not.toMatch(/npm test -/);

    const stepsAfterCache = windows.slice(windows.indexOf('id: windows-node-modules'));
    expect(stepsAfterCache).toContain('- run: node --run test');
    expect(stepsAfterCache).not.toMatch(/- run: node --run test\n\s+if:/);

    const testIdx = windows.search(/^\s*- run: node --run test\s*$/m);
    const preceding = windows.slice(Math.max(0, testIdx - 80), testIdx);
    expect(preceding).not.toMatch(/if:.*\n\s*- run: node --run test/);
  });

  it('omits Windows build/bundle/lint/typecheck/dist/queue work', () => {
    expect(windows).not.toContain('npm run bundle');
    expect(windows).not.toContain('npm run build');
    expect(windows).not.toContain('npm run lint');
    expect(windows).not.toContain('npm run typecheck');
    expect(windows).not.toContain('verify:dist');
    expect(windows).not.toContain('MAX_PARALLEL_GATES');
    expect(windows).not.toContain('$maxParallelGates');
    expect(windows).not.toContain('Start-Job');
    expect(windows).not.toContain('Wait-Job');
    expect(windows).not.toContain('Receive-Job');
    expect(windows).not.toContain('Run gates');
    expect(windows).not.toContain('shell: pwsh');
    expect(windows).not.toMatch(/@\{ Name = '/);

    // Linux still owns the full gate set; Windows is test-only.
    expect(linux).toContain('npm run bundle');
    expect(linux).toContain('run lint       npm run lint');
    expect(linux).toContain('run typecheck  npm run typecheck');
    expect(linux).toContain('run dist-shape npm run verify:dist:shape');

    const candidate = namedStep(linux, 'Upload candidate dist');
    expect(candidate).toContain('uses: actions/upload-artifact@v7');
    expect(candidate).toContain('name: candidate-dist');
    expect(candidate).toContain('dist/');
    expect(candidate).toContain('dist-manifest.json');
  });

  it('uploads candidate dist from gate and expected-dist from dist-parity on mismatch', () => {
    const candidate = namedStep(linux, 'Upload candidate dist');
    expect(candidate).toContain('uses: actions/upload-artifact@v7');
    expect(candidate).toContain('name: candidate-dist');
    expect(candidate).toContain('dist/');
    expect(candidate).toContain('dist-manifest.json');
    expect(namedStep(linux, 'Write dist manifest')).toContain('lock_hash');
    expect(namedStep(linux, 'Ensure clean tracked tree outside dist')).toContain('git status --porcelain');
    expect(linux).not.toContain('name: expected-dist');

    const upload = namedStep(distParity, 'Upload expected dist on mismatch');
    expect(upload).toContain('if: failure()');
    expect(upload).toContain('uses: actions/upload-artifact@v7');
    expect(upload).toContain('name: expected-dist');
    expect(upload).toContain('path: dist/');
    expect(distParity).toContain('npm run verify:dist:parity');
    expect(distParity).not.toContain('verify:dist:shape');
    expect(distParity).not.toContain('verify:dist:assert');
    expect(distParity).toContain('fetch-depth: 0');
    expect(distParity).toContain('npm run bundle');
  });

  it('aggregates gate, dist-parity, and windows in a required ready job', () => {
    expect(ready).toContain('if: always()');
    expect(ready).toContain('needs.gate.result');
    expect(ready).toContain('needs.dist-parity.result');
    expect(ready).toContain('needs.windows.result');
    expect(ready).toContain('exit 1');
    expect(ready).toContain('CI ready');
  });
});

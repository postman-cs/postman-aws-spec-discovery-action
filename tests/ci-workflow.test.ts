import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

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

/** Exact Windows `Run gates` PowerShell body under `run: |`, with YAML indent stripped. */
function extractWindowsRunGatesBody(source: string): string {
  const windows = jobText(source, 'windows');
  const match = windows.match(/ {6}- name: Run gates\n {8}shell: pwsh\n {8}run: \|\n([\s\S]*)$/);
  if (!match?.[1]) {
    throw new Error('Windows Run gates pwsh body not found');
  }
  return match[1]
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
}

const linux = jobText(workflow, 'gate');
const windows = jobText(workflow, 'windows');

describe('CI workflow contract', () => {
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
      'dist',
      'actionlint',
      'commitlint',
    ]);
    expect(runGates).toContain('run lint       npm run lint');
    expect(runGates).toContain('run typecheck  npm run typecheck');
    expect(runGates).toContain('run test       npm test');
    expect(runGates).toContain('run dist       npm run verify:dist:assert');
    expect(runGates).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(runGates).toContain('if [ "${{ github.event_name }}" = "pull_request" ]; then');
    expect(runGates).toContain('run commitlint npx commitlint \\');
    expect(runGates).toContain('--from "${{ github.event.pull_request.base.sha }}"');
    expect(runGates).toContain('--to "${{ github.event.pull_request.head.sha }}"');

    expect(runGates).toContain('gate:$n=pass');
    expect(runGates).toContain('gate:$n=fail');
    expect(runGates).toContain('::group::$n');
    expect(runGates).toContain('exit $fail');
  });

  it('pins actionlint 1.7.11 at $RUNNER_TEMP/actionlint with PR-only commitlint history', () => {
    const install = namedStep(linux, 'Install actionlint');
    expect(install).toContain('download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"');
    expect(install).toContain('ACTIONLINT_BIN="$RUNNER_TEMP/actionlint"');
    expect(workflow).not.toContain('actions/setup-go');
    expect(workflow).not.toContain('go install github.com/rhysd/actionlint');

    expect(linux).toContain('fetch-depth: 0');
    expect(windows).not.toMatch(/^\s*fetch-depth:\s*/m);
    expect(windows).not.toContain('commitlint');
  });

  it('preserves Windows coverage with a bundle-once bounded queue and native exit propagation', () => {
    expect(windows).toContain('runs-on: windows-latest');
    expect(windows.match(/^\s*- run: npm run bundle\s*$/gm) ?? []).toHaveLength(1);
    expect(windows.indexOf('- run: npm run bundle')).toBeLessThan(windows.indexOf('- name: Run gates'));

    const runGates = namedStep(windows, 'Run gates');
    expect(runGates).toContain('shell: pwsh');
    expect(runGates).toContain("$ErrorActionPreference = 'Stop'");
    expect(runGates).toContain('$maxParallelGates = 2');
    expect(runGates).toContain('while ($jobs.Count -ge $maxParallelGates)');
    expect(runGates).toContain('Start-Job');

    expect(runGates).toContain("@{ Name = 'lint'; Args = @('run', 'lint') }");
    expect(runGates).toContain("@{ Name = 'test'; Args = @('test') }");
    expect(runGates).toContain("@{ Name = 'typecheck'; Args = @('run', 'typecheck') }");
    expect(runGates).toContain("@{ Name = 'dist'; Args = @('run', 'verify:dist:assert') }");
    expect(runGates.match(/@\{ Name = '[^']+'; Args = @[^}]+\}/g) ?? []).toHaveLength(4);

    expect(runGates).not.toContain('Invoke-Expression');
    expect(runGates).toContain('& npm @npmArgs');
    expect(runGates).toContain('if ($LASTEXITCODE -ne 0) { throw "gate failed with exit code $LASTEXITCODE" }');
    expect(runGates).toContain('-ArgumentList (,$check.Args)');
    expect(runGates.match(/Receive-Job -Job \$[^ ]+ -ErrorAction Continue 2>&1 \| Write-Output/g) ?? []).toHaveLength(2);
    expect(runGates).toContain('Write-Output "::group::$($finished.Name)"');
    expect(runGates).toContain('Write-Output "::group::$($job.Name)"');

    expect(runGates).toContain('gate:$($check.Name)=pass');
    expect(runGates).toContain('gate:$($check.Name)=fail');
    expect(runGates).toContain('if ($failed) { exit 1 }');
    expect(runGates).not.toContain('actionlint');
    expect(runGates).not.toContain('commitlint');
  });

  it(
    'drains Windows gate diagnostics before failing the process when npm test exits nonzero',
    () => {
      const script = extractWindowsRunGatesBody(workflow);
      expect(script).toContain('& npm @npmArgs');
      expect(script).not.toContain('Invoke-Expression');

      const fixture = mkdtempSync(join(tmpdir(), 'aws-ci-windows-gates-'));
      try {
        writeFileSync(
          join(fixture, 'package.json'),
          `${JSON.stringify(
            {
              name: 'aws-ci-windows-gates-fixture',
              private: true,
              scripts: {
                lint: 'node -e "console.error(\'benign stderr from passing lint\')"',
                test: 'node -e "process.exit(1)"',
                typecheck: 'node -e "process.exit(0)"',
                'verify:dist:assert': 'node -e "process.exit(0)"',
              },
            },
            null,
            2,
          )}\n`,
        );
        writeFileSync(join(fixture, 'run-gates.ps1'), `${script}\n`);

        const result = spawnSync('pwsh', ['-NoProfile', '-File', 'run-gates.ps1'], {
          cwd: fixture,
          encoding: 'utf8',
          timeout: 30_000,
        });
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

        expect(result.error, output).toBeUndefined();
        expect(result.signal, output).toBeNull();
        expect(result.status, output).not.toBe(0);
        expect(output).toContain('benign stderr from passing lint');
        expect(output).toContain('::group::lint');
        expect(output).toContain('::group::test');
        expect(output).toContain('::group::typecheck');
        expect(output).toContain('::group::dist');
        expect(output).toContain('gate:lint=pass');
        expect(output).toContain('gate:test=fail');
        expect(output).toContain('gate:typecheck=pass');
        expect(output).toContain('gate:dist=pass');
        expect(output).toMatch(/gate:lint=(?:pass|fail)/);
        expect(output).toMatch(/gate:test=(?:pass|fail)/);
        expect(output).toMatch(/gate:typecheck=(?:pass|fail)/);
        expect(output).toMatch(/gate:dist=(?:pass|fail)/);
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

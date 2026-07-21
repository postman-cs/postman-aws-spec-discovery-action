import { mkdtemp, readFile, rm, chmod, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { AmbiguousCandidateView, ProviderProbeResult } from '../src/contracts.js';
import { appendAmbiguityStepSummary, renderAmbiguityStepSummary } from '../src/lib/logging/step-summary.js';
import { sanitizeJsonValue } from '../src/lib/logging/sanitize.js';

const candidates: AmbiguousCandidateView[] = [
  {
    rank: 1,
    serviceName: 'payments-api',
    gatewayId: 'aaaaabbbbb',
    gatewayType: 'REST',
    confidence: 50,
    evidence: ['Gateway name "payments-api" matches service hint']
  },
  {
    rank: 2,
    serviceName: 'payments-api-copy',
    gatewayId: 'ccccdddddd',
    gatewayType: 'REST',
    confidence: 50,
    evidence: ['Gateway name "payments-api-copy" matches service hint']
  }
];

const probes: ProviderProbeResult[] = [
  { provider: 'api-gateway', status: 'available' },
  { provider: 'appsync', status: 'skipped', reason: 'iam' }
];

describe('renderAmbiguityStepSummary', () => {
  it('U3.1 renders the golden markdown shape with one trailing newline', () => {
    const rendered = renderAmbiguityStepSummary({
      status: 'unresolved',
      sourceType: 'manual-review',
      narrowingTier: 'none',
      candidates,
      probes
    });

    expect(rendered).toBe(
      [
        '## Postman AWS spec discovery',
        '',
        '| Field | Value |',
        '| --- | --- |',
        '| Status | `unresolved` |',
        '| Source | `manual-review` |',
        '| Narrowing | `none` |',
        '',
        '### Ranked candidates',
        '',
        '| Rank | Service | Resource | Type | Confidence |',
        '| ---: | --- | --- | --- | ---: |',
        '| 1 | `payments-api` | `aaaaabbbbb` | `REST` | `50` |',
        '| 2 | `payments-api-copy` | `ccccdddddd` | `REST` | `50` |',
        '',
        '### Provider probes',
        '',
        '- `api-gateway`: `available`',
        '- `appsync`: `skipped:iam`'
      ].join('\n') + '\n'
    );
  });

  it('omits the provider probes heading when the probe array is empty', () => {
    const rendered = renderAmbiguityStepSummary({
      status: 'unresolved',
      sourceType: 'manual-review',
      narrowingTier: 'naming-heuristic',
      candidates,
      probes: []
    });
    expect(rendered).not.toContain('### Provider probes');
    expect(rendered).toContain('| Narrowing | `naming-heuristic` |');
    expect(rendered.endsWith('|`\n') || rendered.endsWith('` |\n')).toBe(true);
  });

  it('U3.2 leaks no account IDs or ARNs in JSON or markdown surfaces', () => {
    const dirty: AmbiguousCandidateView[] = [
      {
        rank: 1,
        serviceName: 'svc-123456789012',
        gatewayId: 'aaaaabbbbb',
        gatewayType: 'REST',
        confidence: 40,
        evidence: ['Matched arn:aws:iam::123456789012:role/Test', 'account 123456789012']
      },
      {
        rank: 2,
        serviceName: 'svc-two',
        gatewayId: 'ccccdddddd',
        gatewayType: 'HTTP',
        confidence: 40,
        evidence: []
      }
    ];
    const sanitized = sanitizeJsonValue(dirty);
    const json = JSON.stringify(sanitized);
    const markdown = renderAmbiguityStepSummary({
      status: 'unresolved',
      sourceType: 'manual-review',
      narrowingTier: 'none',
      candidates: dirty,
      probes
    });

    for (const surface of [json, markdown]) {
      expect(surface).not.toMatch(/\b\d{12}\b/);
      expect(surface).not.toMatch(/\barn:aws[a-z-]*:/i);
      expect(surface).toContain('[redacted-');
    }
  });

  it('collapses pipes and newlines inside table cells', () => {
    const rendered = renderAmbiguityStepSummary({
      status: 'unresolved',
      sourceType: 'manual-review',
      narrowingTier: 'none',
      candidates: [
        {
          rank: 1,
          serviceName: 'evil|name\nwith|breaks',
          gatewayId: 'id\r\nnewline',
          gatewayType: 'REST',
          confidence: 10,
          evidence: []
        },
        candidates[1]
      ],
      probes: []
    });
    expect(rendered).toContain('| 1 | `evil name with breaks` | `id  newline` | `REST` | `10` |');
  });
});

describe('appendAmbiguityStepSummary', () => {
  const input = {
    status: 'unresolved',
    sourceType: 'manual-review',
    narrowingTier: 'none',
    candidates,
    probes
  };

  it('U3.4 performs no file operation when GITHUB_STEP_SUMMARY is unset or blank', async () => {
    const warn = vi.fn();
    await appendAmbiguityStepSummary(input, {} as NodeJS.ProcessEnv, warn);
    await appendAmbiguityStepSummary(input, { GITHUB_STEP_SUMMARY: '   ' } as NodeJS.ProcessEnv, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it('appends the rendered summary to the summary file', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-summary-'));
    try {
      const summaryPath = path.join(tempDir, 'summary.md');
      await writeFile(summaryPath, 'existing\n', 'utf8');
      const warn = vi.fn();
      await appendAmbiguityStepSummary(input, { GITHUB_STEP_SUMMARY: summaryPath } as NodeJS.ProcessEnv, warn);
      const content = await readFile(summaryPath, 'utf8');
      expect(content.startsWith('existing\n## Postman AWS spec discovery')).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('U3.5 emits one sanitized warning and does not throw when the path is unwritable', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pm-summary-ro-'));
    try {
      await chmod(tempDir, 0o500);
      const summaryPath = path.join(tempDir, 'blocked', 'summary.md');
      const warn = vi.fn();
      await expect(
        appendAmbiguityStepSummary(input, { GITHUB_STEP_SUMMARY: summaryPath } as NodeJS.ProcessEnv, warn)
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).not.toMatch(/\b\d{12}\b/);
      expect(message).not.toMatch(/\barn:aws[a-z-]*:/i);
    } finally {
      await chmod(tempDir, 0o700);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

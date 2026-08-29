import { appendFile } from 'node:fs/promises';

import type { AmbiguousCandidateView, ProviderProbeResult } from '../../contracts.js';
import { sanitizeLogMessage } from './sanitize.js';

export interface AmbiguityStepSummaryInput {
  status: string;
  sourceType: string;
  narrowingTier: string;
  candidates: AmbiguousCandidateView[];
  probes: ProviderProbeResult[];
}

/** Markdown table cells must never break the table: collapse pipes and newlines to spaces. */
function tableCell(value: string | number): string {
  return String(value).replace(/[|\r\n]/g, ' ');
}

/** Wrap a table value in a code span whose fence cannot be closed by the value. */
function inlineCodeCell(value: string | number): string {
  const content = tableCell(value);
  if (!content) return '` `';
  let longestRun = 0;
  for (const match of content.matchAll(/`+/g)) {
    longestRun = Math.max(longestRun, match[0].length);
  }
  const fence = '`'.repeat(longestRun + 1);
  const padding = content.startsWith('`') || content.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${content}${padding}${fence}`;
}

/**
 * Render the golden ambiguity Step Summary markdown. The full rendered document is
 * sanitized before being returned so no ARN, account ID, or absolute path can leak.
 */
export function renderAmbiguityStepSummary(input: AmbiguityStepSummaryInput): string {
  const lines: string[] = [
    '## Postman AWS spec discovery',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Status | ${inlineCodeCell(input.status)} |`,
    `| Source | ${inlineCodeCell(input.sourceType)} |`,
    `| Narrowing | ${inlineCodeCell(input.narrowingTier)} |`,
    '',
    '### Ranked candidates',
    '',
    '| Rank | Service | Resource | Type | Confidence |',
    '| ---: | --- | --- | --- | ---: |'
  ];
  for (const candidate of input.candidates) {
    lines.push(
      `| ${tableCell(candidate.rank)} | ${inlineCodeCell(candidate.serviceName)} | ${inlineCodeCell(candidate.gatewayId)} | ${inlineCodeCell(candidate.gatewayType)} | ${inlineCodeCell(candidate.confidence)} |`
    );
  }
  if (input.probes.length > 0) {
    lines.push('', '### Provider probes', '');
    for (const probe of input.probes) {
      const status = probe.status === 'skipped' && probe.reason ? `skipped:${probe.reason}` : probe.status;
      lines.push(`- ${inlineCodeCell(probe.provider)}: ${inlineCodeCell(status)}`);
    }
  }
  return `${sanitizeLogMessage(lines.join('\n'))}\n`;
}

/**
 * Append the ambiguity summary to the file named by GITHUB_STEP_SUMMARY.
 * No-op when the variable is unset or blank; append failures emit one sanitized
 * warning and never fail discovery.
 */
export async function appendAmbiguityStepSummary(
  input: AmbiguityStepSummaryInput,
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void
): Promise<void> {
  const summaryPath = (env.GITHUB_STEP_SUMMARY ?? '').trim();
  if (!summaryPath) {
    return;
  }
  try {
    await appendFile(summaryPath, renderAmbiguityStepSummary(input), 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warn(sanitizeLogMessage(`Failed appending ambiguity Step Summary: ${detail}`));
  }
}

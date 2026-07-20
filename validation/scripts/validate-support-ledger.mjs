#!/usr/bin/env node
/* global console, process */
import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  ADVERTISED_LABEL_TO_LEDGER_IDS,
  extractAdvertisedSupport,
  loadSupportLedger,
  renderSupportLedgerMarkdown
} from './lib/support-ledger.mjs';
import { updateEvidenceReadmeSection } from './lib/evidence-readme.mjs';

const repoRoot = process.cwd();
const errors = [];
const warnings = [];

const ledger = await loadSupportLedger(repoRoot);
const rowById = new Map(ledger.rows.map((row) => [row.id, row]));

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  const inline = process.argv.find((value) => value.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : fallback;
}

const summaryPath = arg('summary', 'validation/evidence/README.md');
const liveSummaryPath = path.join(repoRoot, 'validation/evidence/live-validation-summary.json');
const liveSummary = await readFile(liveSummaryPath, 'utf8').then(JSON.parse).catch(() => undefined);
const currentRunLedgerIds = new Set(
  (liveSummary?.requiredCases ?? [])
    .filter((entry) => entry.runClass === 'current-run' && entry.status === 'passed')
    .flatMap((entry) => entry.ledgerIds ?? [])
);
const hasCurrentRunReceipt = (row) => currentRunLedgerIds.has(row.id);

// Required fields
for (const row of ledger.rows) {
  for (const field of [
    'id',
    'method',
    'category',
    'supportLevel',
    'localValidationCase',
    'liveRequirement',
    'liveStatus',
    'artifactCompleteness',
    'rationale'
  ]) {
    if (row[field] === undefined || row[field] === null || row[field] === '') {
      errors.push(`row ${row.id ?? '<missing-id>'} missing ${field}`);
    }
  }
  if (row.supportLevel !== 'intentionally-excluded') {
    if (!Array.isArray(row.implementationSeam) || row.implementationSeam.length === 0) {
      errors.push(`row ${row.id} missing implementationSeam`);
    }
    if (!Array.isArray(row.unitFixtureTests) || row.unitFixtureTests.length === 0) {
      if (row.liveRequirement === 'required' && row.category === 'aws-provider') {
        // still require some test or local case
        if (!row.localValidationCase || row.localValidationCase === 'n/a') {
          errors.push(`row ${row.id} needs unitFixtureTests or localValidationCase`);
        }
      } else if (row.category !== 'intentional-exclusion') {
        warnings.push(`row ${row.id} has empty unitFixtureTests`);
      }
    }
  }
  if (row.liveStatus === 'passed' && row.liveRequirement === 'required' && !row.liveEvidenceRef) {
    errors.push(`row ${row.id} marked passed without liveEvidenceRef`);
  }
  if (row.liveStatus === 'passed' && row.evidenceRunClass === 'current-run' && row.id.startsWith('tag-') && !hasCurrentRunReceipt(row)) {
    errors.push(`row ${row.id} lacks matching current-run sanitized live summary receipt`);
  }
}

// Seam / test path existence
for (const row of ledger.rows) {
  for (const seam of row.implementationSeam ?? []) {
    try {
      await access(path.join(repoRoot, seam));
    } catch {
      errors.push(`row ${row.id} missing seam file ${seam}`);
    }
  }
  for (const testPath of row.unitFixtureTests ?? []) {
    const file = testPath.split('::')[0];
    try {
      await access(path.join(repoRoot, file));
    } catch {
      errors.push(`row ${row.id} missing unit/fixture test file ${file}`);
    }
  }
}

// Advertised README/providers must map to ledger rows with tests/evidence mapping
const readme = await readFile(path.join(repoRoot, 'README.md'), 'utf8');
const providers = await readFile(path.join(repoRoot, 'docs/providers.md'), 'utf8');
const advertised = extractAdvertisedSupport(readme, providers);

for (const section of advertised.sections) {
  const key = section.label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const mapped = ADVERTISED_LABEL_TO_LEDGER_IDS[key];
  if (!mapped) {
    errors.push(`advertised support "${section.label}" (${section.source}) has no ledger mapping`);
    continue;
  }
  for (const id of mapped) {
    const row = rowById.get(id);
    if (!row) {
      errors.push(`advertised "${section.label}" maps to missing ledger id ${id}`);
      continue;
    }
    const hasTest = (row.unitFixtureTests ?? []).length > 0 || (row.localValidationCase && row.localValidationCase !== 'n/a');
    const hasEvidence =
      row.supportLevel === 'intentionally-excluded' ||
      Boolean(row.liveEvidenceRef) ||
      row.liveRequirement === 'not-required';
    if (!hasTest) errors.push(`advertised "${section.label}" -> ${id} lacks test/local validation mapping`);
    if (!hasEvidence) errors.push(`advertised "${section.label}" -> ${id} lacks evidence mapping`);
  }
}

// New live-required rows must not claim passed without historical-preserved or current run
for (const row of ledger.rows) {
  if (row.liveRequirement === 'required' && row.liveStatus === 'passed' && row.evidenceRunClass !== 'historical-preserved' && !hasCurrentRunReceipt(row) && !row.id.startsWith('tag-')) {
    errors.push(`row ${row.id} is live passed without historical-preserved class or matching current-run sanitized summary receipt`);
  }
}

// Keep human ledger generated
const markdown = renderSupportLedgerMarkdown(ledger);
await writeFile(path.join(repoRoot, 'validation/SUPPORT_LEDGER.md'), markdown, 'utf8');

const requiredLive = ledger.rows.filter((row) => row.liveRequirement === 'required');
const notExecuted = requiredLive.filter((row) => row.liveStatus === 'not-executed');
const historical = requiredLive.filter((row) => row.evidenceRunClass === 'historical-preserved');

const summary = [
  '## Support Ledger Enforcement',
  '',
  `- Captured at: ${new Date().toISOString()}`,
  `- Ledger rows: ${ledger.rows.length}`,
  `- Advertised labels checked: ${advertised.sections.length}`,
  `- Required live rows: ${requiredLive.length}`,
  `- Historical preserved live receipts: ${historical.length}`,
  `- Required live not-executed (current-run still needed): ${notExecuted.length}`,
  `- Errors: ${errors.length}`,
  '',
  '| ID | Live req/status | Evidence class |',
  '| --- | --- | --- |',
  ...requiredLive.map(
    (row) =>
      `| ${row.id} | ${row.liveRequirement}/${row.liveStatus} | ${row.evidenceRunClass ?? 'current-or-pending'} |`
  )
].join('\n');

await updateEvidenceReadmeSection(summaryPath, 'support-ledger', summary);

const evidenceJson = {
  capturedAt: new Date().toISOString(),
  rows: ledger.rows.length,
  errors,
  warnings,
  notExecutedLive: notExecuted.map((row) => row.id),
  advertisedLabels: advertised.sections.map((entry) => entry.label)
};
await mkdir(path.join(repoRoot, 'validation/evidence'), { recursive: true });
await writeFile(
  path.join(repoRoot, 'validation/evidence/support-ledger.local.json'),
  `${JSON.stringify(evidenceJson, null, 2)}\n`,
  'utf8'
);

if (errors.length > 0) {
  console.error(JSON.stringify({ status: 'fail', errors, warnings }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: 'ok', rows: ledger.rows.length, warnings, notExecutedLive: notExecuted.length }, null, 2));
}

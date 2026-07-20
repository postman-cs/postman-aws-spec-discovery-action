#!/usr/bin/env node
/* global console, process */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { updateEvidenceReadmeSection } from './lib/evidence-readme.mjs';
import { buildLiveRequiredMatrix, renderLiveRequiredMatrixMarkdown } from './lib/live-required-matrix.mjs';

const repoRoot = process.cwd();
const matrix = await buildLiveRequiredMatrix(repoRoot);
const capturedAt = new Date().toISOString();
const summary = renderLiveRequiredMatrixMarkdown(matrix, { capturedAt });
await updateEvidenceReadmeSection('validation/evidence/README.md', 'live-required-matrix', summary);
await mkdir('validation/evidence', { recursive: true });
await writeFile(
  path.join(repoRoot, 'validation/evidence/live-required-matrix.local.json'),
  `${JSON.stringify({ capturedAt, matrix }, null, 2)}\n`,
  'utf8'
);
console.log(JSON.stringify({
  status: 'ok',
  cases: matrix.length,
  notExecuted: matrix.filter((row) => row.status === 'not-executed').length,
  historicalPreserved: matrix.filter((row) => row.status === 'historical-preserved').length
}, null, 2));

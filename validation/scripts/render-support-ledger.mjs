#!/usr/bin/env node
/* global console, process */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadSupportLedger, renderSupportLedgerMarkdown } from './lib/support-ledger.mjs';

const repoRoot = process.cwd();
const ledger = await loadSupportLedger(repoRoot);
const markdown = renderSupportLedgerMarkdown(ledger);
const outPath = path.join(repoRoot, 'validation/SUPPORT_LEDGER.md');
await writeFile(outPath, markdown, 'utf8');
console.log(JSON.stringify({ status: 'ok', rows: ledger.rows.length, outPath: 'validation/SUPPORT_LEDGER.md' }, null, 2));

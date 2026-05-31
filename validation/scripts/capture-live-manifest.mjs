#!/usr/bin/env node
/* global console, process */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { updateEvidenceReadmeSection } from './lib/evidence-readme.mjs';

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  const inline = process.argv.find((value) => value.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : fallback;
}

function awsJson(args) {
  const output = execFileSync('aws', [...args, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  return JSON.parse(output);
}

const stackName = arg('stack-name', 'spec-discovery-validation');
const region = arg('region', process.env.AWS_REGION ?? 'us-east-1');
const manifestPath = arg('manifest', 'validation/evidence/live-resource-manifest.local.json');
const summaryPath = arg('summary', 'validation/evidence/README.md');

const identity = awsJson(['sts', 'get-caller-identity', '--region', region]);
const stacks = awsJson(['cloudformation', 'describe-stacks', '--stack-name', stackName, '--region', region]);
const stack = stacks.Stacks?.[0];
if (!stack) {
  throw new Error(`Stack not found: ${stackName}`);
}

const outputs = Object.fromEntries((stack.Outputs ?? []).map((entry) => [entry.OutputKey, entry.OutputValue]));
const manifest = {
  capturedAt: new Date().toISOString(),
  stackName,
  region,
  accountId: identity.Account,
  status: stack.StackStatus,
  outputs
};

await mkdir(path.dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const outputKeys = Object.keys(outputs).sort();
const summary = [
  '## Live Resource Summary',
  '',
  `- Captured at: ${manifest.capturedAt}`,
  `- Stack: ${stackName}`,
  `- Region: ${region}`,
  `- Account: ${String(identity.Account ?? '').replace(/\d/g, 'X')}`,
  `- Status: ${stack.StackStatus}`,
  `- Output keys: ${outputKeys.join(', ')}`,
  '',
  'Raw live identifiers are stored only in `live-resource-manifest.local.json`.'
].join('\n');

await updateEvidenceReadmeSection(summaryPath, 'live-resource-summary', summary);
console.log(JSON.stringify({ manifestPath, summaryPath, outputKeys }, null, 2));

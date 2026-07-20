import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const oldIdentifier = 'ListSubscriptionsByTopicCommand2';
const replacementIdentifier = 'SnsListSubsCmd';
const bundles = ['dist/index.cjs', 'dist/cli.cjs'];

for (const bundle of bundles) {
  const file = path.join(root, bundle);
  const source = readFileSync(file, 'utf8');
  const replacements = source.split(oldIdentifier).length - 1;
  if (replacements === 0) {
    throw new Error(`Expected ${bundle} to contain ${oldIdentifier}`);
  }

  const sanitized = source.replaceAll(oldIdentifier, replacementIdentifier);
  if (sanitized.includes(oldIdentifier)) {
    throw new Error(`${bundle} still contains ${oldIdentifier}`);
  }
  writeFileSync(file, sanitized);
}

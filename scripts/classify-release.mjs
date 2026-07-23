import console from 'node:console';
import { appendFileSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * @param {{ ref: string, refName: string, packageVersion: string }} input
 * @returns {{ release_kind: 'immutable' | 'alias', npm_publish: 'true' | 'false' }}
 */
export function classifyRelease({ ref, refName, packageVersion }) {
  const [major, minor, patch] = String(packageVersion).split('.');
  const accepted = `expected v${packageVersion}, v${major}.${minor} when patch is zero, or v${major}`;
  if (!ref?.startsWith('refs/tags/v')) {
    throw new Error(`Release workflow must run from an accepted immutable tag; got ${ref}; ${accepted}`);
  }
  const tagVersion = String(refName ?? '').startsWith('v') ? String(refName).slice(1) : '';
  if (tagVersion === packageVersion || (patch === '0' && tagVersion === `${major}.${minor}`)) {
    return { release_kind: 'immutable', npm_publish: 'true' };
  }
  if (tagVersion === major) {
    return { release_kind: 'alias', npm_publish: 'false' };
  }
  throw new Error(`Release workflow must run from an accepted immutable tag; got ${refName}; ${accepted}`);
}

function writeOutput(key, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error('GITHUB_OUTPUT is required');
  appendFileSync(output, `${key}=${value}\n`);
}

function main() {
  const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const ref = process.env.GITHUB_REF ?? '';
  const refName = process.env.GITHUB_REF_NAME ?? '';
  const result = classifyRelease({ ref, refName, packageVersion });
  writeOutput('release_kind', result.release_kind);
  writeOutput('npm_publish', result.npm_publish);
  if (result.release_kind === 'alias') {
    console.log('::notice::Rolling alias invocation; no release work will run.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${message}`);
    process.exit(1);
  }
}

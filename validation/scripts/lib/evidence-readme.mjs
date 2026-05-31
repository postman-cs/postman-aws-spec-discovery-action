import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function sectionBounds(sectionId) {
  return {
    start: `<!-- evidence:${sectionId}:start -->`,
    end: `<!-- evidence:${sectionId}:end -->`
  };
}

function defaultEvidenceReadme() {
  return [
    '# Validation Evidence',
    '',
    'This is the single customer-safe evidence document for the discovery surfaces documented in `validation/README.md`.',
    '',
    'Raw AWS identifiers, request IDs, credential-bearing output, temporary workspace paths, and `*.local.json` files must stay out of this document.',
    ''
  ].join('\n');
}

export async function updateEvidenceReadmeSection(readmePath, sectionId, content) {
  const { start, end } = sectionBounds(sectionId);
  let existing = await readFile(readmePath, 'utf8').catch(() => defaultEvidenceReadme());
  const section = `${start}\n${content.trim()}\n${end}`;
  const startIndex = existing.indexOf(start);
  const endIndex = existing.indexOf(end);

  if (startIndex >= 0 && endIndex >= startIndex) {
    existing = `${existing.slice(0, startIndex)}${section}${existing.slice(endIndex + end.length)}`;
  } else {
    existing = `${existing.trimEnd()}\n\n${section}\n`;
  }

  await mkdir(path.dirname(readmePath), { recursive: true });
  await writeFile(readmePath, `${existing.trimEnd()}\n`, 'utf8');
}

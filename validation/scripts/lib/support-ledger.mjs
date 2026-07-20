import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function loadSupportLedger(repoRoot) {
  const filePath = path.join(repoRoot, 'validation/support-ledger.json');
  const ledger = JSON.parse(await readFile(filePath, 'utf8'));
  if (!ledger?.rows || !Array.isArray(ledger.rows)) {
    throw new Error('support-ledger.json missing rows[]');
  }
  return ledger;
}

export function renderSupportLedgerMarkdown(ledger) {
  const lines = [
    '# AWS Spec Discovery Support Ledger',
    '',
    ledger.description,
    '',
    `Updated: ${ledger.updatedAt}`,
    '',
    '## Evidence policy',
    '',
    `- ${ledger.evidencePolicy.historicalPreserved}`,
    `- ${ledger.evidencePolicy.notExecuted}`,
    `- ${ledger.evidencePolicy.noSecrets}`,
    '',
    '## Coverage matrix',
    '',
    '| ID | Method | Level | Seam | Unit/fixture test | Local validation | Live req/status | Completeness |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |'
  ];

  for (const row of ledger.rows) {
    const seam = (row.implementationSeam ?? []).join('<br>') || '—';
    const tests = (row.unitFixtureTests ?? []).join('<br>') || '—';
    const live = `${row.liveRequirement}/${row.liveStatus}`;
    lines.push(
      `| \`${row.id}\` | ${row.method} | ${row.supportLevel} | ${seam} | ${tests} | ${row.localValidationCase || '—'} | ${live} | ${row.artifactCompleteness} |`
    );
  }

  lines.push('', '## Intentional exclusions', '');
  for (const row of ledger.rows.filter((entry) => entry.supportLevel === 'intentionally-excluded')) {
    lines.push(`- **${row.method}** (\`${row.id}\`): ${row.rationale}`);
  }

  lines.push('', '## Rationale index', '');
  for (const row of ledger.rows) {
    lines.push(`### \`${row.id}\``, '', row.rationale, '');
  }

  return `${lines.join('\n').trim()}\n`;
}

/** Extract advertised support labels from README + providers.md tables. */
export function extractAdvertisedSupport(readme, providers) {
  const labels = new Set();
  const sections = [];

  const readmeTable = readme.match(/## Supported providers[\s\S]*?(?:\n## |\n*$)/)?.[0] ?? '';
  for (const match of readmeTable.matchAll(/^\| ([^|]+) \|/gm)) {
    const cell = match[1].trim();
    if (cell === 'Provider' || cell.startsWith('---')) continue;
    labels.add(normalizeLabel(cell));
    sections.push({ source: 'README.md#Supported providers', label: cell.trim() });
  }

  const providersTable = providers.match(/## Full provider table[\s\S]*?(?:\n## |\n*$)/)?.[0] ?? '';
  for (const match of providersTable.matchAll(/^\| ([^|]+) \|/gm)) {
    const cell = match[1].trim();
    if (cell === 'Provider' || cell.startsWith('---')) continue;
    labels.add(normalizeLabel(cell));
    sections.push({ source: 'docs/providers.md#Full provider table', label: cell.trim() });
  }

  return { labels: [...labels], sections };
}

function normalizeLabel(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Map advertised labels to ledger row ids that must cover them. */
export const ADVERTISED_LABEL_TO_LEDGER_IDS = {
  'repo local specs': [
    'repo-openapi-3x',
    'repo-swagger-2',
    'repo-graphql-single',
    'repo-asyncapi',
    'repo-postman-collection',
    'repo-json-schema',
    'repo-avro',
    'repo-protobuf',
    'repo-smithy-single'
  ],
  'backstage catalog': ['backstage-local', 'backstage-remote-allowlisted'],
  'api gateway rest http websocket': ['apigw-rest-native', 'apigw-http-deployed-stage', 'apigw-websocket-partial'],
  'api gateway': ['apigw-rest-native', 'apigw-http-deployed-stage', 'apigw-websocket-partial'],
  'api gateway rest': ['apigw-rest-native', 'apigw-rest-fallback'],
  'api gateway http': ['apigw-http-deployed-stage', 'apigw-http-latest-configuration'],
  'api gateway websocket': ['apigw-websocket-partial'],
  'appsync graphql': ['appsync-graphql'],
  'appsync events': ['appsync-events'],
  'eventbridge schema registry': ['eventbridge-schemas'],
  'eventbridge rules pipes and api destinations': ['eventbridge-surfaces'],
  'eventbridge rules pipes api destinations': ['eventbridge-surfaces'],
  'cloudformation embedded specs': ['cloudformation-embedded', 'iac-cfn-sam-static'],
  'glue schema registry': ['glue-schema'],
  'bedrock agent action groups': ['bedrock-action-groups'],
  'alb listener rules': ['alb-listener-rules'],
  'ssm parameter store': ['ssm-registry'],
  'ssm registry': ['ssm-registry'],
  'sns topics': ['sns-contracts'],
  'sns contracts': ['sns-contracts'],
  'lambda function urls': ['lambda-url'],
  'lambda function url': ['lambda-url'],
  'lambda event source mappings': ['lambda-event-source'],
  'verified permissions schemas': ['verified-permissions'],
  'step functions asl': ['step-functions']
};

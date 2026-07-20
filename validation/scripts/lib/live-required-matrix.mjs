import { loadSupportLedger } from './support-ledger.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const REQUIRED_LIVE_CASE_DEFS = [
  {
    id: 'fox-tag-zero-config',
    ledgerIds: ['tag-postman-repo', 'tag-fox-split'],
    description: 'Checked-out Fox-tagged service repo resolves intended gateway with only ambient AWS credentials/region and CI repo identity (no explicit gateway/service input).'
  },
  {
    id: 'fox-multi-environment-ambiguity',
    ledgerIds: ['tag-multi-environment-ambiguity'],
    description: 'Exact multi-environment Fox tag duplicates remain ranked manual-review unless explicit evidence selects one.'
  },
  {
    id: 'api-gateway-rest-native',
    ledgerIds: ['apigw-rest-native'],
    description: 'REST native OpenAPI export.',
    historicalCase: 'api-gateway-rest'
  },
  {
    id: 'api-gateway-rest-fallback',
    ledgerIds: ['apigw-rest-fallback'],
    description: 'REST recognized export-limitation fallback labeled partial.',
    historicalCase: 'api-gateway-rest-fallback'
  },
  {
    id: 'api-gateway-http-deployed-stage',
    ledgerIds: ['apigw-http-deployed-stage'],
    description: 'HTTP export with deployed stage provenance configurationMode=deployed-stage.',
    historicalCase: 'api-gateway-http'
  },
  {
    id: 'api-gateway-http-latest-configuration-divergence',
    ledgerIds: ['apigw-http-latest-configuration', 'stage-evidence-safe-selection'],
    description: 'HTTP no-stage latest-configuration vs deployed-stage after an undeployed change.'
  },
  {
    id: 'api-gateway-websocket-partial-control-plane',
    ledgerIds: ['apigw-websocket-partial'],
    description: 'WebSocket partial control-plane reconstruction.',
    historicalCase: 'api-gateway-websocket'
  },
  {
    id: 'appsync-merged-associations',
    ledgerIds: ['appsync-merged-associations'],
    description: 'AppSync merged API exports SDL once and retains source associations in provenance.'
  },
  {
    id: 'expected-identity-mismatch',
    ledgerIds: ['expected-identity-mismatch'],
    description: 'Wrong expected-account-id / expected-partition fails closed with sanitized error.'
  },
  {
    id: 'provider-denial-typed',
    ledgerIds: ['provider-denial-typed'],
    description: 'Provider IAM denial recorded in resolution-json providerProbes (not silent omission).'
  },
  {
    id: 'all-existing-live-supported-providers',
    ledgerIds: [
      'appsync-graphql',
      'appsync-events',
      'eventbridge-schemas',
      'eventbridge-surfaces',
      'cloudformation-embedded',
      'glue-schema',
      'ssm-registry',
      'sns-contracts',
      'lambda-url',
      'lambda-event-source',
      'bedrock-action-groups',
      'alb-listener-rules',
      'verified-permissions',
      'step-functions'
    ],
    description: 'Refresh current-run evidence for every previously live-supported provider surface.',
    historicalCase: 'live-aws-surfaces-matrix'
  }
];

export async function buildLiveRequiredMatrix(repoRoot, options = {}) {
  const ledger = await loadSupportLedger(repoRoot);
  const byId = new Map(ledger.rows.map((row) => [row.id, row]));
  const currentRunResults = options.currentRunResults ?? {};
  const committedSummary = await readFile(
    path.join(repoRoot, 'validation/evidence/live-validation-summary.json'),
    'utf8'
  ).then(JSON.parse).catch(() => undefined);
  const committedRequiredCases = committedSummary?.schemaVersion === 1 && Array.isArray(committedSummary.requiredCases)
    ? committedSummary.requiredCases
    : [];

  return REQUIRED_LIVE_CASE_DEFS.map((def) => {
    const ledgerRows = def.ledgerIds.map((id) => byId.get(id)).filter(Boolean);
    const current = currentRunResults[def.id];
    if (current?.status === 'passed' || current?.status === 'failed') {
      return {
        id: def.id,
        description: def.description,
        status: current.status,
        runClass: 'current-run',
        evidence: current.evidence ?? '',
        ledgerIds: def.ledgerIds
      };
    }
    const committed = committedRequiredCases.find((entry) =>
      entry?.id === def.id &&
      entry.status === 'passed' &&
      entry.runClass === 'current-run' &&
      Array.isArray(entry.ledgerIds) &&
      def.ledgerIds.every((ledgerId) => entry.ledgerIds.includes(ledgerId))
    );
    if (committed) {
      return {
        id: def.id,
        description: def.description,
        status: 'passed',
        runClass: 'current-run',
        evidence: 'Committed sanitized current live receipt.',
        ledgerIds: def.ledgerIds
      };
    }
    const allHistorical = ledgerRows.length > 0 && ledgerRows.every((row) => row.evidenceRunClass === 'historical-preserved' && row.liveStatus === 'passed');
    const anyNotExecuted = ledgerRows.some((row) => row.liveStatus === 'not-executed');
    return {
      id: def.id,
      description: def.description,
      status: anyNotExecuted ? 'not-executed' : allHistorical ? 'historical-preserved' : 'not-executed',
      runClass: anyNotExecuted ? 'current-run-required' : 'historical-preserved',
      evidence: allHistorical && !anyNotExecuted
        ? `Preserved sanitized receipt via ${def.historicalCase ?? 'live-aws-surfaces'}; not a current-run refresh.`
        : 'Not executed in a current live run; do not advertise as live-validated.',
      ledgerIds: def.ledgerIds
    };
  });
}

export function renderLiveRequiredMatrixMarkdown(matrix, meta = {}) {
  return [
    '## Live Required Cases (current-run gate)',
    '',
    `- Captured at: ${meta.capturedAt ?? new Date().toISOString()}`,
    `- Distinction: historical-preserved rows keep old sanitized receipts; not-executed rows still require a current live run.`,
    `- Cases: ${matrix.length}`,
    `- Current-run passed: ${matrix.filter((row) => row.status === 'passed' && row.runClass === 'current-run').length}`,
    `- Not executed: ${matrix.filter((row) => row.status === 'not-executed').length}`,
    `- Historical preserved only: ${matrix.filter((row) => row.status === 'historical-preserved').length}`,
    '',
    '| Case | Status | Run class | Ledger IDs | Notes |',
    '| --- | --- | --- | --- | --- |',
    ...matrix.map(
      (row) =>
        `| ${row.id} | ${row.status} | ${row.runClass} | ${row.ledgerIds.join(', ')} | ${row.evidence.replace(/\|/g, '/')} |`
    )
  ].join('\n');
}

#!/usr/bin/env node
/* global console, process */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { updateEvidenceReadmeSection } from './lib/evidence-readme.mjs';

const repoRoot = process.cwd();
const distEntry = path.join(repoRoot, 'dist', 'index.cjs');
const fixturePath = 'validation/fixtures/aws/p3-surfaces.json';

if (!existsSync(distEntry)) {
  throw new Error(`Missing bundle at ${distEntry}; run npm run build first`);
}

const {
  AlbListenerRulesProvider,
  AppSyncEventsProvider,
  BedrockActionGroupProvider,
  EventBridgeSurfaceProvider,
  LambdaEventSourceProvider,
  StepFunctionsProvider,
  VerifiedPermissionsProvider
} = await import(distEntry);

const fixture = JSON.parse(await readFile(path.join(repoRoot, fixturePath), 'utf8'));
const evidenceJsonPath = arg('evidence-json', 'validation/evidence/p3-surfaces.local.json');
const summaryPath = arg('summary', 'validation/evidence/README.md');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  const inline = process.argv.find((value) => value.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : fallback;
}

const providers = [
  {
    name: 'eventbridge-rule',
    provider: new EventBridgeSurfaceProvider({
      probe: async () => true,
      listRules: async () => fixture.eventBridge.rules,
      listTargetsByRule: async () => fixture.eventBridge.targets,
      listPipes: async () => [],
      describePipe: async () => fixture.eventBridge.pipeDetail,
      listApiDestinations: async () => []
    }),
    find: (candidates) => candidates.find((candidate) => candidate.meta.surfaceKind === 'rule'),
    check: (doc) => Boolean(doc.webhooks?.['orders-rule']?.post?.['x-aws-eventbridge-event-pattern'])
  },
  {
    name: 'eventbridge-pipe',
    provider: new EventBridgeSurfaceProvider({
      probe: async () => true,
      listRules: async () => [],
      listTargetsByRule: async () => [],
      listPipes: async () => fixture.eventBridge.pipes,
      describePipe: async () => fixture.eventBridge.pipeDetail,
      listApiDestinations: async () => []
    }),
    find: (candidates) => candidates.find((candidate) => candidate.meta.surfaceKind === 'pipe'),
    check: (doc) => Boolean(doc.webhooks?.['pipe.orders-pipe']?.post?.['x-aws-eventbridge-filter-criteria'])
  },
  {
    name: 'eventbridge-api-destination',
    provider: new EventBridgeSurfaceProvider({
      probe: async () => true,
      listRules: async () => [],
      listTargetsByRule: async () => [],
      listPipes: async () => [],
      describePipe: async () => fixture.eventBridge.pipeDetail,
      listApiDestinations: async () => fixture.eventBridge.apiDestinations
    }),
    find: (candidates) => candidates.find((candidate) => candidate.meta.surfaceKind === 'api-destination'),
    check: (doc) => Boolean(doc.paths?.['/orders']?.post?.['x-aws-eventbridge-api-destination'])
  },
  {
    name: 'bedrock-action-group',
    provider: new BedrockActionGroupProvider({
      probe: async () => true,
      listAgents: async () => fixture.bedrock.agents,
      listActionGroups: async () => fixture.bedrock.actionGroups,
      getActionGroup: async () => fixture.bedrock.detail
    }),
    find: (candidates) => candidates[0],
    check: (doc) => Boolean(doc.paths?.['/orders']?.post && doc['x-aws-bedrock-agent-action-group'])
  },
  {
    name: 'appsync-events',
    provider: new AppSyncEventsProvider({
      probe: async () => true,
      listEventApis: async () => fixture.appSyncEvents.apis,
      listChannelNamespaces: async () => fixture.appSyncEvents.channelNamespaces
    }),
    find: (candidates) => candidates[0],
    check: (doc) => Boolean(doc.webhooks?.['orders.publish'] && doc.webhooks?.['orders.subscribe'])
  },
  {
    name: 'alb-listener-rule',
    provider: new AlbListenerRulesProvider({
      probe: async () => true,
      listRules: async () => fixture.alb.rules
    }),
    find: (candidates) => candidates[0],
    check: (doc) => Boolean(doc.paths?.['/orders/{proxy}']?.get && doc.paths?.['/orders/{proxy}']?.post)
  },
  {
    name: 'lambda-event-source',
    provider: new LambdaEventSourceProvider({
      probe: async () => true,
      listEventSourceMappings: async () => fixture.lambdaEventSource.mappings,
      getEventSourceMapping: async () => fixture.lambdaEventSource.mappings[0]
    }),
    find: (candidates) => candidates[0],
    check: (doc) => Boolean(doc.webhooks?.['lambda-event-source.esm-1']?.post?.['x-aws-lambda-filter-criteria'])
  },
  {
    name: 'verified-permissions',
    provider: new VerifiedPermissionsProvider({
      probe: async () => true,
      listPolicyStores: async () => fixture.verifiedPermissions.stores,
      getSchema: async () => fixture.verifiedPermissions.schema
    }),
    find: (candidates) => candidates[0],
    check: (doc) => Object.keys(doc.paths ?? {}).length === 0 && Boolean(doc['x-aws-verified-permissions']?.cedarSchema)
  },
  {
    name: 'step-functions',
    provider: new StepFunctionsProvider({
      probe: async () => true,
      listStateMachines: async () => fixture.stepFunctions.stateMachines,
      describeStateMachine: async () => fixture.stepFunctions.detail
    }),
    find: (candidates) => candidates[0],
    check: (doc) => Boolean(doc.paths?.['/step-functions/orders-workflow/executions']?.post?.['x-aws-stepfunctions'])
  }
];

const results = [];
for (const entry of providers) {
  const candidates = await entry.provider.listCandidates();
  const candidate = entry.find(candidates);
  if (!candidate) {
    results.push({ name: entry.name, passed: false, reason: 'candidate not found' });
    continue;
  }
  const result = await entry.provider.exportSpec(candidate, {});
  let doc;
  try {
    doc = JSON.parse(result.content);
  } catch {
    doc = undefined;
  }
  results.push({
    name: entry.name,
    passed:
      result.format === 'openapi-json' &&
      result.derivedOpenApiCompleteness === 'partial' &&
      Boolean(doc?.openapi) &&
      entry.check(doc),
    providerType: candidate.providerType,
    specFormat: result.format,
    completeness: result.derivedOpenApiCompleteness,
    evidence: result.evidence
  });
}

const failed = results.filter((result) => !result.passed);
await mkdir(path.dirname(evidenceJsonPath), { recursive: true });
await writeFile(evidenceJsonPath, `${JSON.stringify({ capturedAt: new Date().toISOString(), results }, null, 2)}\n`, 'utf8');

const summary = [
  '## P3 Surface Fixture Evidence',
  '',
  `- Captured at: ${new Date().toISOString()}`,
  `- Cases: ${results.length}`,
  `- Passed: ${results.length - failed.length}`,
  `- Failed: ${failed.length}`,
  '- Live status: fixture-only / official-doc-backed, not live-validated',
  '',
  '| Case | Provider Type | Artifact | Completeness | Result |',
  '| --- | --- | --- | --- | --- |',
  ...results.map((result) => `| ${result.name} | ${result.providerType ?? ''} | ${result.specFormat ?? ''} | ${result.completeness ?? ''} | ${result.passed ? 'pass' : 'fail'} |`)
].join('\n');

await updateEvidenceReadmeSection(summaryPath, 'p3-surfaces', summary);

if (failed.length > 0) {
  console.error(JSON.stringify({ failed }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: 'ok', cases: results.length }, null, 2));
}

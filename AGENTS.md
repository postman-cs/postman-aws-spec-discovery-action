# postman-aws-spec-discovery-action

Zero-config AWS API spec discovery. Probes IAM permissions to auto-detect available providers, scans repo for IaC signals, resolves best spec source, and exports it. Supports 15 AWS providers. Dual entry: GitHub Action and CLI.

## Structure

```
src/
  index.ts               # GitHub Action entry: reads inputs, calls execute(), sets outputs
  cli.ts                 # CLI adapter for non-GitHub CI
  runtime.ts             # Core execution engine: readActionInputs(), execute(), resolveInputs()
  contracts.ts           # Output names, DiscoveredService type, input definitions
  lib/
    providers/           # 15 providers + registry.ts + types.ts (api-gateway, appsync,
                         # appsync-events, eventbridge-schemas, eventbridge-surfaces,
                         # cloudformation, glue, sns, sns-code-derived, ssm,
                         # bedrock-action-groups, alb-listener-rules, lambda-url,
                         # lambda-event-source, verified-permissions, step-functions)
    aws/                 # Per-service SDK v3 clients (api-gateway, appsync, sns, ssm, ...)
    repo/                # Repo scanning, signals, catalog, spec inventory
    resolve/             # Candidate narrowing, service resolution, source selection
    spec/                # Format classification, OpenAPI derivation/normalization
    iac/                 # IaC parsing (CloudFormation, Terraform, CDK, Serverless)
    fetch/               # Remote spec fetch policy + safety checks
    logging/             # Sanitizing + step-summary logging
    postman/             # Telemetry credentials + PMAK diagnostics
    utils/               # Path sandboxing
tests/
  *.test.ts              # Unit tests
  live/                  # Live AWS integration tests (require credentials)
schemas/                 # JSON Schema validation files
discovered-specs/        # Sample output from discovery runs
```

## Commands

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run verify:dist:assert  # read-only artifact + git diff (CI after one bundle)
npm run verify:dist         # rebuild + diff + assert (pre-push / release)
```

## Discovery Flow

1. **Preflight**: Validate AWS credentials via `sts:GetCallerIdentity`
2. **Provider probing**: Each provider does lightweight IAM probe; silently skip if denied
3. **Repo scanning**: Fingerprint IaC files for provider hints and existing spec files
4. **Progressive narrowing** (API Gateway): IaC refs -> CFN stacks -> tag filtering -> naming heuristic -> full enumeration
5. **SNS resolution** (when SNS signals present): 9-level precedence chain (repo-local -> generated artifacts -> SSM -> remote URLs -> EventBridge-derived -> code-derived -> manual-review), subscription enrichment, metadata and webhook sidecar generation
6. **Candidate scoring**: Score candidates by confidence; select best match
7. **Export**: Write spec to `output-dir` in provider-appropriate format
8. **discover-many mode**: Export all discovered APIs across all providers

## Provider Output Formats

| Provider | Filename | Format |
| --- | --- | --- |
| API Gateway | `index.yaml` | OpenAPI 3.0 YAML |
| AppSync | `schema.graphql` | GraphQL SDL |
| EventBridge | `index.json` | JSON Schema |
| CloudFormation | `index.json` | OpenAPI JSON |
| Glue (Avro) | `schema.avsc` | Avro |
| Glue (JSON/Proto) | `schema.json`/`schema.proto` | JSON Schema/Protobuf |
| SSM | auto-detected | Any |
| SNS (contract) | `asyncapi.yaml`/`schema.json`/varies | AsyncAPI/JSON Schema/varies |
| SNS (metadata sidecar) | `sns-resolution-metadata.json` | JSON |
| SNS (webhook sidecar) | `webhook.openapi.json` | OpenAPI 3.1 JSON |

## Gotchas

- Never commit AWS credentials, Postman tokens, or other secrets; mask before logging
- `runtime.ts` contains real execution logic; `index.ts` is just GitHub Action shell
- In tests, custom `createAwsClient` injection builds minimal registry with only API Gateway to avoid real AWS probes
- Output path is sandboxed: must resolve within `repo-root` (path escapes are blocked)
- `overrides.undici` in package.json pins undici >=6.24.0 for Node 20 fetch compatibility
- SSM provider fetches URLs only over HTTPS; non-HTTPS URLs are preserved as pointer artifacts

## CI

`.github/workflows/ci.yml` bundles once, then queues at most two checks on one
runner. Typecheck runs once. Dist uses read-only `verify:dist:assert`; no pack
race. Every check prints a `::group::` result even when another check fails.

See workspace-root `../../docs/CI.md` for shared rationale.

## Releases

Tags are an **output** of passing run, never input. Never push release tags by hand; `.githooks/pre-push` rejects them.

- `.github/workflows/auto-release.yml` runs on every push to `main` and drives `scripts/release-cut.mjs`.
- `node scripts/release-cut.mjs --plan` reports pending cut (fetch tags first). `--execute` bumps, rebuilds `dist/`, runs typecheck/lint/test, commits, re-verifies committed bytes, then tags last.
- Version comes from highest tag ever cut, not `package.json`. Existing tags are burnt and skipped, so failed cut never reuses or rewinds version.
- Conventional-commit type picks bump; `chore`/`ci`/`build`/`test`/`style` alone cut nothing.
- Release commit lives only on tag. `main` requires pull requests; tag is ref `release.yml` reads.
- `main` requires pull requests and green `ready` check (admins included, no bypass). Merge with `gh pr checks <n> --watch --fail-fast && gh pr merge <n> --merge --delete-branch`; never `--admin`.
- `.githooks/pre-push` runs typecheck, lint, and test before every branch push.
- `RELEASE_POLICY.md` holds full contract.

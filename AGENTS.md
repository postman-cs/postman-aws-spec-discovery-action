# postman-aws-spec-discovery-action

Zero-config AWS API spec discovery. Probes IAM permissions to auto-detect available providers, scans repo for IaC signals, resolves best spec source, and exports it. Supports 8 AWS providers. Dual entry: GitHub Action and CLI.

## Structure

```
src/
  index.ts               # GitHub Action entry: reads inputs, calls execute(), sets outputs
  cli.ts                 # CLI adapter for non-GitHub CI
  runtime.ts             # Core execution engine: readActionInputs(), execute(), resolveInputs()
  contracts.ts           # Output names, DiscoveredService type, input definitions
  lib/
    providers/
      registry.ts        # ProviderRegistry -- probes and collects all available providers
      api-gateway.ts     # REST/HTTP/WebSocket API Gateway export (OpenAPI YAML)
      appsync.ts         # AppSync GraphQL schema introspection (SDL)
      eventbridge.ts     # EventBridge Schema Registry (JSON Schema/OpenAPI)
      cloudformation.ts  # CloudFormation embedded spec extraction (OpenAPI JSON)
      glue.ts            # Glue Schema Registry (Avro/JSON Schema/Protobuf)
      sns.ts             # SNS contract resolver (9-level precedence, subscription enrichment, sidecars)
      ssm.ts             # SSM Parameter Store spec registry (/postman/specs/*)
      backstage.ts       # Backstage catalog-info.yaml resolution
      base.ts            # BaseProvider interface
    aws/
      client.ts          # AWS SDK v3 wrapper (API Gateway, AppSync, CFN, etc.)
      *.ts               # Per-service SDK client abstractions
    repo/
      scanner.ts         # IaC fingerprinting (template.yaml, serverless.yml, cdk.json)
      context.ts         # Repo metadata from CI env vars
      signals.ts         # Repo signal detection (file patterns -> provider hints)
    resolve/
      resolver.ts        # Candidate scoring and selection
      candidates.ts      # Candidate data structures
      confidence.ts      # Confidence scoring algorithms
    fetch/
      spec-fetcher.ts    # HTTP fetch for remote spec URLs (with safety checks)
    logging/
      sanitize.ts        # Log message sanitization for user-safe errors
    process/
      timeout.ts         # Bounded execution with configurable timeouts
tests/
  *.test.ts              # Unit tests
  live/                  # Live AWS integration tests (require credentials)
schemas/                 # JSON Schema validation files
discovered-specs/        # Sample output from discovery runs
```

## Commands

```bash
npm ci && npm test && npm run typecheck && npm run build
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

`.github/workflows/ci.yml` runs `npm run bundle` once, then single `gate` job
fans out lint, typecheck, test, read-only `verify:dist:assert`, and commitlint
as backgrounded shell processes on one runner: wall-clock is `max(gate)`, not
`sum`, setup runs once, and every gate prints its result under a `::group::`
block even when another fails. Building before fan-out prevents pack tests from
racing an in-gate `rm -rf dist` rebuild.

See workspace-root `../../docs/CI.md` for shared rationale.

# Live Testing Runbook

Live validation proves AWS-facing resolution contracts against real resources. There are two complementary live surfaces:

1. **Validation matrix** (`validation/scripts/validate-live-aws-surfaces.mjs`) — customer-safe evidence for every live-supported provider, plus required current-run cases from the support ledger.
2. **SNS vitest suite** (`npm run test:live:sns`) — focused CLI integration tests for SNS contract resolution.

Neither surface may embed credentials, raw account IDs, request IDs, or signed URLs in committed evidence. Raw manifests stay in gitignored `*.local.json` files.

## Evidence

A successful live run is current-run proof for every required ledger row. Commit only the sanitized `validation/evidence/live-validation-summary.json` and generated sections in `validation/evidence/README.md`. Keep raw manifests and the built-CLI receipt (`validation/evidence/built-cli-live.local.json`) gitignored.

## Prerequisites

- Node.js 24+
- `npm ci` and `npm run build` (live runners execute `dist/cli.cjs` / `dist/index.cjs`)
- AWS credentials with read access documented in [Provider Discovery](providers.md#security-and-iam)
- Live stack `spec-discovery-validation` in `us-east-1` with exact GithubOrg/GithubRepo tags, multi-environment duplicates, merged AppSync, and provider-denial roles

Confirm identity without printing secrets:

```bash
aws sts get-caller-identity --query 'Account' --output text >/dev/null
```

## Full live validation matrix

```bash
npm run build
node validation/scripts/capture-live-manifest.mjs --stack-name spec-discovery-validation --region us-east-1
node validation/scripts/validate-live-aws-surfaces.mjs
```

### Required current-run cases

The live script always executes these required cases and fails if a required fixture is missing. Existing provider happy paths remain mandatory; the following correctness boundaries are also required:

| Case | Requirement |
| --- | --- |
| `github-org-repo-tag-zero-config` | From a checked-out GithubOrg/GithubRepo-tagged service repo, resolve the intended REST/HTTP/WebSocket gateway with only ambient AWS credentials/region and CI repository identity (no explicit gateway/service input). Prefer `postman:repo`, then `GithubOrg`+`GithubRepo`. |
| `github-org-repo-multi-environment-ambiguity` | Exact multi-environment duplicates remain ranked `manual-review`. |
| `api-gateway-rest-native` / `api-gateway-rest-fallback` | Native export and recognized fallback labeled partial. |
| `api-gateway-http-deployed-stage` | Explicit/evidenced stage export with `configurationMode=deployed-stage`. |
| `api-gateway-http-latest-configuration-divergence` | No-stage `latest-configuration` diverges from deployed-stage after an undeployed change. |
| `api-gateway-websocket-partial-control-plane` | Partial route/model/integration/authorizer/response reconstruction. |
| `appsync-merged-associations` | Merged SDL once; source associations in provenance. |
| `expected-identity-mismatch` | Wrong `expected-account-id` / `expected-partition` fails closed with sanitized error. |
| `provider-denial-typed` | IAM denial recorded in `providerProbes`. |
| `all-existing-live-supported-providers` | Refresh every previously live-supported provider surface. |

`expected-identity-mismatch` intentionally uses a wrong account/partition and must fail closed with a sanitized error. The runner creates and deletes a temporary undeployed HTTP route to prove latest-configuration divergence; zero temporary routes must remain after completion.

## SNS vitest live suite

```bash
npm run build && npm run test:live:sns
```

### Stack (SNS-focused)

```bash
aws cloudformation deploy \
  --template-file tests/live/test-resources.yaml \
  --stack-name spec-discovery-test \
  --region us-east-1 \
  --capabilities CAPABILITY_IAM
```

### Coverage

| Test | Description |
| --- | --- |
| discover-many | Multi-provider discovery including SNS sidecars |
| resolve-one with repo-local AsyncAPI | Prefers repo-local AsyncAPI |
| resolve-one with repo-local JSON Schema | Prefers repo-local JSON Schema |
| resolve-one with SSM inline content | Falls back to SSM content |
| resolve-one with SSM spec-url fetch | Allowlisted/remote URL path (subject to deny-by-default remote policy) |
| resolve-one manual-review | Unresolved when no contract matches |
| Tag-based candidate ranking | `postman:project-name` scoring |

## Troubleshooting

- Rebuild before live runs; tests execute bundled `dist/`.
- Throttling: retry with backoff; reduce concurrent AWS activity.
- Region mismatch: validation stack and runners expect `us-east-1`.
- Remote URL cases: remote fetch is deny-by-default; supply `remote-fetch-allowlist-json` for trusted hosts when exercising URL registry paths.
- Never commit `*.local.json` manifests or credential-bearing logs.

## Related docs

- [`validation/SUPPORT_LEDGER.md`](../validation/SUPPORT_LEDGER.md)
- [`validation/README.md`](../validation/README.md)
- [`docs/providers.md`](providers.md)

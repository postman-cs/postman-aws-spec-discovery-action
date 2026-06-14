# Postman Onboarding: AWS Spec Discovery

[![CI](https://github.com/postman-cs/postman-aws-spec-discovery-action/actions/workflows/ci.yml/badge.svg)](https://github.com/postman-cs/postman-aws-spec-discovery-action/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/postman-cs/postman-aws-spec-discovery-action?sort=semver)](https://github.com/postman-cs/postman-aws-spec-discovery-action/releases) [![npm](https://img.shields.io/npm/v/%40postman-cse%2Fonboarding-aws-spec-discovery)](https://www.npmjs.com/package/@postman-cse/onboarding-aws-spec-discovery) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Zero-config discovery and export of API specs from AWS services using only your existing AWS credentials. Use it when a service already runs on AWS and you need a source-of-truth [Spec Hub](https://learning.postman.com/docs/design-apis/specifications/overview/) specification that Postman onboarding can turn into deterministic collections, OpenAPI-backed contract checks, smoke tests, mocks, monitors, repo artifacts, and CI runs.

Part of the [Postman API Onboarding suite](https://github.com/postman-cs/postman-api-onboarding-action).

You usually set just `aws-region`. Repo identity comes from CI automatically, providers are auto-detected by probing your IAM permissions, and repo-first resolution prefers existing specs before calling AWS. No GitHub token is required by this action; it is read-only against AWS APIs.

## Which action should I use?

| Need | Use |
| --- | --- |
| Mint a Postman service-account access token and resolve the team ID | [Postman Onboarding: Service Token](https://github.com/postman-cs/postman-resolve-service-token-action) |
| Discover an OpenAPI, GraphQL, AsyncAPI, schema, or AWS-derived contract from the current AWS-backed repo | This action |
| Run the full Postman onboarding path after a spec is found | [Postman API Onboarding](https://github.com/postman-cs/postman-api-onboarding-action) |
| Only create or update the Postman workspace, spec, and generated collections | [Postman Onboarding: Workspace Bootstrap](https://github.com/postman-cs/postman-bootstrap-action) |
| Apply a curated flow.yaml to the generated Smoke collection | [Postman Onboarding: Smoke Flow](https://github.com/postman-cs/postman-smoke-flow-action) |
| Export Postman artifacts into the repository and wire CI assets | [Postman Onboarding: Repo Sync](https://github.com/postman-cs/postman-repo-sync-action) |
| Link an already discovered Insights service to a workspace | [Postman Onboarding: Insights Linking](https://github.com/postman-cs/postman-insights-onboarding-action) |

## Region and Postman handoff

The first required choice is the AWS region. Set `aws-region` to the region that contains the API Gateway, AppSync, SNS, EventBridge, Lambda, SSM, or other provider resources you want to inspect. If the repo already contains a spec, the action can still resolve it before calling AWS, but AWS credentials must be valid because startup validates identity.

For the Postman side, use `postman-resolve-service-token-action` to mint the access token and team ID from a [Postman service account](https://learning.postman.com/docs/administration/service-accounts/) PMAK, then pass this action's `spec-path` output into the composite onboarding action for [spec import](https://learning.postman.com/docs/design-apis/specifications/import-a-specification/). If you call bootstrap directly for an org-mode workspace, use bootstrap's `workspace-team-id` input for workspace creation. Downstream Postman credential preflight accepts `warn` and `enforce`; do not configure a public opt-out.

## Usage

```yaml
jobs:
  onboard-from-aws:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: write
      actions: write
    steps:
      - uses: actions/checkout@v5

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/postman-spec-discovery
          aws-region: us-east-1

      - id: postman_token
        uses: postman-cs/postman-resolve-service-token-action@v1
        with:
          postman-api-key: ${{ secrets.POSTMAN_SERVICE_ACCOUNT_API_KEY }}
          postman-region: us

      - id: resolve
        uses: postman-cs/postman-aws-spec-discovery-action@v1
        with:
          aws-region: us-east-1

      - uses: postman-cs/postman-api-onboarding-action@v1
        if: steps.resolve.outputs.resolution-status == 'resolved'
        with:
          postman-api-key: ${{ secrets.POSTMAN_SERVICE_ACCOUNT_API_KEY }}
          postman-access-token: ${{ steps.postman_token.outputs.token }}
          postman-team-id: ${{ steps.postman_token.outputs.team-id }}
          postman-region: us
          credential-preflight: warn
          project-name: ${{ steps.resolve.outputs.service-name }}
          spec-path: ${{ steps.resolve.outputs.spec-path }}
```

The resolved spec lands in `discovered-specs/` and the step exposes `spec-path`, `service-name`, confidence, and provenance as outputs.

The `id-token: write` permission is for AWS OIDC role assumption through `aws-actions/configure-aws-credentials`. `contents: write` and `actions: write` match the downstream composite action's default artifact commit and generated-workflow behavior. This AWS discovery action itself does not write repository contents or request a GitHub token. See [docs/providers.md](docs/providers.md#security-and-iam) for the minimum and full IAM policies.

For EU Postman data residency, set `postman-region: eu` on both the service-token and downstream Postman action steps.

## Examples

### Zero-config, region only

Providers are probed against your IAM permissions; anything your role cannot read is silently skipped.

```yaml
- id: resolve
  uses: postman-cs/postman-aws-spec-discovery-action@v1
  with:
    aws-region: us-east-1
```

### Known API Gateway ID

Bypass broad account discovery when you already know the gateway.

```yaml
- id: resolve
  uses: postman-cs/postman-aws-spec-discovery-action@v1
  with:
    aws-region: us-east-1
    gateway-id: abc123def4
```

### discover-many mode

Export specs from all discovered APIs across all available providers. `mode` is an environment-variable input (`INPUT_MODE`).

```yaml
- id: discover
  uses: postman-cs/postman-aws-spec-discovery-action@v1
  env:
    INPUT_MODE: discover-many
  with:
    aws-region: us-east-1
```

### Custom output directory

Write generated specs somewhere other than `discovered-specs/`. The path must resolve within the repository root.

```yaml
- id: resolve
  uses: postman-cs/postman-aws-spec-discovery-action@v1
  with:
    aws-region: us-east-1
    output-dir: postman/specs
```

### Chaining into Postman API onboarding

Feed the discovered spec straight into the [onboarding composite](https://github.com/postman-cs/postman-api-onboarding-action) via its `spec-path` input. The service-token action is the primary way to supply the Postman access token and team ID.

```yaml
- id: postman_token
  uses: postman-cs/postman-resolve-service-token-action@v1
  with:
    postman-api-key: ${{ secrets.POSTMAN_SERVICE_ACCOUNT_API_KEY }}
    postman-region: us

- id: resolve
  uses: postman-cs/postman-aws-spec-discovery-action@v1
  with:
    aws-region: us-east-1

- uses: postman-cs/postman-api-onboarding-action@v1
  if: steps.resolve.outputs.resolution-status == 'resolved'
  with:
    postman-api-key: ${{ secrets.POSTMAN_SERVICE_ACCOUNT_API_KEY }}
    postman-access-token: ${{ steps.postman_token.outputs.token }}
    postman-team-id: ${{ steps.postman_token.outputs.team-id }}
    postman-region: us
    credential-preflight: warn
    project-name: ${{ steps.resolve.outputs.service-name }}
    spec-path: ${{ steps.resolve.outputs.spec-path }}
```

### Chaining directly into workspace bootstrap

Use the bootstrap action directly when you only need workspace/spec/collection creation and do not want repo sync or Insights linking. For org-mode workspace creation, provide bootstrap's `workspace-team-id` from your configured Postman sub-team.

```yaml
- id: postman_token
  uses: postman-cs/postman-resolve-service-token-action@v1
  with:
    postman-api-key: ${{ secrets.POSTMAN_SERVICE_ACCOUNT_API_KEY }}
    postman-region: us

- id: resolve
  uses: postman-cs/postman-aws-spec-discovery-action@v1
  with:
    aws-region: us-east-1

- uses: postman-cs/postman-bootstrap-action@v1
  if: steps.resolve.outputs.resolution-status == 'resolved'
  with:
    postman-api-key: ${{ secrets.POSTMAN_SERVICE_ACCOUNT_API_KEY }}
    postman-access-token: ${{ steps.postman_token.outputs.token }}
    workspace-team-id: ${{ vars.POSTMAN_WORKSPACE_TEAM_ID }}
    postman-region: us
    credential-preflight: enforce
    project-name: ${{ steps.resolve.outputs.service-name }}
    spec-path: ${{ steps.resolve.outputs.spec-path }}
```

### Event-driven repos (SNS contracts)

For event-driven repositories using SNS, keep your contract in-repo as AsyncAPI or JSON Schema and let the action resolve it automatically. The action detects SNS usage from IaC files and resolves durable event contracts instead of exporting an AWS-generated spec.

```yaml
- id: resolve-events
  uses: postman-cs/postman-aws-spec-discovery-action@v1
  env:
    INPUT_MODE: resolve-one
    INPUT_EXPECTED_SERVICE_NAME: orders-events
  with:
    aws-region: us-east-1
```

See [docs/sns-contract-resolution.md](docs/sns-contract-resolution.md) for the full precedence chain, sidecars, and edge cases.

### GitLab and other CI (portable CLI)

```bash
node dist/cli.cjs \
  --aws-region us-east-1 \
  --repo-root "$CI_PROJECT_DIR" \
  --result-json "$CI_PROJECT_DIR/postman-aws-spec-discovery-result.json" \
  --dotenv-path "$CI_PROJECT_DIR/postman-aws-spec-discovery.env"
```

CLI environment-variable outputs are documented in [docs/providers.md](docs/providers.md#cli-usage-gitlab-bitbucket-azure-devops).

## Inputs

<!-- inputs-table:start -->
| Name | Description | Required | Default |
| --- | --- | --- | --- |
| `aws-region` | AWS region used to resolve API Gateway, AppSync, SNS, EventBridge, Lambda, and other discovery providers. | yes | n/a |
| `gateway-id` | Optional known API Gateway ID for this service. Use this when you want to bypass broader account discovery. | no | n/a |
| `stage` | Optional API Gateway stage override (for example prod or staging). | no | n/a |
| `output-dir` | Directory under the repository root where generated specs are written. | no | `discovered-specs` |
<!-- inputs-table:end -->

Optional resolution tuning inputs (`mode`, `expected-service-name`, `api-filter`, `max-candidates`, repo context overrides, and more) are set via `INPUT_`-prefixed environment variables and documented in [docs/providers.md](docs/providers.md#resolution-tuning-inputs).

## Outputs

<!-- outputs-table:start -->
| Name | Description |
| --- | --- |
| `resolution-json` | JSON resolution result describing status, source type, confidence, and evidence. |
| `resolution-status` | Resolution status: resolved or unresolved. |
| `source-type` | Resolved source type: repo-spec, gateway-export, appsync-schema, appsync-event-api, eventbridge-schema, eventbridge-surface, cfn-embedded, glue-schema, bedrock-action-group, alb-listener-rule, sns-contract, ssm-registry, lambda-url-export, lambda-event-source, verified-permissions-schema, step-functions-asl, manual-review, or discover-many. |
| `mapping-confidence` | Numeric confidence score for selected service candidate. |
| `spec-path` | Path to resolved or generated specification when available. |
| `gateway-id` | Resolved API Gateway ID when available. |
| `service-name` | Resolved service name. |
| `services-json` | Legacy discover-many output: JSON array of exported services. |
| `service-count` | Legacy discover-many output: number of exported services. |
| `export-summary-json` | discover-many summary JSON with attempted/exported/failed/skipped counts. |
| `candidates-json` | JSON array of top candidates when resolution is ambiguous. |
| `provider-type` | Provider that resolved the spec: api-gateway, appsync, appsync-events, eventbridge-schemas, eventbridge, cloudformation, glue, bedrock-action-group, alb-listener-rule, sns, ssm, lambda-url, lambda-event-source, verified-permissions, or step-functions. |
| `spec-format` | Format of the resolved spec: openapi-yaml, openapi-json, graphql-sdl, asyncapi-yaml, asyncapi-json, json-schema, postman-collection, smithy, avro, or protobuf. |
| `contract-origin` | SNS contract provenance when available: repo-asyncapi, repo-json-schema, generated-asyncapi, ssm-content, ssm-url, catalog-url, eventbridge-derived, code-derived, or manual-review. |
| `contract-metadata-path` | Path to SNS resolution metadata sidecar when available. |
| `variant-count` | Number of SNS delivery variants discovered when available. |
| `derived-openapi-path` | Path to the canonical derived OpenAPI JSON sidecar when available. |
| `derived-openapi-version` | OpenAPI version of the derived sidecar when available. |
| `derived-openapi-completeness` | Derived OpenAPI completeness: full or partial. |
| `derived-openapi-format` | Format of the derived OpenAPI sidecar, currently openapi-json. |
| `derived-openapi-evidence-json` | JSON array of evidence entries explaining derived OpenAPI quality and limitations. |
<!-- outputs-table:end -->

## Supported providers

| Provider | Artifact | Auto-detected via |
| --- | --- | --- |
| Repo-local specs | OpenAPI, Swagger, GraphQL SDL, AsyncAPI, Postman, JSON Schema, Avro, protobuf, Smithy | Known spec paths |
| Backstage catalog | Local or remote `catalog-info.yaml` API definitions | Root or nested catalog file |
| API Gateway (REST, HTTP, WebSocket) | OpenAPI 3.0 export or synthesis | IAM probe / explicit gateway ID |
| AppSync GraphQL | GraphQL SDL | IAM probe + `.graphql` files |
| AppSync Events | Event API channel namespaces | IAM probe |
| EventBridge Schema Registry | JSON Schema or OpenApi3 content | IAM probe + IaC references |
| EventBridge rules, pipes, API destinations | Event patterns, filters, targets | IAM probe |
| CloudFormation embedded specs | Embedded or referenced OpenAPI body | IAM probe |
| Glue Schema Registry | Avro, JSON Schema, or protobuf | IAM probe + IaC references |
| Bedrock Agent action groups | Inline or S3 OpenAPI action group schema | IAM probe |
| ALB listener rules | Host/path/method/header/query conditions | IAM probe |
| SSM Parameter Store | Stored content, fetched URL content, or pointer | IAM probe for `/postman/specs/` |
| SNS topics | AsyncAPI / JSON Schema contracts plus sidecars | IAM probe + SNS IaC references + SSM fallback |
| Lambda Function URLs | Synthesized function URL contract | IAM probe + IaC references / URL pattern |
| Lambda event source mappings | Mapping filters, source, target, batch settings | IAM probe |
| Verified Permissions schemas | Cedar schema metadata | IAM probe |
| Step Functions ASL | State machine definitions | IAM probe |

Each provider is probed at startup; providers your role cannot read are silently skipped. Per-provider artifacts, OpenAPI derivation behavior, output filenames, and IAM policies are detailed in [docs/providers.md](docs/providers.md).

## How it works

At startup the action validates credentials with `sts:GetCallerIdentity`, probes each provider with a lightweight IAM read, and scans bounded IaC, workflow, and config files for service signals. Candidates are scored by confidence; the best match is exported to `output-dir`, alongside an `openapi.derived.json` sidecar when the artifact can be represented as OpenAPI. Progressive narrowing keeps broad accounts tractable: IaC fingerprints, CloudFormation stack correlation, `postman:repo` tags, and naming heuristics run before any full enumeration. Full details, including candidate scoring, stage auto-selection, Backstage and SSM conventions, CI auto-detection, OpenAPI normalization, IAM policies, and troubleshooting, live in [docs/providers.md](docs/providers.md).

SNS is handled as a contract resolver, since SNS has no native exportable spec. Contracts resolve through a 9-level precedence chain (repo-local AsyncAPI down to manual review), with subscription-aware enrichment and metadata/webhook sidecars. See [docs/sns-contract-resolution.md](docs/sns-contract-resolution.md).

## Resources

### Support, security, and releases

- Support: [SUPPORT.md](SUPPORT.md)
- Security reporting and credential guidance: [SECURITY.md](SECURITY.md)
- Release and tag policy: [RELEASE_POLICY.md](RELEASE_POLICY.md)

### The suite

| Action | Role |
| --- | --- |
| [Postman API Onboarding](https://github.com/postman-cs/postman-api-onboarding-action) | Entry point: chains workspace bootstrap, repo sync, and optional Insights linking |
| [Postman Onboarding: Service Token](https://github.com/postman-cs/postman-resolve-service-token-action) | Mints the service-account access token and team ID |
| [Postman Onboarding: AWS Spec Discovery](https://github.com/postman-cs/postman-aws-spec-discovery-action) | Discovers and exports API specs from AWS services |
| [Postman Onboarding: Workspace Bootstrap](https://github.com/postman-cs/postman-bootstrap-action) | Creates the workspace, uploads the spec, generates collections |
| [Postman Onboarding: Smoke Flow](https://github.com/postman-cs/postman-smoke-flow-action) | Applies a curated flow.yaml to the Smoke collection |
| [Postman Onboarding: Repo Sync](https://github.com/postman-cs/postman-repo-sync-action) | Exports artifacts into the repo and wires CI, mocks, and monitors |
| [Postman Onboarding: Insights Linking](https://github.com/postman-cs/postman-insights-onboarding-action) | Links Insights discovered services to the workspace |

- [postman-resolve-service-token-action](https://github.com/postman-cs/postman-resolve-service-token-action): mints a service-account access token and team ID
- [postman-api-onboarding-action](https://github.com/postman-cs/postman-api-onboarding-action): composite that orchestrates the onboarding pipeline
- [postman-bootstrap-action](https://github.com/postman-cs/postman-bootstrap-action): workspace, spec upload, collections, governance
- [postman-smoke-flow-action](https://github.com/postman-cs/postman-smoke-flow-action): applies curated flow.yaml to the Smoke collection
- [postman-repo-sync-action](https://github.com/postman-cs/postman-repo-sync-action): artifact sync, environments, mocks, monitors
- [postman-insights-onboarding-action](https://github.com/postman-cs/postman-insights-onboarding-action): Insights-to-workspace linking
- npm package: [@postman-cse/onboarding-aws-spec-discovery](https://www.npmjs.com/package/@postman-cse/onboarding-aws-spec-discovery)
- [Validation suite](validation/README.md): fixtures, runbooks, and sanitized evidence for every discovery surface
- [Provider deep dive](docs/providers.md) and [SNS contract resolution](docs/sns-contract-resolution.md)
- [Live testing runbook](docs/LIVE_TESTING_RUNBOOK.md)
- Postman Learning Center: [Spec Hub](https://learning.postman.com/docs/design-apis/specifications/overview/), [import a specification](https://learning.postman.com/docs/design-apis/specifications/import-a-specification/), [cloud connectors](https://learning.postman.com/docs/api-catalog/connect/cloud/)


## Telemetry

This action sends a single anonymous usage event when a run completes, so the
Postman team can measure adoption across CI systems. The event contains the
action name and version, your Postman team ID, the detected CI provider and
runner kind, the run outcome, and a one-way SHA-256 hash of the repository
identifier. The Postman team ID is sent in the clear on a legitimate-interest
basis to measure product adoption.

The `events.pm-cse.dev` endpoint is operated by the Postman Customer Success
Engineering team. Postman, Inc. processes these events only to measure
onboarding adoption in aggregate, retains them only as aggregated counts for
product-adoption trend analysis, and includes no payload field that identifies
an individual person.

It never sends API keys, access tokens, spec content, workspace or repository
names, or any personal data. It is fire-and-forget with a hard
timeout and can never block or fail your pipeline. Corporate HTTP and HTTPS
proxies are honored through the standard `HTTPS_PROXY`, `HTTP_PROXY`, and
`NO_PROXY` environment variables.

Disable it by setting either environment variable in your CI:

```sh
POSTMAN_ACTIONS_TELEMETRY=off
# or the cross-tool standard
DO_NOT_TRACK=1
```

Telemetry is also skipped automatically when no Postman team ID can be resolved.

This action holds no Postman credentials, so telemetry is present but inert
unless a `POSTMAN_TEAM_ID` environment variable is supplied to attribute the
run to a team.

Events are sent over HTTPS to `https://events.pm-cse.dev/v1/events`. To
allowlist this destination on a restricted network, or to route events to a
collector you operate, set the `POSTMAN_ACTIONS_TELEMETRY_ENDPOINT` environment
variable to your own URL.

## License

[MIT](LICENSE)

# Postman AWS Spec Discovery

[![CI](https://github.com/postman-cs/postman-aws-spec-discovery-action/actions/workflows/ci.yml/badge.svg)](https://github.com/postman-cs/postman-aws-spec-discovery-action/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/postman-cs/postman-aws-spec-discovery-action?sort=semver)](https://github.com/postman-cs/postman-aws-spec-discovery-action/releases) [![npm](https://img.shields.io/npm/v/%40postman-cse%2Fonboarding-aws-spec-discovery)](https://www.npmjs.com/package/@postman-cse/onboarding-aws-spec-discovery) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Zero-config discovery and export of API specs from AWS services using only your existing AWS credentials.

You usually set just `aws-region`. Repo identity comes from CI automatically, providers are auto-detected by probing your IAM permissions, and repo-first resolution prefers existing specs before calling AWS. No GitHub token required; the action is read-only against AWS APIs.

## Usage

```yaml
jobs:
  discover:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v5

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/postman-spec-discovery
          aws-region: us-east-1

      - id: resolve
        uses: postman-cs/postman-aws-spec-discovery-action@v1
        with:
          aws-region: us-east-1
```

The resolved spec lands in `discovered-specs/` and the step exposes `spec-path`, `service-name`, confidence, and provenance as outputs.

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

Feed the discovered spec straight into the [onboarding composite](https://github.com/postman-cs/postman-api-onboarding-action) via its `spec-path` input.

```yaml
- id: resolve
  uses: postman-cs/postman-aws-spec-discovery-action@v1
  with:
    aws-region: us-east-1

- uses: postman-cs/postman-api-onboarding-action@v1
  if: steps.resolve.outputs.resolution-status == 'resolved'
  with:
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
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
| `aws-region` | AWS region used to resolve API Gateway resources | yes | n/a |
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

## License

[MIT](LICENSE)

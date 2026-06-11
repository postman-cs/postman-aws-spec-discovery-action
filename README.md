# postman-aws-spec-discovery-action

[![CI](https://github.com/postman-cs/postman-aws-spec-discovery-action/actions/workflows/ci.yml/badge.svg)](https://github.com/postman-cs/postman-aws-spec-discovery-action/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/postman-cs/postman-aws-spec-discovery-action?sort=semver)](https://github.com/postman-cs/postman-aws-spec-discovery-action/releases)
[![npm](https://img.shields.io/npm/v/%40postman-cse%2Fonboarding-aws-spec-discovery)](https://www.npmjs.com/package/@postman-cse/onboarding-aws-spec-discovery)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Automatically discover and export API specifications from AWS services.

This project supports:
- GitHub Actions via `action.yml`
- Portable Node CLI via `dist/cli.cjs` (GitLab or other CI)

The action is intentionally zero-config:
- You usually set only `aws-region`
- Repo identity comes from CI automatically
- Providers are auto-detected via IAM permission probing
- Safety checks, retries, and bounded discovery are on by default
- Repo-first resolution prefers existing specs before calling AWS
- Remote spec fetch only activates when the repo already points to one through Backstage or SSM

No GitHub token required. This action uses only AWS credentials for API access. Repo context (URL, branch, commit) is auto-detected from your CI environment.

## Supported providers

The action resolves the best available contract artifact first, then records whether that artifact is already OpenAPI or can be represented as a partial OpenAPI 3.x surface. Partial derivations are intentionally conservative: they preserve the discoverable transport shape without inventing undocumented business endpoints.

| Provider | Primary artifact | OpenAPI derivation | Auto-detected via |
| --- | --- | --- | --- |
| Repo-local specs | OpenAPI, Swagger, GraphQL SDL, AsyncAPI, Postman, JSON Schema, Avro, protobuf, Smithy | Full OpenAPI for OpenAPI 3.x; partial OpenAPI 3.x for Swagger and native API formats. GraphQL derivation preserves operation names, variable shapes, and schema components; AsyncAPI derivation preserves channel payload schemas, examples, and channel/direction metadata; Postman derivation preserves request parameters, JSON examples, auth metadata, and response examples; JSON Schema and Avro derivation preserves named component schemas with `$ref` request bodies. | Known spec paths |
| Backstage catalog | Local or remote `catalog-info.yaml` / `catalog-info.yml` API definitions | Full OpenAPI for OpenAPI refs; partial OpenAPI 3.1 for GraphQL refs | Root or nested catalog file |
| API Gateway REST | AWS OpenAPI export, with model/method fallback for known export limitations | Full OpenAPI 3.0 YAML from native export; partial OpenAPI 3.0 YAML from fallback synthesis | IAM probe |
| API Gateway HTTP | AWS OpenAPI export | Full OpenAPI 3.0 YAML | IAM probe |
| API Gateway WebSocket | Route metadata, request models, integrations, authorizers when present, and route responses | Partial OpenAPI 3.0 YAML synthesized from API Gateway v2 metadata with component schemas and API Gateway extensions | Explicit gateway ID |
| AppSync GraphQL | GraphQL SDL | Partial OpenAPI 3.1 GraphQL endpoint | IAM probe + `.graphql` files in repo |
| AppSync Events | Event API channel namespaces | Partial OpenAPI 3.1 webhooks for publish/subscribe namespaces, live-validated against AppSync Event API resources. | IAM probe |
| EventBridge Schema Registry | JSON Schema or OpenApi3 schema content | Full OpenAPI for OpenApi3 schemas; partial OpenAPI 3.1 for JSON Schema | IAM probe + IaC references |
| EventBridge rules, pipes, and API destinations | Event patterns, filters, targets, and HTTP destinations | Partial OpenAPI 3.1 webhooks or HTTP operations with EventBridge extensions, live-validated against rules, pipes, and API destinations. | IAM probe |
| CloudFormation embedded specs | Embedded or referenced OpenAPI body | Full OpenAPI 3.0/3.1 when the template contains OpenAPI | IAM probe |
| Glue Schema Registry | Avro, JSON Schema, or protobuf | Partial OpenAPI 3.1 request surface | IAM probe + IaC references |
| Bedrock Agent action groups | Inline or S3 OpenAPI action group schema | OpenAPI JSON with Bedrock action group metadata; marked partial because Bedrock supports a subset of OpenAPI. Live-validated against an inline OpenAPI action group. | IAM probe |
| ALB listener rules | Host, path, method, header, query, and action conditions | Partial OpenAPI 3.1 HTTP paths with ALB rule extensions, live-validated against an ALB listener rule. | IAM probe |
| SSM Parameter Store | Stored content, fetched URL content, or pointer artifact | Full OpenAPI for OpenAPI content; partial OpenAPI 3.1 for supported native content and pointer artifacts | IAM probe for `/postman/specs/` path |
| SNS Topics | AsyncAPI / JSON Schema contracts plus sidecars | Partial OpenAPI 3.1 from contracts; OpenAPI 3.1 webhook sidecar for HTTP/S subscriptions | IAM probe + SNS IaC references + SSM fallback |
| Lambda Function URLs | Synthesized function URL contract | Partial OpenAPI 3.0 YAML synthesized as a catch-all URL surface | IAM probe + IaC references / `lambda-url` URL pattern |
| Lambda event source mappings | Event source mapping filters, source, target function, and batch settings | Partial OpenAPI 3.1 webhooks with Lambda mapping/filter extensions, live-validated against an SQS event source mapping. | IAM probe |
| Verified Permissions schemas | Cedar schema metadata | OpenAPI 3.1 metadata document with no invented HTTP paths, live-validated against a policy store schema. | IAM probe |
| Step Functions ASL | State machine definitions | Partial OpenAPI 3.1 execution-start surface with ASL metadata, live-validated against a Standard state machine. | IAM probe |

Each provider is probed at startup. If your role lacks permission for a provider, it is silently skipped. No configuration needed.

The validation suite for this repository lives in [`validation/`](validation/README.md). It includes fixture inputs, runbooks, sanitized evidence, and live AWS checks for every AWS-derived discovery surface documented above.

The action also detects Backstage `catalog-info.yaml` files in the repo root or bounded nested service directories and resolves API spec path or URL references automatically.

SNS is handled as a **contract resolver**, not an AWS spec exporter. SNS has no native exportable API specification, so the provider resolves durable event contracts through a 9-level precedence chain. For each discovered SNS topic, the resolution chain is:

1. **Repo-local AsyncAPI** (`asyncapi.yaml`, `asyncapi.yml`, `asyncapi.json`) -- validated by checking for the `asyncapi` top-level key. Files with the topic name in their path are prioritized.
2. **Repo-local JSON Schema** (`schema.json`, `*.schema.json`) -- validated by checking for `$schema`, `type`, `properties`, or similar schema markers.
3. **Generated AsyncAPI artifacts** -- scans `spec/**/`, `contracts/**/`, and `events/**/` for repo-tracked generated AsyncAPI files (e.g. from code-first tooling). Must contain a valid `asyncapi` top-level field. Path-matched files outrank generic generated docs.
4. **SSM inline content** (`/postman/specs/{service-name}/content`) -- fuzzy name matching strips `.fifo` suffixes and normalizes camelCase to kebab-case.
5. **SSM URL / spec-url fetch** (`/postman/specs/{service-name}/url` or `spec-url`) -- when no inline content exists, the action fetches the registered URL using the shared spec fetcher. On fetch failure, a pointer-style artifact is emitted instead of hard-failing.
6. **Explicit remote contract URLs** -- resolves contracts from URLs already referenced by checked-in repo config: Backstage catalog entries and repo-tracked contract registry files. Origin is `catalog-url`.
7. **EventBridge-derived fallback** -- when no direct SNS contract exists and evidence suggests an SNS-to-EventBridge bridge (e.g. IaC pipeline declarations or matching schema names), the resolver attempts to derive a contract from EventBridge Schema Registry. Origin is `eventbridge-derived` with lower confidence than direct sources. Transformed bridge events are flagged in metadata.
8. **Code-derived fallback** -- extracts contracts from explicit machine-readable code sources: Zod schemas, TypeBox schemas, JSON Schema definitions linked to SNS publishers, and Springwolf-generated AsyncAPI artifacts. Only runs when stronger sources fail. Ambiguous candidates fall through to manual review.
9. **Manual review fallback** -- writes a `manual-review.json` pointer when no contract source is found.

### Subscription-aware enrichment

The SNS provider inspects topic subscriptions (SQS, Lambda, HTTP/S) and classifies delivery variants:

- **raw-payload**: subscriber receives the raw message body (when `RawMessageDelivery` is enabled)
- **sns-envelope**: subscriber receives the full SNS envelope with `Message`, `MessageAttributes`, `TopicArn`, etc.

Subscription metadata -- including protocol, raw delivery mode, filter policies, filter policy scope, redrive policy, and delivery policy -- is captured in the resolution metadata sidecar. Missing subscription read permissions degrade gracefully to evidence-only output.

### SNS resolution sidecars

Every SNS resolution emits a **metadata sidecar** (`sns-resolution-metadata.json`) alongside the primary contract. The sidecar contains:

- `contractOrigin` -- provenance of the canonical contract (e.g. `repo-asyncapi`, `ssm-url`, `code-derived`)
- subscription details (protocol, endpoint, raw delivery, filter policies)
- message attributes and filter policy scope
- variant count

When a topic has HTTP or HTTPS subscriptions, a supplementary **webhook sidecar** (`webhook.openapi.json`) is emitted. This is an OpenAPI 3.1 document describing the HTTP callback payload shape, including whether delivery is raw or wrapped. Webhook operations also carry SNS-specific `x-sns-*` extensions for delivery variant, filter policy, filter policy scope, delivery policy, and redrive policy when those subscription attributes are available. The webhook sidecar is supplementary; the canonical SNS contract remains primary.

### SNS mode behavior

- **resolve-one**: API Gateway and SNS are peer sources when SNS IaC signals are present. The resolver compares the best API Gateway and SNS candidates by confidence, selects the higher-confidence source, and applies deterministic tie-breaks: repo-local SNS origins (`repo-asyncapi`, `repo-json-schema`) win ties, while SSM-backed SNS contracts lose ties to API Gateway. Topics whose resolution produces a `manual-review` result are skipped (the next topic is tried).
- **discover-many**: SNS runs alongside all other providers. Every discovered topic gets exported, including those that produce `manual-review` results.

### OpenAPI normalization (API Gateway exports)

API Gateway populates `operationId` from each integration's request name,
which is often the bare HTTP method (`get`, `update`, `post`) or omitted
entirely. That yields specs with duplicate or missing `operationId` values,
which fail OpenAPI 3.x validation (every operation must have a unique
`operationId`) and are rejected downstream by the Postman bootstrap action
with `CONTRACT_SPEC_VALIDATION_FAILED`.

After every API Gateway export the action runs a deterministic normalizer
on the OpenAPI document before writing it to disk:

- Operations whose `operationId` is empty get one synthesized from method
  and path (e.g. `getV1OrdersOrderId`).
- The first occurrence of any `operationId` is preserved verbatim, so
  existing references stay valid.
- Subsequent duplicates are renamed `<base>_<slugifiedPath>`
  (e.g. `update` -> `update_v1_account`). Further collisions fall back to
  a numeric tiebreaker (`update_v1_account_2`).

Every rewrite is logged with the path and method so the diff against the
raw AWS export is visible in the action run. Normalization is best-effort:
if the document is not OpenAPI (or fails to parse), the raw spec is written
unchanged and the bootstrap action's validator remains the source of truth.

## Security

This action is read-only against AWS APIs and does not mutate AWS resources.

Minimum IAM policy (API Gateway only):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity",
        "apigateway:GET"
      ],
      "Resource": "*"
    }
  ]
}
```

Full IAM policy (all providers):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity",
        "apigateway:GET",
        "appsync:ListGraphqlApis",
        "appsync:GetGraphqlApi",
        "appsync:GetIntrospectionSchema",
        "appsync:ListApis",
        "appsync:ListChannelNamespaces",
        "appsync:ListTagsForResource",
        "events:ListRules",
        "events:ListTargetsByRule",
        "events:ListApiDestinations",
        "pipes:ListPipes",
        "pipes:DescribePipe",
        "schemas:ListRegistries",
        "schemas:ListSchemas",
        "schemas:DescribeSchema",
        "schemas:ExportSchema",
        "schemas:ListTagsForResource",
        "cloudformation:ListStacks",
        "cloudformation:ListStackResources",
        "cloudformation:GetTemplate",
        "cloudformation:DescribeStacks",
        "glue:ListRegistries",
        "glue:ListSchemas",
        "glue:GetSchemaVersion",
        "glue:GetTags",
        "bedrock:ListAgents",
        "bedrock:ListAgentActionGroups",
        "bedrock:GetAgentActionGroup",
        "elasticloadbalancing:DescribeLoadBalancers",
        "elasticloadbalancing:DescribeListeners",
        "elasticloadbalancing:DescribeRules",
        "lambda:ListFunctions",
        "lambda:GetFunctionUrlConfig",
        "lambda:ListEventSourceMappings",
        "lambda:GetEventSourceMapping",
        "lambda:ListTags",
        "verifiedpermissions:ListPolicyStores",
        "verifiedpermissions:GetSchema",
        "states:ListStateMachines",
        "states:DescribeStateMachine",
        "s3:GetObject",
        "sns:ListTopics",
        "sns:GetTopicAttributes",
        "sns:ListTagsForResource",
        "sns:ListSubscriptionsByTopic",
        "sns:GetSubscriptionAttributes",
        "ssm:GetParametersByPath",
        "tag:GetResources"
      ],
      "Resource": "*"
    }
  ]
}
```

You only need permissions for the providers you use. Providers you lack access to are silently skipped.

Required IAM permissions for SNS contract discovery:
- `sns:ListTopics` -- enumerate topics in the account
- `sns:GetTopicAttributes` -- read topic metadata (non-fatal if denied; topic still becomes a candidate)
- `sns:ListTagsForResource` -- read topic tags for naming and scoring (non-fatal if denied)
- `sns:ListSubscriptionsByTopic` -- enumerate subscriptions for delivery variant enrichment (non-fatal if denied; degrades to evidence only)
- `sns:GetSubscriptionAttributes` -- read subscription details including raw delivery, filter policies, and redrive policies (non-fatal if denied)

If SNS also resolves contracts from SSM, `ssm:GetParametersByPath` is additionally required. If the EventBridge-derived fallback is attempted, EventBridge Schema Registry permissions (`schemas:*`) are additionally useful.

## Inputs

### Core inputs

| Input | Required | Default | Notes |
| --- | --- | --- | --- |
| `aws-region` | yes | n/a | Region used for all AWS API calls |
| `mode` | no | `resolve-one` | `resolve-one` resolves a single best spec; `discover-many` exports all discovered APIs across all providers |
| `gateway-id` | no | `''` | Optional known API Gateway ID to bypass broad discovery |
| `stage` | no | `''` | Optional stage override (see [Stage auto-selection](#stage-auto-selection) for default behavior) |
| `output-dir` | no | `discovered-specs` | Must resolve within `repo-root` |

### Resolution tuning inputs

These inputs are optional and rarely needed. They are set via environment variables prefixed with `INPUT_` (for example `INPUT_EXPECTED_SERVICE_NAME`).

| Input | Default | Notes |
| --- | --- | --- |
| `expected-service-name` | auto-detected | Explicit service name hint used for candidate scoring |
| `expected-gateway-ids-json` | `[]` | JSON array of gateway IDs to look up directly (bypasses enumeration) |
| `api-filter` | none | Regex filter applied to API names before scoring |
| `service-mapping-json` | `{}` | JSON object mapping gateway IDs to service names |
| `include-v2` | `true` | Include HTTP and WebSocket APIs (API Gateway v2) in discovery |
| `max-candidates` | `50` | Soft cap on candidates before triggering progressive narrowing or truncation |
| `dry-run` | `false` | Run resolution logic without writing spec files to disk |

### Preflight and reliability inputs

| Input | Default | Notes |
| --- | --- | --- |
| `preflight-checks` | `true` | Enable preflight STS identity and permission validation |
| `preflight-permission-probe` | `true` | Enable the IAM permission probe specifically (requires `preflight-checks`) |
| `request-timeout-ms` | `30000` | Per-request timeout in milliseconds for AWS SDK calls |
| `max-attempts` | `3` | AWS SDK retry count for transient failures |

### Repo context overrides

These are auto-detected from CI environment variables. Override them only when auto-detection is unavailable or incorrect.

| Input | Notes |
| --- | --- |
| `repo-root` | Workspace root directory (auto-detected from `GITHUB_WORKSPACE`, `CI_PROJECT_DIR`, `BITBUCKET_CLONE_DIR`, or `BUILD_SOURCESDIRECTORY`) |
| `repo-url` | Repository HTTPS URL |
| `repo-slug` | Repository slug (`org/repo-name`) |
| `git-provider` | `github`, `gitlab`, `bitbucket`, or `azure-devops` |
| `ref` | Branch or tag ref |
| `sha` | Commit SHA |

## Outputs

| Output | Description |
| --- | --- |
| `resolution-json` | Full resolution payload |
| `resolution-status` | `resolved` or `unresolved` |
| `source-type` | `repo-spec`, `gateway-export`, `appsync-schema`, `appsync-event-api`, `eventbridge-schema`, `eventbridge-surface`, `cfn-embedded`, `glue-schema`, `bedrock-action-group`, `alb-listener-rule`, `ssm-registry`, `sns-contract`, `lambda-url-export`, `lambda-event-source`, `verified-permissions-schema`, `step-functions-asl`, `manual-review`, or `discover-many` |
| `mapping-confidence` | Numeric confidence score |
| `spec-path` | Resolved/generated spec path when available |
| `gateway-id` | Selected gateway ID when available |
| `service-name` | Resolved service name |
| `provider-type` | Provider that resolved the spec (`api-gateway`, `appsync`, `appsync-events`, `eventbridge-schemas`, `eventbridge`, `cloudformation`, `glue`, `bedrock-action-group`, `alb-listener-rule`, `ssm`, `sns`, `lambda-url`, `lambda-event-source`, `verified-permissions`, `step-functions`) |
| `spec-format` | Format of the spec (`openapi-yaml`, `openapi-json`, `graphql-sdl`, `json-schema`, `avro`, `protobuf`, `asyncapi-yaml`, `asyncapi-json`) |
| `candidates-json` | JSON array of top candidates when resolution is ambiguous |
| `services-json` | discover-many mode: JSON array of all discovered services |
| `service-count` | discover-many mode: number of discovered services |
| `contract-origin` | SNS contract provenance: `repo-asyncapi`, `repo-json-schema`, `generated-asyncapi`, `ssm-content`, `ssm-url`, `catalog-url`, `eventbridge-derived`, `code-derived`, or `manual-review` |
| `contract-metadata-path` | Path to SNS resolution metadata sidecar when available |
| `variant-count` | Number of SNS delivery variants discovered when available |
| `derived-openapi-path` | Path to the canonical derived OpenAPI JSON sidecar when available. Blank in discover-many; per-service values are in `services-json`. |
| `derived-openapi-version` | OpenAPI version of the derived sidecar when available |
| `derived-openapi-completeness` | `full` for OpenAPI 3.x/native OpenAPI exports, `partial` for synthesized or native-to-OpenAPI derivations |
| `derived-openapi-format` | Format of the canonical derived sidecar, currently `openapi-json` |
| `derived-openapi-evidence-json` | JSON array explaining the derivation quality and limitations |
| `export-summary-json` | discover-many summary: attempted/exported/failed/skipped |

## Output file formats

| Provider | Filename | Format |
| --- | --- | --- |
| API Gateway (REST/HTTP/WebSocket) | `index.yaml` | OpenAPI 3.0 YAML |
| AppSync | `schema.graphql` | GraphQL SDL |
| AppSync Events | `index.json` | OpenAPI 3.1 JSON (partial) |
| EventBridge Schema Registry | `index.json` | JSON Schema |
| EventBridge rules/pipes/API destinations | `index.json` | OpenAPI 3.1 JSON (partial) |
| CloudFormation (embedded) | `index.json` | OpenAPI JSON |
| Glue (Avro) | `schema.avsc` | Avro |
| Glue (JSON Schema) | `schema.json` | JSON Schema |
| Glue (Protobuf) | `schema.proto` | Protocol Buffers |
| Bedrock Agent action group | `index.json` | OpenAPI JSON with Bedrock metadata |
| ALB listener rule | `index.json` | OpenAPI 3.1 JSON (partial) |
| SSM Parameter Store | auto-detected | Any (spec content or fetched URL content) |
| Lambda Function URL | `index.yaml` | OpenAPI 3.0 YAML (synthesized) |
| Lambda event source mapping | `index.json` | OpenAPI 3.1 JSON (partial) |
| Verified Permissions schema | `index.json` | OpenAPI 3.1 JSON metadata |
| Step Functions ASL | `index.json` | OpenAPI 3.1 JSON (partial) |
| SNS (AsyncAPI YAML) | `asyncapi.yaml` | AsyncAPI YAML |
| SNS (AsyncAPI JSON) | `asyncapi.json` | AsyncAPI JSON |
| SNS (JSON Schema) | `schema.json` | JSON Schema |
| SNS (SSM auto-detected) | varies | varies |
| SNS (no contract found) | `manual-review.json` | JSON Schema |
| SNS (metadata sidecar) | `sns-resolution-metadata.json` | JSON |
| SNS (webhook sidecar) | `webhook.openapi.json` | OpenAPI 3.1 JSON |
| Canonical derived OpenAPI sidecar | `openapi.derived.json` | OpenAPI JSON |

Native artifacts are preserved as the primary output. The action also emits `openapi.derived.json` when it can represent the selected artifact as OpenAPI for downstream onboarding and review. Canonical derived sidecars are always parseable JSON; GraphQL-derived sidecars preserve operation names, variable shapes, and schema components, AsyncAPI-derived sidecars preserve channel payload schemas, examples, and `x-asyncapi-*` channel metadata, Postman-derived sidecars preserve request parameters, JSON examples, auth metadata, and response examples when present, and JSON Schema/Avro-derived sidecars preserve named component schemas with `$ref` request bodies. Provider-specific sidecars such as SNS `webhook.openapi.json` remain separate. See [`validation/evidence/README.md`](validation/evidence/README.md) for the current evidence ledger.

## Usage

### GitHub minimal

```yaml
- id: resolve
  uses: postman-cs/postman-aws-spec-discovery-action@v1
  with:
    aws-region: us-east-1
```

### GitHub with known gateway ID

```yaml
- id: resolve
  uses: postman-cs/postman-aws-spec-discovery-action@v1
  with:
    aws-region: us-east-1
    gateway-id: abc123def4
```

### discover-many mode

Exports specs from all discovered APIs across all available providers:

```yaml
- id: discover
  uses: postman-cs/postman-aws-spec-discovery-action@v1
  env:
    INPUT_MODE: discover-many
  with:
    aws-region: us-east-1
```

### Event-driven repos (SNS contract resolution)

For event-driven repositories using SNS, keep your contract in-repo as AsyncAPI or JSON Schema and let the action resolve it automatically. The action detects SNS usage from IaC files and resolves durable event contracts rather than exporting an AWS-generated spec.

**resolve-one** (single best contract):

```yaml
- id: resolve-events
  uses: postman-cs/postman-aws-spec-discovery-action@v1
  env:
    INPUT_MODE: resolve-one
    INPUT_EXPECTED_SERVICE_NAME: orders-events
  with:
    aws-region: us-east-1
```

In `resolve-one`, API Gateway and SNS are evaluated together when the repo has SNS IaC signals. The action compares confidence scores and selects the best source, with deterministic ties (repo-local SNS beats equal-confidence API Gateway; SSM-backed SNS loses equal-confidence ties). Topics that resolve to `manual-review` are skipped; the action tries the next topic.

**discover-many** (all topics across all providers):

```yaml
- id: discover-all
  uses: postman-cs/postman-aws-spec-discovery-action@v1
  env:
    INPUT_MODE: discover-many
  with:
    aws-region: us-east-1
```

In `discover-many`, every SNS topic gets exported, including those that produce `manual-review` results. This is useful for auditing contract coverage across all event-driven services in an account.

**Example repo layout** for an event-driven microservice:

```
template.yaml          # SAM template with AWS::SNS::Topic
asyncapi.yaml          # AsyncAPI contract for the main topic
events/
  order-placed/
    asyncapi.yaml      # Topic-specific contract (prioritized by path match)
  order-shipped/
    schema.json        # JSON Schema fallback
contracts/
  notifications/
    asyncapi.yaml      # Generated AsyncAPI artifact (scanned at level 3)
```

**Example output directory** after SNS resolution:

```
discovered-specs/
  order-events/
    asyncapi.yaml                    # Primary contract
    sns-resolution-metadata.json     # Metadata sidecar (always emitted)
    webhook.openapi.json             # Webhook sidecar (when HTTP/S subscriptions exist)
```

**Topic naming**: The `postman:project-name` tag on the SNS topic is used as the service name. If no tag is set, the topic name from the ARN is used as a fallback.

**SSM integration for SNS**: When repo-local contracts are not found, the action checks SSM Parameter Store at `/postman/specs/{service-name}/`. Matching is fuzzy: `.fifo` suffixes are stripped and camelCase names are normalized to kebab-case. Inline `content` entries are preferred; if no content exists, `url` or `spec-url` entries are fetched using the shared spec fetcher (HTTPS only). On fetch failure, a pointer-style artifact is emitted. Example SSM registration:

```bash
aws ssm put-parameter \
  --name /postman/specs/order-events/content \
  --type String \
  --overwrite \
  --value '{"asyncapi":"2.6.0","info":{"title":"Order Events"},"channels":{}}'

aws ssm put-parameter \
  --name /postman/specs/order-events/format \
  --type String \
  --overwrite \
  --value asyncapi-json
```

### GitLab / other CI

```bash
node dist/cli.cjs \
  --aws-region us-east-1 \
  --repo-root "$CI_PROJECT_DIR" \
  --result-json "$CI_PROJECT_DIR/postman-aws-spec-discovery-result.json" \
  --dotenv-path "$CI_PROJECT_DIR/postman-aws-spec-discovery.env"
```

### Bitbucket Pipelines

```bash
node dist/cli.cjs \
  --aws-region us-east-1
```

### Azure DevOps

```bash
node dist/cli.cjs \
  --aws-region us-east-1
```

### CLI environment variables

When using `--dotenv-path`, the CLI writes action outputs as environment variables. Additional SNS and derived OpenAPI variables include:

| Variable | Description |
| --- | --- |
| `POSTMAN_AWS_SPEC_CONTRACT_ORIGIN` | SNS contract provenance (e.g. `repo-asyncapi`, `ssm-url`, `code-derived`) |
| `POSTMAN_AWS_SPEC_CONTRACT_METADATA_PATH` | Path to `sns-resolution-metadata.json` sidecar |
| `POSTMAN_AWS_SPEC_VARIANT_COUNT` | Number of SNS delivery variants discovered |
| `POSTMAN_AWS_SPEC_DERIVED_OPENAPI_PATH` | Path to `openapi.derived.json` when available |
| `POSTMAN_AWS_SPEC_DERIVED_OPENAPI_VERSION` | OpenAPI version of the derived sidecar |
| `POSTMAN_AWS_SPEC_DERIVED_OPENAPI_COMPLETENESS` | `full` or `partial` derivation quality |
| `POSTMAN_AWS_SPEC_DERIVED_OPENAPI_FORMAT` | Derived sidecar format, currently `openapi-json` |
| `POSTMAN_AWS_SPEC_DERIVED_OPENAPI_EVIDENCE_JSON` | JSON array of derivation evidence |

## How auto-detection works

**IAM probing**: At startup, the action probes each provider with a lightweight read call. If the call succeeds, that provider is included. If it fails (access denied, service not available), it is silently skipped.

**Progressive narrowing**: When an AWS account has many API Gateway APIs, the action narrows candidates automatically instead of failing:

1. **IaC fingerprinting** -- extract gateway IDs from `template.yaml`, `serverless.yml`, and similar files already in the repo
2. **CloudFormation stack correlation** -- find stacks named after the repo, extract API resource physical IDs
3. **Tag-based pre-filtering** -- query the Resource Groups Tagging API for resources tagged `postman:repo`, `repository`, or similar
4. **Naming heuristic** -- match the slugified repo name against API names
5. **Full enumeration** -- only as a last resort, with soft truncation instead of hard failure

**Repository signals**: The action scans bounded IaC, workflow, and service config files for references to AWS services. Supported IaC frameworks include CloudFormation/SAM, Terraform, CDK, and Pulumi.

CloudFormation / SAM:
- `template.yaml`, `template.yml`, `serverless.yml`, `serverless.yaml`
- Resource types: `AWS::ApiGateway::RestApi`, `AWS::ApiGatewayV2::Api`, `AWS::Serverless::Api`, `AWS::Serverless::HttpApi`, `AWS::AppSync::GraphQLApi`, `AWS::Serverless::GraphQLApi`, `AWS::Events::EventBus`, `AWS::Serverless::EventBridgeRule`, `SchemaRegistry`, `AWS::Glue::Schema`, `AWS::Glue::Registry`, `AWS::SNS::Topic`, `AWS::SNS::Subscription`, `AWS::Lambda::Url`, `FunctionUrlConfig`
- SNS-specific patterns: `Type: SNS` (SAM event bindings), `arn:aws:sns:` (topic ARN references)

Terraform:
- All `.tf` files (searched up to 4 directories deep, max 50 files)
- Resource types: `aws_api_gateway_rest_api`, `aws_apigatewayv2_api`, `aws_appsync_graphql_api`, `aws_schemas_schema`, `aws_cloudwatch_event_bus`, `aws_glue_schema`, `aws_sns_topic`, `aws_sns_topic_subscription`, `aws_lambda_function_url`

CDK:
- Detected when `cdk.json` is present; scans TypeScript, JavaScript, Python, Java, and C# sources for AWS constructs
- Resource constructors: `aws-cdk-lib/aws-apigateway`, `aws-cdk-lib/aws-apigatewayv2`, Python `aws_cdk.aws_apigateway*`, Java `software.amazon.awscdk.services.apigateway*`, C# `Amazon.CDK.AWS.APIGateway*`, `aws-cdk-lib/aws-appsync`, `aws-cdk-lib/aws-events`, `aws-cdk-lib/aws-sns`, `aws-cdk-lib/aws-lambda`
- Lambda URL patterns: `addFunctionUrl(`, `FunctionUrlAuthType`
- SNS-specific patterns: `new sns.Topic(`, `sns.Topic.fromTopicArn(`, `SnsEventSource`

Pulumi:
- Detected when `Pulumi.yaml` is present; scans YAML resources plus `.ts`, `.py`, `.go`, `.java`, and `.cs` source files
- Resource constructors: `aws.apigateway.RestApi`, `aws.apigatewayv2.Api`, `aws:apigatewayv2/api:Api`, `.NET Aws.ApiGatewayV2.Api`, Java `com.pulumi.aws.apigatewayv2.Api`, `aws.appsync.GraphQLApi`, `aws.sns.Topic`, `aws.lambda.FunctionUrl`

Additional signal sources:
- `.graphql` / `.gql` files in common locations (`schema.graphql`, `graphql/schema.graphql`, `src/schema.graphql`) for AppSync hints
- GitHub Actions workflows, `.gitlab-ci.yml`, CircleCI, Buildkite, Serverless variants, `samconfig.toml`, Helm/Kubernetes Ingress manifests, docker-compose, ECS task/service JSON, `application.yml`, `appsettings.json`, OpenAPI generator configs, and `README.md` are scanned for embedded gateway IDs, custom domains, Lambda URL hosts, and provider hints
- Lambda Function URL hosts matching `{id}.lambda-url.{region}.on.aws` are scanned as Lambda URL evidence
- When SNS IaC signals are detected, the action also scans nearby directories for AsyncAPI and JSON Schema files as contract evidence

**Gateway ID extraction**: The action extracts API Gateway IDs from repo files using these patterns:
- Execute-API URLs: `https://{id}.execute-api.{region}.amazonaws.com`
- CLI flags: `--rest-api-id {id}`, `--api-id {id}`
- ARN paths: `restapis/{id}`
- Environment variables: `REST_API_ID={id}`, `HTTP_API_ID={id}`, `API_GATEWAY_ID={id}`

**Lambda Function URL behavior**: Lambda Function URLs do not have an AWS-native OpenAPI export. When a function URL is discovered, the action synthesizes an OpenAPI 3.0 YAML file with the function URL as the server, a catch-all `/{proxy}` path for common HTTP methods, an AWS SigV4 security scheme when `AuthType=AWS_IAM`, and `x-aws-*` extensions for the function ARN, auth type, invoke mode, and CORS config. In `resolve-one`, Lambda URL candidates are scored with other providers; API Gateway wins exact-confidence ties because it has a native export.

**Existing specs**: The action checks known spec paths, then performs a bounded deterministic scan of common documentation and service roots before calling AWS. If a valid OpenAPI, Swagger, GraphQL, AsyncAPI, Postman collection, protobuf, or Smithy artifact is found, it is used as the primary artifact and `openapi.derived.json` is emitted when a derived OpenAPI representation is available.

```
openapi.yaml          openapi.yml          openapi.json
api.yaml              api.yml              api.json
oas.yaml              oas.yml              oas.json
swagger.yaml          swagger.yml          swagger.json
openapi.v1.yaml       swagger.v2.yaml
spec/openapi.yaml     spec/openapi.yml     spec/openapi.json
api/openapi.yaml      api/openapi.yml      api/openapi.json
docs/openapi.yaml     docs/openapi.yml     docs/openapi.json
reference/openapi.v1.yaml    public/openapi.yaml
schema.graphql        schema.gql
graphql/schema.graphql    graphql/schema.gql
api/schema.graphql    src/schema.graphql
asyncapi.yaml         asyncapi.yml         asyncapi.json
smithy-build.json
```

Files are validated before use. OpenAPI files must contain an `openapi` or `swagger` top-level key, GraphQL files must contain a `type Query` or `schema {}` block, and native API formats are parsed conservatively before derivation.

### Candidate scoring

When multiple API Gateway candidates are found, the action scores each one to pick the best match:

| Signal | Points | Description |
| --- | --- | --- |
| Explicit gateway ID match | +100 | Candidate ID appears in `gateway-id` or `expected-gateway-ids-json` |
| Tag value matches service hint | +40 | Any tag value on the gateway contains the service name hint |
| Gateway name matches service hint | +30 | The API name contains the inferred or explicit service name |
| Inferred gateway ID match | +25 | Candidate ID was extracted from repo IaC files or deploy workflows |

A candidate must reach a confidence score of **40 or higher** to be auto-resolved. Below that threshold the action returns `manual-review` status. When two candidates tie, the result is marked ambiguous.

### SNS candidate scoring

SNS topics are scored separately from API Gateway candidates. When multiple topics exist, each is scored against service name hints (from `expected-service-name`, repo slug, or repo URL):

| Signal | Points | Description |
| --- | --- | --- |
| Exact name match | +60 | Topic name matches a service hint exactly (after FIFO suffix stripping) |
| `postman:project-name` tag match | +50 | The `postman:project-name` tag value matches a service hint exactly |
| Partial name match | +40 | Topic name contains the service hint or vice versa |
| Tag value contains hint | +20 | Any tag value on the topic contains the service hint |

Topics are sorted by score (highest first). On a tie, topics are sorted alphabetically. The resolved confidence is the maximum of 60 or the candidate score. FIFO topics (`.fifo` suffix) are handled transparently -- the suffix is stripped during name normalization for scoring.

The `max-candidates` input also applies to SNS: if more topics exist than the cap, only the top-scored topics are tried.

### SNS edge cases

- **FIFO topics**: The `.fifo` suffix is stripped during topic naming and SSM matching but preserved in the topic ARN.
- **Path traversal protection**: Topic names are validated against the repo root before writing output files. Names that would escape the workspace are rejected.
- **Attribute/tag fetch failures**: If `sns:GetTopicAttributes` or `sns:ListTagsForResource` fails for a specific topic, the topic still becomes a candidate with empty attributes/tags.
- **Subscription fetch failures**: If `sns:ListSubscriptionsByTopic` or `sns:GetSubscriptionAttributes` is denied, the metadata sidecar is still emitted with empty subscription data. Resolution continues without variant enrichment.
- **File scan limits**: Contract file scanning uses the same limits as IaC scanning: maximum 50 files, maximum directory depth of 4.
- **Probe failure**: If the SNS probe fails, it is non-fatal in both modes. In `resolve-one`, the action falls back to `manual-review`. In `discover-many`, the SNS provider is silently skipped.
- **EventBridge-derived fallback**: Only attempted when no direct SNS contract source exists and bridge evidence is present. Transformed events are flagged as such in the metadata sidecar. Does not replace the native EventBridge provider.
- **Code-derived fallback**: Only runs after all stronger sources fail. Ambiguous candidates fall through to manual review rather than guessing. Supported frameworks: Zod, TypeBox, JSON Schema definitions, and Springwolf.
- **Dry run**: SNS respects `dry-run` -- topics are listed and contracts are resolved but no files are written to disk.

### Service name resolution

The resolved service name follows this priority:

1. `postman:project-name` tag on the AWS resource
2. `Name` tag on the AWS resource
3. `service-mapping-json` entry for the gateway ID (if provided)
4. API Gateway name

### Stage auto-selection

When no explicit `stage` input is provided, the action selects a stage automatically:

1. If only one stage is deployed, it is used
2. If multiple stages exist, the first match from this priority list is selected:
   `prod` > `production` > `$default` > `main` > `staging` > `stage` > `dev` > `development`
3. If no match is found, the result is `manual-review` with the available stages listed in evidence
4. For HTTP APIs with no deployed stages, the latest API configuration is exported without a stage

**Backstage catalog-info.yaml**: If a Backstage `catalog-info.yaml` (or `catalog-info.yml`) is present in the repo root or a bounded nested service/package/app directory with `kind: API` entities, the action resolves spec references automatically. Both simple string definitions and `$text` references are supported. Local paths are resolved relative to the catalog file that declared them. Multi-document YAML files with multiple `kind: API` entities are parsed; in `resolve-one` mode the first API's spec reference is used.

Supported definition formats:

```yaml
# Simple string -- local path
spec:
  definition: ./openapi.yaml

# Simple string -- remote URL
spec:
  definition: https://payments.example.com/openapi.yaml

# $text reference -- local path or remote URL
spec:
  definition:
    $text: https://payments.example.com/openapi.yaml
```

Example `catalog-info.yaml` using a remote OpenAPI document:

```yaml
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: payments-api
spec:
  type: openapi
  owner: payments-platform
  lifecycle: production
  definition: https://payments.example.com/openapi.yaml
```

With that file committed at the repo root or inside a bounded service directory, the action resolves the spec URL automatically. No extra action inputs are required.

**SSM Parameter Store**: If your IAM role has `ssm:GetParametersByPath` access, the action checks `/postman/specs/` for registered spec URLs or content. Stored content is used directly; HTTPS URLs are fetched automatically. This is the recommended zero-config way to register specs for services that run on EKS, ECS, or behind ALBs.

### SSM spec registry convention

Store your spec reference in SSM Parameter Store:

```
/postman/specs/{service-name}/url       -> https://api.example.com/openapi.json
/postman/specs/{service-name}/content   -> {"openapi":"3.0.0",...}
/postman/specs/{service-name}/format    -> openapi-json
```

The action discovers these automatically. No action configuration needed.

Example SSM registration with a remote OpenAPI document:

```bash
aws ssm put-parameter \
  --name /postman/specs/payments-api/url \
  --type String \
  --overwrite \
  --value https://payments.example.com/openapi.json

aws ssm put-parameter \
  --name /postman/specs/payments-api/format \
  --type String \
  --overwrite \
  --value openapi-json
```

Once those parameters exist, the action fetches the spec automatically during discovery. No repo changes or action inputs are needed.

The SSM provider also recognizes `spec-url`, `spec-content`, and `spec-format` as alternative parameter key suffixes alongside `url`, `content`, and `format`.

If the URL cannot be fetched safely (for example non-HTTPS, timeout, or oversized response), the action writes a `spec-pointer.json` artifact for manual follow-up instead of silently accepting bad content:

```json
{
  "specUrl": "https://api.example.com/openapi.json",
  "serviceName": "payments-api",
  "registeredVia": "ssm-parameter-store",
  "fetchError": "HTTP 503 fetching https://api.example.com/openapi.json"
}
```

### Tag convention

Tag your AWS resources for instant narrowing in broad accounts:

```
postman:repo = org/repo-name
```

The action checks this tag via the Resource Groups Tagging API before enumerating all APIs.

### CI provider auto-detection

The action auto-detects repository context from CI environment variables. Manual overrides are available via repo context inputs (see [Repo context overrides](#repo-context-overrides)).

| CI platform | Provider | Repo URL source | Slug source | Ref source | SHA source |
| --- | --- | --- | --- | --- | --- |
| GitHub Actions | `github` | `GITHUB_SERVER_URL` + `GITHUB_REPOSITORY` | `GITHUB_REPOSITORY` | `GITHUB_REF_NAME` | `GITHUB_SHA` |
| GitLab CI | `gitlab` | `CI_PROJECT_URL` | `CI_PROJECT_PATH` | `CI_COMMIT_REF_NAME` | `CI_COMMIT_SHA` |
| Bitbucket Pipelines | `bitbucket` | `BITBUCKET_GIT_HTTP_ORIGIN` | `BITBUCKET_WORKSPACE`/`BITBUCKET_REPO_SLUG` | `BITBUCKET_BRANCH` | `BITBUCKET_COMMIT` |
| Azure DevOps | `azure-devops` | `BUILD_REPOSITORY_URI` | `BUILD_REPOSITORY_NAME` | `BUILD_SOURCEBRANCHNAME` | `BUILD_SOURCEVERSION` |

SSH-style repo URLs (for example `git@github.com:org/repo.git`) are automatically normalized to HTTPS.

## Troubleshooting

- `AWS credentials are missing or invalid`
  - Ensure CI auth step runs before this action (`aws-actions/configure-aws-credentials` or equivalent).
- `Candidate count exceeds max-candidates`
  - Account is too broad for automatic resolution. Prefer a known `gateway-id` or use the CLI.
- `manual-review` status
  - Ambiguity, stage selection conflict, or API Gateway export limitations.
- `Output path must stay within workspace/repo-root`
  - Use relative paths under `repo-root`; path escapes are blocked by design.
- Provider silently skipped
  - Check IAM permissions. The action logs which providers are available at startup.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

### Live integration tests

Live tests run the built CLI against real AWS resources. See [docs/LIVE_TESTING_RUNBOOK.md](docs/LIVE_TESTING_RUNBOOK.md) for full setup instructions.

```bash
# Prerequisites: AWS credentials configured, stack deployed, CLI built
npm run build
npm run test:live:sns
```

> **Important:** Live tests execute `dist/cli.cjs`, not source TypeScript. Always rebuild before running live tests.

## Versioning policy

- Action follows SemVer.
- Breaking changes include input/output renames, output type changes, or behavioral contract changes.

## License

MIT

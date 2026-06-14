# Provider Deep Dive

This document covers every discovery surface in detail: artifacts, OpenAPI derivation behavior, auto-detection signals, IAM requirements, scoring, and tuning. For SNS contract resolution specifics, see [sns-contract-resolution.md](sns-contract-resolution.md).

## Full provider table

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

The action also detects Backstage `catalog-info.yaml` files in the repo root or bounded nested service directories and resolves API spec path or URL references automatically.

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

Native artifacts are preserved as the primary output. The action also emits `openapi.derived.json` when it can represent the selected artifact as OpenAPI for downstream onboarding and review. Canonical derived sidecars are always parseable JSON; GraphQL-derived sidecars preserve operation names, variable shapes, and schema components, AsyncAPI-derived sidecars preserve channel payload schemas, examples, and `x-asyncapi-*` channel metadata, Postman-derived sidecars preserve request parameters, JSON examples, auth metadata, and response examples when present, and JSON Schema/Avro-derived sidecars preserve named component schemas with `$ref` request bodies. Provider-specific sidecars such as SNS `webhook.openapi.json` remain separate. See [`validation/evidence/README.md`](../validation/evidence/README.md) for the current evidence ledger.

## Security and IAM

This action is read-only against AWS APIs and does not mutate AWS resources.

Recommended GitHub Actions permissions when using AWS OIDC:

```yaml
permissions:
  id-token: write
  contents: read
```

`id-token: write` lets `aws-actions/configure-aws-credentials` request a GitHub OIDC token and assume your AWS role. `contents: read` lets the workflow check out the repository so this action can scan repo-local specs and IaC signals. The action itself does not need a GitHub token.

Example trust policy condition for the AWS role:

```json
{
  "Effect": "Allow",
  "Principal": {
    "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
  },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
    },
    "StringLike": {
      "token.actions.githubusercontent.com:sub": "repo:ORG/REPO:*"
    }
  }
}
```

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

You only need permissions for the providers you use. Providers you lack access to are silently skipped. SNS-specific permission notes live in [sns-contract-resolution.md](sns-contract-resolution.md).

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

## Candidate scoring

When multiple API Gateway candidates are found, the action scores each one to pick the best match:

| Signal | Points | Description |
| --- | --- | --- |
| Explicit gateway ID match | +100 | Candidate ID appears in `gateway-id` or `expected-gateway-ids-json` |
| Tag value matches service hint | +40 | Any tag value on the gateway contains the service name hint |
| Gateway name matches service hint | +30 | The API name contains the inferred or explicit service name |
| Inferred gateway ID match | +25 | Candidate ID was extracted from repo IaC files or deploy workflows |

A candidate must reach a confidence score of **40 or higher** to be auto-resolved. Below that threshold the action returns `manual-review` status. When two candidates tie, the result is marked ambiguous.

## Service name resolution

The resolved service name follows this priority:

1. `postman:project-name` tag on the AWS resource
2. `Name` tag on the AWS resource
3. `service-mapping-json` entry for the gateway ID (if provided)
4. API Gateway name

## Stage auto-selection

When no explicit `stage` input is provided, the action selects a stage automatically:

1. If only one stage is deployed, it is used
2. If multiple stages exist, the first match from this priority list is selected:
   `prod` > `production` > `$default` > `main` > `staging` > `stage` > `dev` > `development`
3. If no match is found, the result is `manual-review` with the available stages listed in evidence
4. For HTTP APIs with no deployed stages, the latest API configuration is exported without a stage

## Backstage catalog-info.yaml

If a Backstage `catalog-info.yaml` (or `catalog-info.yml`) is present in the repo root or a bounded nested service/package/app directory with `kind: API` entities, the action resolves spec references automatically. Both simple string definitions and `$text` references are supported. Local paths are resolved relative to the catalog file that declared them. Multi-document YAML files with multiple `kind: API` entities are parsed; in `resolve-one` mode the first API's spec reference is used.

Supported definition formats:

```yaml
# Simple string -- local path
spec:
  definition: ./openapi.yaml

# Simple string -- remote URL
spec:
  definition: https://raw.githubusercontent.com/postman-cs/postman-aws-spec-discovery-action/main/examples/core-payments-openapi.yaml

# $text reference -- local path or remote URL
spec:
  definition:
    $text: https://raw.githubusercontent.com/postman-cs/postman-aws-spec-discovery-action/main/examples/core-payments-openapi.yaml
```

Example `catalog-info.yaml` using a remote OpenAPI document:

```yaml
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: telecom-api
spec:
  type: openapi
  owner: api-platform
  lifecycle: production
  definition: https://raw.githubusercontent.com/postman-cs/postman-aws-spec-discovery-action/main/examples/core-payments-openapi.yaml
```

With that file committed at the repo root or inside a bounded service directory, the action resolves the spec URL automatically. No extra action inputs are required.

## SSM spec registry convention

If your IAM role has `ssm:GetParametersByPath` access, the action checks `/postman/specs/` for registered spec URLs or content. Stored content is used directly; HTTPS URLs are fetched automatically. This is the recommended zero-config way to register specs for services that run on EKS, ECS, or behind ALBs.

Store your spec reference in SSM Parameter Store:

```
/postman/specs/{service-name}/url       -> https://raw.githubusercontent.com/postman-cs/postman-aws-spec-discovery-action/main/examples/core-payments-openapi.yaml
/postman/specs/{service-name}/content   -> {"openapi":"3.0.0",...}
/postman/specs/{service-name}/format    -> openapi-yaml
```

The action discovers these automatically. No action configuration needed.

Example SSM registration with a remote OpenAPI document:

```bash
aws ssm put-parameter \
  --name /postman/specs/telecom-api/url \
  --type String \
  --overwrite \
  --value https://raw.githubusercontent.com/postman-cs/postman-aws-spec-discovery-action/main/examples/core-payments-openapi.yaml

aws ssm put-parameter \
  --name /postman/specs/telecom-api/format \
  --type String \
  --overwrite \
  --value openapi-yaml
```

Once those parameters exist, the action fetches the spec automatically during discovery. No repo changes or action inputs are needed.

The SSM provider also recognizes `spec-url`, `spec-content`, and `spec-format` as alternative parameter key suffixes alongside `url`, `content`, and `format`.

If the URL cannot be fetched safely (for example non-HTTPS, timeout, or oversized response), the action writes a `spec-pointer.json` artifact for manual follow-up instead of silently accepting bad content:

```json
{
  "specUrl": "https://raw.githubusercontent.com/postman-cs/postman-aws-spec-discovery-action/main/examples/core-payments-openapi.yaml",
  "serviceName": "telecom-api",
  "registeredVia": "ssm-parameter-store",
  "fetchError": "HTTP 503 fetching https://raw.githubusercontent.com/postman-cs/postman-aws-spec-discovery-action/main/examples/core-payments-openapi.yaml"
}
```

## Tag convention

Tag your AWS resources for instant narrowing in broad accounts:

```
postman:repo = org/repo-name
```

The action checks this tag via the Resource Groups Tagging API before enumerating all APIs.

## CI provider auto-detection

The action auto-detects repository context from CI environment variables. Manual overrides are available via repo context inputs (see [Resolution tuning inputs](#resolution-tuning-inputs)).

| CI platform | Provider | Repo URL source | Slug source | Ref source | SHA source |
| --- | --- | --- | --- | --- | --- |
| GitHub Actions | `github` | `GITHUB_SERVER_URL` + `GITHUB_REPOSITORY` | `GITHUB_REPOSITORY` | `GITHUB_REF_NAME` | `GITHUB_SHA` |
| GitLab CI | `gitlab` | `CI_PROJECT_URL` | `CI_PROJECT_PATH` | `CI_COMMIT_REF_NAME` | `CI_COMMIT_SHA` |
| Bitbucket Pipelines | `bitbucket` | `BITBUCKET_GIT_HTTP_ORIGIN` | `BITBUCKET_WORKSPACE`/`BITBUCKET_REPO_SLUG` | `BITBUCKET_BRANCH` | `BITBUCKET_COMMIT` |
| Azure DevOps | `azure-devops` | `BUILD_REPOSITORY_URI` | `BUILD_REPOSITORY_NAME` | `BUILD_SOURCEBRANCHNAME` | `BUILD_SOURCEVERSION` |

SSH-style repo URLs (for example `git@github.com:org/repo.git`) are automatically normalized to HTTPS.

## Resolution tuning inputs

These inputs are optional and rarely needed. They are set via environment variables prefixed with `INPUT_` (for example `INPUT_EXPECTED_SERVICE_NAME`).

| Input | Default | Notes |
| --- | --- | --- |
| `mode` | `resolve-one` | `resolve-one` resolves a single best spec; `discover-many` exports all discovered APIs across all providers |
| `expected-service-name` | auto-detected | Explicit service name hint used for candidate scoring |
| `expected-gateway-ids-json` | `[]` | JSON array of gateway IDs to look up directly (bypasses enumeration) |
| `api-filter` | none | Regex filter applied to API names before scoring |
| `service-mapping-json` | `{}` | JSON object mapping gateway IDs to service names |
| `include-v2` | `true` | Include HTTP and WebSocket APIs (API Gateway v2) in discovery |
| `max-candidates` | `50` | Soft cap on candidates before triggering progressive narrowing or truncation |
| `dry-run` | `false` | Run resolution logic without writing spec files to disk |

Preflight and reliability inputs:

| Input | Default | Notes |
| --- | --- | --- |
| `preflight-checks` | `true` | Enable preflight STS identity and permission validation |
| `preflight-permission-probe` | `true` | Enable the IAM permission probe specifically (requires `preflight-checks`) |
| `request-timeout-ms` | `30000` | Per-request timeout in milliseconds for AWS SDK calls |
| `max-attempts` | `3` | AWS SDK retry count for transient failures |

These preflight settings only cover AWS identity and permission checks. Postman credential preflight is configured on the downstream bootstrap or composite action and supports `warn` and `enforce` only.

Repo context overrides (auto-detected from CI environment variables; override only when auto-detection is unavailable or incorrect):

| Input | Notes |
| --- | --- |
| `repo-root` | Workspace root directory (auto-detected from `GITHUB_WORKSPACE`, `CI_PROJECT_DIR`, `BITBUCKET_CLONE_DIR`, or `BUILD_SOURCESDIRECTORY`) |
| `repo-url` | Repository HTTPS URL |
| `repo-slug` | Repository slug (`org/repo-name`) |
| `git-provider` | `github`, `gitlab`, `bitbucket`, or `azure-devops` |
| `ref` | Branch or tag ref |
| `sha` | Commit SHA |

## OpenAPI normalization (API Gateway exports)

API Gateway populates `operationId` from each integration's request name, which is often the bare HTTP method (`get`, `update`, `post`) or omitted entirely. That yields specs with duplicate or missing `operationId` values, which fail OpenAPI 3.x validation (every operation must have a unique `operationId`) and are rejected downstream by the Postman bootstrap action with `CONTRACT_SPEC_VALIDATION_FAILED`.

After every API Gateway export the action runs a deterministic normalizer on the OpenAPI document before writing it to disk:

- Operations whose `operationId` is empty get one synthesized from method and path (e.g. `getV1OrdersOrderId`).
- The first occurrence of any `operationId` is preserved verbatim, so existing references stay valid.
- Subsequent duplicates are renamed `<base>_<slugifiedPath>` (e.g. `update` -> `update_v1_account`). Further collisions fall back to a numeric tiebreaker (`update_v1_account_2`).

Every rewrite is logged with the path and method so the diff against the raw AWS export is visible in the action run. Normalization is best-effort: if the document is not OpenAPI (or fails to parse), the raw spec is written unchanged and the bootstrap action's validator remains the source of truth.

## CLI usage (GitLab, Bitbucket, Azure DevOps)

The action ships a portable Node CLI at `dist/cli.cjs` for non-GitHub CI.

GitLab:

```bash
node dist/cli.cjs \
  --aws-region us-east-1 \
  --repo-root "$CI_PROJECT_DIR" \
  --result-json "$CI_PROJECT_DIR/postman-aws-spec-discovery-result.json" \
  --dotenv-path "$CI_PROJECT_DIR/postman-aws-spec-discovery.env"
```

Bitbucket Pipelines or Azure DevOps:

```bash
node dist/cli.cjs \
  --aws-region us-east-1
```

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

Live tests run the built CLI against real AWS resources. See [LIVE_TESTING_RUNBOOK.md](LIVE_TESTING_RUNBOOK.md) for full setup instructions.

```bash
# Prerequisites: AWS credentials configured, stack deployed, CLI built
npm run build
npm run test:live:sns
```

> **Important:** Live tests execute `dist/cli.cjs`, not source TypeScript. Always rebuild before running live tests.

## Versioning policy

- Action follows SemVer.
- Breaking changes include input/output renames, output type changes, or behavioral contract changes.

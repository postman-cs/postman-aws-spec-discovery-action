# postman-aws-spec-discovery-action

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

| Provider | Spec format | Auto-detected via |
| --- | --- | --- |
| API Gateway REST | OpenAPI 3.0 YAML | IAM probe |
| API Gateway HTTP | OpenAPI 3.0 YAML | IAM probe |
| API Gateway WebSocket | OpenAPI 3.0 YAML | IAM probe |
| AppSync GraphQL | GraphQL SDL | IAM probe + `.graphql` files in repo |
| EventBridge Schema Registry | JSON Schema / OpenAPI | IAM probe + IaC references |
| CloudFormation (embedded specs) | OpenAPI JSON | IAM probe |
| Glue Schema Registry | Avro / JSON Schema / Protobuf | IAM probe + IaC references |
| SSM Parameter Store | Any (stored content or fetched URL content) | IAM probe for `/postman/specs/` path |

Each provider is probed at startup. If your role lacks permission for a provider, it is silently skipped. No configuration needed.

The action also detects Backstage `catalog-info.yaml` files in the repo root and resolves API spec path or URL references automatically.

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
        "appsync:ListTagsForResource",
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
        "ssm:GetParametersByPath",
        "tag:GetResources"
      ],
      "Resource": "*"
    }
  ]
}
```

You only need permissions for the providers you use. Providers you lack access to are silently skipped.

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
| `source-type` | `repo-spec`, `gateway-export`, `appsync-schema`, `eventbridge-schema`, `cfn-embedded`, `glue-schema`, `ssm-registry`, `manual-review`, or `discover-many` |
| `mapping-confidence` | Numeric confidence score |
| `spec-path` | Resolved/generated spec path when available |
| `gateway-id` | Selected gateway ID when available |
| `service-name` | Resolved service name |
| `provider-type` | Provider that resolved the spec (`api-gateway`, `appsync`, `eventbridge-schemas`, `cloudformation`, `glue`, `ssm`) |
| `spec-format` | Format of the spec (`openapi-yaml`, `openapi-json`, `graphql-sdl`, `json-schema`, `avro`, `protobuf`) |
| `candidates-json` | JSON array of top candidates when resolution is ambiguous |
| `services-json` | discover-many mode: JSON array of all discovered services |
| `service-count` | discover-many mode: number of discovered services |
| `export-summary-json` | discover-many summary: attempted/exported/failed/skipped |

## Output file formats

| Provider | Filename | Format |
| --- | --- | --- |
| API Gateway (REST/HTTP/WebSocket) | `index.yaml` | OpenAPI 3.0 YAML |
| AppSync | `schema.graphql` | GraphQL SDL |
| EventBridge Schema Registry | `index.json` | JSON Schema |
| CloudFormation (embedded) | `index.json` | OpenAPI JSON |
| Glue (Avro) | `schema.avsc` | Avro |
| Glue (JSON Schema) | `schema.json` | JSON Schema |
| Glue (Protobuf) | `schema.proto` | Protocol Buffers |
| SSM Parameter Store | auto-detected | Any (spec content or fetched URL content) |

## Usage

### GitHub minimal

```yaml
- id: resolve
  uses: postman-cs/postman-aws-spec-discovery-action@v0.4.0
  with:
    aws-region: us-east-1
```

### GitHub with known gateway ID

```yaml
- id: resolve
  uses: postman-cs/postman-aws-spec-discovery-action@v0.4.0
  with:
    aws-region: us-east-1
    gateway-id: abc123def4
```

### discover-many mode

Exports specs from all discovered APIs across all available providers:

```yaml
- id: discover
  uses: postman-cs/postman-aws-spec-discovery-action@v0.4.0
  env:
    INPUT_MODE: discover-many
  with:
    aws-region: us-east-1
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

## How auto-detection works

**IAM probing**: At startup, the action probes each provider with a lightweight read call. If the call succeeds, that provider is included. If it fails (access denied, service not available), it is silently skipped.

**Progressive narrowing**: When an AWS account has many API Gateway APIs, the action narrows candidates automatically instead of failing:

1. **IaC fingerprinting** -- extract gateway IDs from `template.yaml`, `serverless.yml`, and similar files already in the repo
2. **CloudFormation stack correlation** -- find stacks named after the repo, extract API resource physical IDs
3. **Tag-based pre-filtering** -- query the Resource Groups Tagging API for resources tagged `postman:repo`, `repository`, or similar
4. **Naming heuristic** -- match the slugified repo name against API names
5. **Full enumeration** -- only as a last resort, with soft truncation instead of hard failure

**Repository signals**: The action scans IaC files for references to AWS services. Supported IaC frameworks include CloudFormation/SAM, Terraform, and Pulumi.

CloudFormation / SAM:
- `template.yaml`, `template.yml`, `serverless.yml`, `serverless.yaml`, `cdk.json`
- Resource types: `AWS::ApiGateway::RestApi`, `AWS::ApiGatewayV2::Api`, `AWS::Serverless::Api`, `AWS::Serverless::HttpApi`, `AWS::AppSync::GraphQLApi`, `AWS::Serverless::GraphQLApi`, `AWS::Events::EventBus`, `AWS::Serverless::EventBridgeRule`, `SchemaRegistry`, `AWS::Glue::Schema`, `AWS::Glue::Registry`

Terraform:
- All `.tf` files (searched up to 4 directories deep, max 50 files)
- Resource types: `aws_api_gateway_rest_api`, `aws_apigatewayv2_api`, `aws_appsync_graphql_api`, `aws_schemas_schema`, `aws_cloudwatch_event_bus`, `aws_glue_schema`

Pulumi:
- Detected when `Pulumi.yaml` is present; scans `.ts`, `.py`, and `.go` source files
- Resource constructors: `aws.apigateway.RestApi`, `aws.apigatewayv2.Api`, `aws.appsync.GraphQLApi`

Additional signal sources:
- `.graphql` / `.gql` files in common locations (`schema.graphql`, `graphql/schema.graphql`, `src/schema.graphql`) for AppSync hints
- `.github/workflows/deploy.yml`, `.gitlab-ci.yml`, and `README.md` are scanned for embedded gateway IDs

**Gateway ID extraction**: The action extracts API Gateway IDs from repo files using these patterns:
- Execute-API URLs: `https://{id}.execute-api.{region}.amazonaws.com`
- CLI flags: `--rest-api-id {id}`, `--api-id {id}`
- ARN paths: `restapis/{id}`
- Environment variables: `REST_API_ID={id}`, `HTTP_API_ID={id}`, `API_GATEWAY_ID={id}`

**Existing specs**: The action checks 22 specific file paths before calling AWS. If a valid OpenAPI or GraphQL spec is found at any of these locations, it is used directly:

```
openapi.yaml          openapi.yml          openapi.json
swagger.yaml          swagger.yml          swagger.json
spec/openapi.yaml     spec/openapi.yml     spec/openapi.json
api/openapi.yaml      api/openapi.yml      api/openapi.json
docs/openapi.yaml     docs/openapi.yml     docs/openapi.json
schema.graphql        schema.gql
graphql/schema.graphql    graphql/schema.gql
api/schema.graphql    src/schema.graphql
```

Files are validated before use -- OpenAPI files must contain an `openapi` or `swagger` top-level key, and GraphQL files must contain a `type Query` or `schema {}` block.

### Candidate scoring

When multiple API Gateway candidates are found, the action scores each one to pick the best match:

| Signal | Points | Description |
| --- | --- | --- |
| Explicit gateway ID match | +100 | Candidate ID appears in `gateway-id` or `expected-gateway-ids-json` |
| Tag value matches service hint | +40 | Any tag value on the gateway contains the service name hint |
| Gateway name matches service hint | +30 | The API name contains the inferred or explicit service name |
| Inferred gateway ID match | +25 | Candidate ID was extracted from repo IaC files or deploy workflows |

A candidate must reach a confidence score of **40 or higher** to be auto-resolved. Below that threshold the action returns `manual-review` status. When two candidates tie, the result is marked ambiguous.

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

**Backstage catalog-info.yaml**: If a Backstage `catalog-info.yaml` (or `catalog-info.yml`) is present in the repo root with `kind: API` entities, the action resolves spec references automatically. Both simple string definitions and `$text` references are supported. Multi-document YAML files with multiple `kind: API` entities are parsed; in `resolve-one` mode the first API's spec reference is used.

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

With that file committed at the repo root, the action resolves the spec URL automatically. No extra action inputs are required.

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

## Versioning policy

- Action follows SemVer.
- Breaking changes include input/output renames, output type changes, or behavioral contract changes.

## License

MIT

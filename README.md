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

| Input | Required | Default | Notes |
| --- | --- | --- | --- |
| `aws-region` | yes | n/a | Region used for all AWS API calls |
| `gateway-id` | no | `''` | Optional known API Gateway ID to bypass broad discovery |
| `stage` | no | `''` | Optional stage override |
| `output-dir` | no | `discovered-specs` | Must resolve within `repo-root` |

Everything else is auto-resolved:
- Repo URL, slug, provider, ref, and SHA come from CI environment variables
- Available providers are auto-detected via IAM permission probing
- Repo signals (IaC files, schema files) inform provider selection
- Preflight auth and permission checks run before discovery
- Bounded discovery, retries, and timeouts use safe defaults

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

**Repository signals**: The action scans IaC files for references to AWS services:
- `template.yaml`, `serverless.yml`, `cdk.json` for CloudFormation resource types
- `.graphql` / `.gql` files for AppSync hints
- `AWS::Events::EventBus` or `SchemaRegistry` references for EventBridge
- `AWS::Glue::Schema` references for Glue

**Existing specs**: If the repo already has `openapi.yaml`, `swagger.json`, `schema.graphql`, or similar files, the action uses them directly without calling AWS.

**Backstage catalog-info.yaml**: If a Backstage `catalog-info.yaml` is present in the repo root with `kind: API` entities, the action uses a local `definition` path directly or fetches the referenced HTTPS URL automatically.

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

If the URL cannot be fetched safely (for example non-HTTPS, timeout, or oversized response), the action preserves the registration as a pointer artifact for manual follow-up instead of silently accepting bad content.

### Tag convention

Tag your AWS resources for instant narrowing in broad accounts:

```
postman:repo = org/repo-name
```

The action checks this tag via the Resource Groups Tagging API before enumerating all APIs.

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

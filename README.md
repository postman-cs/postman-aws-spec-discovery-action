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

Each provider is probed at startup. If your role lacks permission for a provider, it is silently skipped. No configuration needed.

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
        "glue:GetTags"
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
| `source-type` | `repo-spec`, `gateway-export`, `appsync-schema`, `eventbridge-schema`, `cfn-embedded`, `glue-schema`, `manual-review`, or `discover-many` |
| `mapping-confidence` | Numeric confidence score |
| `spec-path` | Resolved/generated spec path when available |
| `gateway-id` | Selected gateway ID when available |
| `service-name` | Resolved service name |
| `provider-type` | Provider that resolved the spec (`api-gateway`, `appsync`, `eventbridge-schemas`, `cloudformation`, `glue`) |
| `spec-format` | Format of the spec (`openapi-yaml`, `openapi-json`, `graphql-sdl`, `json-schema`, `avro`, `protobuf`) |
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

## How auto-detection works

**IAM probing**: At startup, the action probes each provider with a lightweight read call. If the call succeeds, that provider is included. If it fails (access denied, service not available), it is silently skipped.

**Repository signals**: The action scans IaC files for references to AWS services:
- `template.yaml`, `serverless.yml`, `cdk.json` for CloudFormation resource types
- `.graphql` / `.gql` files for AppSync hints
- `AWS::Events::EventBus` or `SchemaRegistry` references for EventBridge
- `AWS::Glue::Schema` references for Glue

**Existing specs**: If the repo already has `openapi.yaml`, `swagger.json`, `schema.graphql`, or similar files, the action uses them directly without calling AWS.

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

# postman-aws-spec-discovery-action

Resolve the best API specification source for the current service repository.

This project supports:
- GitHub Actions via `action.yml`
- Portable Node CLI via `dist/cli.cjs` (GitLab or other CI)

The GitHub Action is intentionally opinionated:
- You usually set only `aws-region`
- Repo identity comes from CI automatically
- Safety checks, retries, and bounded discovery are on by default
- Advanced and legacy flows stay in the CLI path, not the primary GitHub Action interface

## Security

This action is read-only against AWS APIs and does not mutate AWS resources.

Minimum IAM policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity",
        "apigateway:GET",
        "apigateway:GetRestApi",
        "apigateway:GetRestApis",
        "apigateway:GetStages",
        "apigateway:GetExport",
        "apigateway:GetTags",
        "apigatewayv2:GetApi",
        "apigatewayv2:GetApis",
        "apigatewayv2:GetStages",
        "apigatewayv2:ExportApi",
        "apigatewayv2:GetTags"
      ],
      "Resource": "*"
    }
  ]
}
```

Scope recommendation:
- Prefer restricting resources to specific API IDs where possible.
- Use role-based access with short-lived credentials in CI.

## Inputs

| Input | Required | Default | Notes |
| --- | --- | --- | --- |
| `aws-region` | yes | n/a | Region used for API Gateway resolution/export |
| `gateway-id` | no | `''` | Optional known API Gateway ID when you want to bypass broader discovery |
| `stage` | no | `''` | Optional stage override |
| `output-dir` | no | `discovered-specs` | Must resolve within `repo-root` |

Everything else is auto-resolved or handled internally:
- repo URL, slug, provider, ref, and SHA come from CI
- preflight auth and permission checks run before discovery
- bounded discovery, retries, and timeouts use safe defaults
- repo-first resolution prefers an existing repo spec before exporting from API Gateway

## Outputs

| Output | Description |
| --- | --- |
| `resolution-json` | Full resolution payload |
| `resolution-status` | `resolved` or `unresolved` |
| `source-type` | `repo-spec`, `gateway-export`, `manual-review`, or `discover-many` |
| `mapping-confidence` | Numeric confidence score |
| `spec-path` | Resolved/generated spec path when available |
| `gateway-id` | Selected gateway ID when available |
| `service-name` | Resolved service name |
| `services-json` | Legacy discover-many service list |
| `service-count` | Legacy discover-many service count |
| `export-summary-json` | discover-many summary: attempted/exported/failed/skipped |

`resolution-json` schema is published at `schemas/resolution-json.schema.json`.

## Usage

### GitHub minimal

```yaml
- id: resolve
  uses: postman-cs/postman-aws-spec-discovery-action@v0.3.0
  with:
    aws-region: us-east-1
```

### GitHub with known gateway ID

```yaml
- id: resolve
  uses: postman-cs/postman-aws-spec-discovery-action@v0.3.0
  with:
    aws-region: us-east-1
    gateway-id: abc123def4
```

### GitHub with stage override

```yaml
- id: resolve
  uses: postman-cs/postman-aws-spec-discovery-action@v0.3.0
  with:
    aws-region: us-east-1
    stage: prod
```

### GitLab / other CI

```bash
node dist/cli.cjs \
  --aws-region us-east-1 \
  --repo-root "$CI_PROJECT_DIR" \
  --result-json "$CI_PROJECT_DIR/postman-aws-spec-discovery-result.json" \
  --dotenv-path "$CI_PROJECT_DIR/postman-aws-spec-discovery.env"
```

The CLI remains the escape hatch for advanced and legacy behavior, including bulk discovery and tuning flags. See `gitlab-ci.example.yml` for a pinned-tag example.

## Troubleshooting

- `AWS credentials are missing or invalid`
  - Ensure CI auth step runs before this action (`aws-actions/configure-aws-credentials` or equivalent).
- `Candidate count exceeds max-candidates`
  - This usually means the account is too broad for safe automatic resolution. Prefer a known `gateway-id` or use the CLI for advanced narrowing.
- `manual-review` status
  - Usually ambiguity, stage selection conflict, or API Gateway export limitations.
- `Output path must stay within workspace/repo-root`
  - Use relative paths under `repo-root`; path escapes are blocked by design.

## Versioning policy

- Action follows SemVer.
- Breaking changes include input/output renames, output type changes, or behavioral contract changes.
- See `CHANGELOG.md` for release history.

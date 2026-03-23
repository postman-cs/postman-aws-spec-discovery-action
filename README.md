# postman-aws-spec-discovery-action

Resolve the best API specification source for the current service repository.

This repository supports two execution modes:

- GitHub Actions wrapper via `action.yml`
- Portable Node CLI via `dist/cli.cjs` for GitLab or other CI systems

By default (`mode=resolve-one`) the action is repo-first. It can also run in legacy bulk discovery mode (`mode=discover-many`).

## Auto-resolved values

When these inputs are omitted, the action auto-resolves them:

- `mode`: defaults to `resolve-one`
- `repo-url`: from CI metadata (`GITHUB_SERVER_URL` + `GITHUB_REPOSITORY`, or `CI_PROJECT_URL`)
- `repo-slug`: from CI metadata (`GITHUB_REPOSITORY` or `CI_PROJECT_PATH`)
- `git-provider`: inferred from explicit input, repo URL, or CI context
- `ref`: from CI metadata (`GITHUB_REF_NAME` or `CI_COMMIT_REF_NAME`)
- `sha`: from CI metadata (`GITHUB_SHA` or `CI_COMMIT_SHA`)
- `repo-root`: from `GITHUB_WORKSPACE` or `CI_PROJECT_DIR`, then `.`
- `stage`: prefers deterministic stages like `prod`, `production`, `$default`, or `main`; if an HTTP API has no deployed stage, the action exports the latest configuration; ambiguous multi-stage APIs fall back to `manual-review`
- `include-v2`: defaults to `true`
- `output-dir`: defaults to `discovered-specs`
- `expected-gateway-ids-json`: defaults to `[]`
- `service-mapping-json` (legacy discover-many mode): defaults to `{}`

## Inputs

| Input | Required | Default | Notes |
| --- | --- | --- | --- |
| `aws-region` | yes | n/a | Region used for API Gateway resolution/export |
| `mode` | no | `resolve-one` | `resolve-one` (default) or `discover-many` |
| `repo-url` | no | `''` | Auto-resolved from CI when empty |
| `repo-slug` | no | `''` | Auto-resolved from CI when empty |
| `git-provider` | no | `''` | Auto-inferred as `github`, `gitlab`, or `unknown` |
| `ref` | no | `''` | Auto-resolved from CI when empty |
| `sha` | no | `''` | Auto-resolved from CI when empty |
| `repo-root` | no | `.` | Auto-resolved from `GITHUB_WORKSPACE` or `CI_PROJECT_DIR` before falling back to `.` |
| `expected-service-name` | no | `''` | Optional resolver hint |
| `expected-gateway-ids-json` | no | `[]` | Optional JSON array of API Gateway IDs; short-circuits broad discovery with direct lookup |
| `stage` | no | `''` | Explicit stage override; otherwise resolve-one uses deterministic stage selection or manual review |
| `api-filter` | no | `''` | Regex filter for gateway names |
| `service-mapping-json` | no | `{}` | Legacy `discover-many` gateway ID to service name mapping |
| `output-dir` | no | `discovered-specs` | Output directory for generated specs |
| `include-v2` | no | `true` | Include HTTP APIs (`apigatewayv2`) |

## Platform support

### GitHub

Use the native GitHub Action entrypoint from `action.yml`.

- Authentication: `aws-actions/configure-aws-credentials`
- Outputs: GitHub Action outputs such as `resolution-json`, `resolution-status`, `service-name`, and `spec-path`
- AWS CLI: not required

### GitLab and other CI systems

Use the portable CLI entrypoint:

```bash
node dist/cli.cjs \
  --aws-region us-east-1 \
  --repo-root "$CI_PROJECT_DIR" \
  --result-json "$CI_PROJECT_DIR/postman-aws-spec-discovery-result.json" \
  --dotenv-path "$CI_PROJECT_DIR/postman-aws-spec-discovery.env"
```

- Authentication: standard AWS SDK credential chain
- GitLab repo context is auto-detected from `CI_PROJECT_URL`, `CI_PROJECT_PATH`, `CI_COMMIT_REF_NAME`, `CI_COMMIT_SHA`, and `CI_PROJECT_DIR`
- Outputs:
  - JSON file written to `--result-json`
  - dotenv file written to `--dotenv-path`
  - JSON payload also printed to stdout
- AWS CLI: not required

## Outputs

### Resolve-one outputs

| Output | Description |
| --- | --- |
| `resolution-json` | Full resolution payload |
| `resolution-status` | `resolved` or `unresolved` |
| `source-type` | `repo-spec`, `gateway-export`, or `manual-review` |
| `mapping-confidence` | Numeric confidence score |
| `spec-path` | Resolved/generated spec path when available |
| `gateway-id` | Selected gateway ID when available |
| `service-name` | Resolved service name |

`resolve-one` may intentionally return `manual-review` when:

- multiple gateways tie at the same confidence
- multiple stages exist and no deterministic stage can be chosen
- AWS export is blocked by known API Gateway limitations, such as REST APIs with non-JSON body models

### Discover-many (legacy) outputs

| Output | Description |
| --- | --- |
| `services-json` | JSON array of discovered services |
| `service-count` | Number of exported services |

### CLI dotenv outputs

When `--dotenv-path` is supplied, the CLI writes:

- `POSTMAN_AWS_SPEC_RESOLUTION_JSON`
- `POSTMAN_AWS_SPEC_RESOLUTION_STATUS`
- `POSTMAN_AWS_SPEC_SOURCE_TYPE`
- `POSTMAN_AWS_SPEC_MAPPING_CONFIDENCE`
- `POSTMAN_AWS_SPEC_PATH`
- `POSTMAN_AWS_SPEC_GATEWAY_ID`
- `POSTMAN_AWS_SPEC_SERVICE_NAME`
- `POSTMAN_AWS_SPEC_SERVICES_JSON`
- `POSTMAN_AWS_SPEC_SERVICE_COUNT`

## Required runner setup

- Node.js 20 runtime
- AWS credentials configured before this action
- GitHub: `aws-actions/configure-aws-credentials` is recommended
- GitLab or other CI: any AWS SDK-compatible auth mechanism works, including static env vars or OIDC/web identity

## Example (resolve-one default)

```yaml
name: Resolve service spec

on:
  workflow_dispatch:

jobs:
  resolve:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-actions-apigateway-read
          aws-region: us-east-1

      - id: resolve
        uses: ./.github/actions/postman-aws-spec-discovery-action
        with:
          aws-region: us-east-1
          # mode omitted -> resolve-one
          # repo-url, repo-slug, git-provider, ref, sha omitted -> CI auto-resolution

      - name: Show result
        run: |
          echo "status=${{ steps.resolve.outputs.resolution-status }}"
          echo "source=${{ steps.resolve.outputs.source-type }}"
          echo "service=${{ steps.resolve.outputs.service-name }}"
          echo "spec=${{ steps.resolve.outputs.spec-path }}"
```

## GitLab example

See [`gitlab-ci.example.yml`](gitlab-ci.example.yml) for a ready-to-adapt pipeline job that:

- fetches a pinned release of this repo
- runs `dist/cli.cjs`
- publishes result JSON and generated specs as artifacts
- exposes dotenv outputs for downstream jobs

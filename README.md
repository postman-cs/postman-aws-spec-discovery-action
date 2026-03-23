# postman-aws-spec-discovery-action

Discover AWS API Gateway APIs and export OpenAPI 3.0 specs for downstream Postman onboarding workflows.

This action is intended to run before `postman-api-onboarding-action` and produce a matrix-friendly service manifest.

## What this action does

1. Enumerates REST APIs with `aws apigateway get-rest-apis`
2. Optionally enumerates HTTP APIs with `aws apigatewayv2 get-apis`
3. Resolves the target project name per gateway using this order:
   1. `postman:project-name` tag
   2. `Name` tag
   3. `service-mapping-json[gatewayId]`
   4. API Gateway name
4. Exports specs:
   - REST: `aws apigateway get-export --parameters extensions='apigateway' --export-type oas30 --accepts application/yaml`
   - HTTP: `aws apigatewayv2 export-api --specification OAS30 --output-type YAML`
5. Writes each spec to `{output-dir}/{project-name}/index.yaml`
6. Emits `services-json` manifest for downstream matrix jobs

If one gateway export fails, the action logs a warning and continues.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `aws-region` | yes | n/a | AWS region to scan for API Gateway instances |
| `stage` | no | `''` | Stage to export. If empty, first available stage is used |
| `api-filter` | no | `''` | Regex pattern to filter API Gateway names |
| `service-mapping-json` | no | `{}` | JSON map of gateway ID to project name override |
| `output-dir` | no | `discovered-specs` | Output directory for spec files |
| `include-v2` | no | `true` | Include HTTP APIs (`apigatewayv2`) |

## Outputs

| Output | Description |
| --- | --- |
| `services-json` | JSON array of `{ projectName, specPath, gatewayId, gatewayType, stage }` |
| `service-count` | Number of successfully exported services |

## Required runner setup

- AWS CLI available on runner
- AWS credentials configured before this action, for example with `aws-actions/configure-aws-credentials`

## Example workflow with matrix chaining to postman-api-onboarding-action

This example commits discovered specs to the repository, then builds raw GitHub URLs used by `postman-api-onboarding-action`.

```yaml
name: Discover and onboard APIs

on:
  workflow_dispatch:

jobs:
  discover:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    outputs:
      services-json: ${{ steps.with-urls.outputs.services-json }}
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-actions-apigateway-read
          aws-region: us-east-1

      - id: discovery
        uses: ./.github/actions/postman-aws-spec-discovery-action
        with:
          aws-region: us-east-1
          stage: prod
          output-dir: discovered-specs
          include-v2: true
          service-mapping-json: '{"a1b2c3":"payments-service"}'

      - name: Commit discovered specs
        run: |
          if [ -n "$(git status --porcelain discovered-specs)" ]; then
            git config user.name "github-actions[bot]"
            git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
            git add discovered-specs
            git commit -m "chore: refresh discovered API specs"
            git push
          fi

      - id: with-urls
        uses: actions/github-script@v7
        env:
          SERVICES_JSON: ${{ steps.discovery.outputs.services-json }}
          REPOSITORY: ${{ github.repository }}
          SHA: ${{ github.sha }}
        with:
          script: |
            const services = JSON.parse(process.env.SERVICES_JSON || '[]');
            const [owner, repo] = process.env.REPOSITORY.split('/');
            const sha = process.env.SHA;

            const matrix = services.map((service) => ({
              projectName: service.projectName,
              specUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${service.specPath}`,
              gatewayId: service.gatewayId,
              gatewayType: service.gatewayType,
              stage: service.stage
            }));

            core.setOutput('services-json', JSON.stringify(matrix));

  onboard:
    needs: discover
    if: ${{ needs.discover.outputs.services-json != '[]' }}
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        service: ${{ fromJson(needs.discover.outputs.services-json) }}
    steps:
      - uses: actions/checkout@v4

      - name: Onboard ${{ matrix.service.projectName }}
        uses: ./.github/actions/postman-api-onboarding-action
        with:
          project-name: ${{ matrix.service.projectName }}
          spec-url: ${{ matrix.service.specUrl }}
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
```

## Manifest format

`services-json` example:

```json
[
  {
    "projectName": "payments-service",
    "specPath": "discovered-specs/payments-service/index.yaml",
    "gatewayId": "a1b2c3",
    "gatewayType": "REST",
    "stage": "prod"
  }
]
```

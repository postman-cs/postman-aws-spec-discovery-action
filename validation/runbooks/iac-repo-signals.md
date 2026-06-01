# IaC and Repo Signal Validation

Surfaces: CloudFormation/SAM, Terraform, CDK, Pulumi, GraphQL files, workflow files, Serverless config variants, Helm/Kubernetes Ingress, docker-compose, ECS task definitions, application configs, README gateway IDs, custom domains, Lambda URL hosts, SNS/EventBridge bridge patterns, and SNS contract files.

## Fixtures

Use `validation/fixtures/iac/`.

## Reproduction

```bash
npm run build
node validation/scripts/check-validation-fixtures.mjs
node validation/scripts/validate-iac-signals.mjs
node validation/scripts/run-cli-surface.mjs --surface iac-signals --keep-workspace true
```

`validate-iac-signals.mjs` runs the bundled `collectRepoSignals` implementation against the CloudFormation/SAM, Terraform, CDK, Pulumi, workflow, Serverless config, deployment config, README, GraphQL, Lambda URL host, SNS/EventBridge bridge, and SNS contract fixtures. It also validates bounded nested Backstage catalog detection. It writes detailed local output to the gitignored `validation/evidence/iac-repo-signals-matrix.local.json` file and refreshes the IaC/repo signal matrix section in `validation/evidence/README.md`.

## Expected Evidence

- Evidence contains provider hints for `api-gateway`, `appsync`, `eventbridge-schemas`, `glue`, `sns`, and `lambda-url`.
- Evidence contains gateway ID hints, custom domain hints, Lambda URL host hints, SNS/EventBridge bridge detection, and SNS contract file detection when seeded.

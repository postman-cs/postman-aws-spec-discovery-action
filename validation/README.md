# AWS Spec Discovery Validation

This directory is the customer-facing validation package for the AWS spec discovery action. It documents how each discovery surface is exercised, what artifact the action emits, and whether that artifact is already OpenAPI or can be represented as a partial OpenAPI 3.x document.

The package answers three questions:

1. Which discovery surfaces are supported?
2. How can a customer reproduce the behavior?
3. What sanitized evidence proves the current implementation?

## Directory Layout

| Directory | Purpose |
| --- | --- |
| `fixtures/` | Minimal repo files and CloudFormation templates that trigger every discovery path. |
| `scripts/` | Reproducible validation commands for local fixture checks, repo matrices, live AWS checks, and manifest capture. |
| `runbooks/` | Step-by-step instructions for reproducing each surface. |
| `evidence/` | Sanitized summaries and coverage matrices safe to commit. Raw live identifiers stay in gitignored `*.local.json` files. |

## Coverage Matrix

| Surface | Primary artifact | OAS 3.x coverage | Reproduction | Evidence |
| --- | --- | --- | --- | --- |
| Repo-local specs | OpenAPI, Swagger, GraphQL, AsyncAPI, Postman, JSON Schema, Avro, protobuf, Smithy, versioned/reference filenames | Full for OpenAPI 3.x; partial for Swagger and native API formats. GraphQL derivation preserves operation names, variables, and schema components; AsyncAPI derivation preserves payload schemas, examples, and channel metadata; Postman derivation preserves params, JSON examples, auth, and responses; JSON Schema and Avro derivation preserves named component schemas with `$ref` request bodies. | `runbooks/repo-spec.md` | `evidence/README.md` |
| Backstage catalog | Local or remote API definitions from root or nested catalog files | Full for OpenAPI refs; partial for GraphQL refs | `runbooks/backstage-catalog.md` | `evidence/README.md` |
| API Gateway REST | AWS OpenAPI export, with model/method fallback for known export limitations | Full OpenAPI 3.0 YAML from native export; partial OpenAPI 3.0 YAML from fallback synthesis | `runbooks/api-gateway.md` | `evidence/README.md` |
| API Gateway HTTP | AWS OpenAPI export | Full OpenAPI 3.0 YAML | `runbooks/api-gateway.md` | `evidence/README.md` |
| API Gateway WebSocket | Route metadata, request models, integrations, authorizers when present, and route responses | Partial OpenAPI 3.0 YAML with component schemas and API Gateway extensions | `runbooks/api-gateway.md` | `evidence/README.md` |
| AppSync | GraphQL SDL | Partial OpenAPI 3.1 | `runbooks/appsync.md` | `evidence/README.md` |
| AppSync Events | Event API channel namespaces | Partial OpenAPI 3.1 webhooks; live-validated | `runbooks/aws-derived-surfaces.md` | `evidence/README.md` |
| EventBridge Schemas | OpenApi3 or JSON Schema content | Full for OpenApi3; partial for JSON Schema | `runbooks/eventbridge-schemas.md` | `evidence/README.md` |
| EventBridge rules, pipes, and API destinations | Event patterns, filter criteria, targets, and HTTP destinations | Partial OpenAPI 3.1 webhooks or HTTP operations; live-validated | `runbooks/aws-derived-surfaces.md` | `evidence/README.md` |
| CloudFormation embedded specs | Embedded or referenced OpenAPI body | Full OpenAPI | `runbooks/cloudformation.md` | `evidence/README.md` |
| Glue Schema Registry | Avro, JSON Schema, or protobuf | Partial OpenAPI 3.1 | `runbooks/glue.md` | `evidence/README.md` |
| Bedrock Agent action groups | Inline or S3 OpenAPI schemas | OpenAPI JSON with Bedrock metadata; live-validated | `runbooks/aws-derived-surfaces.md` | `evidence/README.md` |
| ALB listener rules | Host, path, method, header, query, and action conditions | Partial OpenAPI 3.1 HTTP paths; live-validated | `runbooks/aws-derived-surfaces.md` | `evidence/README.md` |
| SSM registry | Inline content, URL content, or pointer artifact | Full for OpenAPI; partial for supported native content and pointer artifacts | `runbooks/ssm.md` | `evidence/README.md` |
| SNS contracts | AsyncAPI / JSON Schema plus sidecars | Partial OpenAPI 3.1 and webhook OpenAPI 3.1 sidecar with SNS delivery/filter/delivery-policy/redrive extensions | `runbooks/sns.md` | `evidence/README.md` |
| Lambda Function URL | Synthesized URL contract | Partial OpenAPI 3.0 YAML catch-all surface | `runbooks/lambda-url.md` | `evidence/README.md` |
| Lambda event source mappings | Event source mapping filters and batch/source metadata | Partial OpenAPI 3.1 webhooks; live-validated | `runbooks/aws-derived-surfaces.md` | `evidence/README.md` |
| Verified Permissions schemas | Cedar authorization schema metadata | OpenAPI 3.1 metadata document with no inferred endpoints; live-validated | `runbooks/aws-derived-surfaces.md` | `evidence/README.md` |
| Step Functions ASL | State machine definitions | Partial OpenAPI 3.1 execution-start surface with ASL metadata; live-validated | `runbooks/aws-derived-surfaces.md` | `evidence/README.md` |
| IaC/repo signals | Provider, URL, and domain hints from IaC, workflows, Serverless, deployment configs, docs, and contract/schema files | Partial OpenAPI from discovered AsyncAPI/GraphQL artifacts | `runbooks/iac-repo-signals.md` | `evidence/README.md` |

## Live AWS Resources

The live validation stack is intentionally kept running for future e2e assertions. Raw identifiers are captured in:

```text
validation/evidence/live-resource-manifest.local.json
```

That file is gitignored. Commit only the sanitized evidence summary in `evidence/README.md`.

The stack includes dedicated live resources for API Gateway, AppSync, AppSync Events, EventBridge Schemas, EventBridge rules/pipes/API destinations, CloudFormation, Glue, SSM, SNS, Lambda Function URLs, Lambda event source mappings, Verified Permissions, Step Functions, ALB listener rules, and Bedrock Agent action groups.

## Reproduce the Full Validation Set

Run from the action repository root:

```bash
npm run build
node validation/scripts/check-validation-fixtures.mjs
node validation/scripts/validate-repo-spec-matrix.mjs
node validation/scripts/validate-iac-signals.mjs
node validation/scripts/validate-p3-surfaces.mjs
node validation/scripts/capture-live-manifest.mjs --stack-name spec-discovery-validation --region us-east-1
node validation/scripts/validate-live-aws-surfaces.mjs
```

API Gateway validation additionally retains an end-to-end route-only receipt: the exported response omits `content`, discovery reports `openapiContractAudit.status = schema-incomplete` with the `AWS_OPENAPI_CONTRACT_INCOMPLETE` warning, and the released bootstrap contract collection passes against the live JSON `/health` response. Live controls cover clean `204`, valid and invalid response schemas, matching nonzero Content-Length, and API Gateway's normalization of attempted carried-204 and mismatched-length responses. See `runbooks/api-gateway.md` for the exact evidence fields and generated-contract expectations.

To create or refresh the live AWS stack:

```bash
ALB_VPC_ID=$(aws ec2 describe-vpcs \
  --region us-east-1 \
  --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' \
  --output text)
ALB_SUBNET_IDS=$(aws ec2 describe-subnets \
  --region us-east-1 \
  --filters Name=vpc-id,Values="$ALB_VPC_ID" Name=default-for-az,Values=true \
  --query 'Subnets[0:2].SubnetId' \
  --output text | tr '\t' ',')

aws cloudformation deploy \
  --template-file validation/fixtures/aws/live-stack.yaml \
  --stack-name spec-discovery-validation \
  --region us-east-1 \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides AlbVpcId="$ALB_VPC_ID" AlbSubnetIds="$ALB_SUBNET_IDS"
```

## Reading the Evidence

- `evidence/README.md` is the single customer-facing evidence summary and coverage matrix for every discovery surface.
- Raw matrix details are stored only in gitignored `*.local.json` files.

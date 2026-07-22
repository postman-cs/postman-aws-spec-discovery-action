# AWS Spec Discovery Support Ledger

Machine-and-human-readable coverage of every realistic source method and intentional exclusion for postman-aws-spec-discovery-action.

Updated: 2026-07-20

## Evidence policy

- Reserved for prior sanitized receipts that are not current-run proof.
- Reserved for required rows that have not been executed in a current sanitized run.
- Never embed credentials, raw account IDs, request IDs, or signed URLs in this ledger or evidence README.

## Coverage matrix

| ID | Method | Level | Seam | Unit/fixture test | Local validation | Live req/status | Completeness |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `repo-openapi-3x` | Authored OpenAPI 3.x repository contract | full | src/lib/repo/specs.ts<br>src/runtime.ts | tests/repo-spec-inventory.test.ts<br>tests/repo-resolution-integration.test.ts | validate-repo-spec-matrix.mjs#openapi-3.0-yaml | not-required/n/a | full |
| `repo-swagger-2` | Authored Swagger 2.0 repository contract | partial | src/lib/repo/specs.ts<br>src/lib/spec/oas-derivation.ts | tests/oas-derivation.test.ts | validate-repo-spec-matrix.mjs#swagger-2.0-yaml | not-required/n/a | partial |
| `repo-graphql-single` | Single-file GraphQL SDL repository contract | partial | src/lib/repo/specs.ts | tests/repo-spec-inventory.test.ts | validate-repo-spec-matrix.mjs#graphql-sdl | not-required/n/a | partial |
| `repo-graphql-multi-compose` | Multi-file GraphQL grouping by service root | partial | src/lib/repo/graphql-compose.ts<br>src/lib/repo/specs.ts | tests/repo-spec-inventory.test.ts | validate-resolution-closure.mjs#graphql-multi | not-required/n/a | partial |
| `repo-asyncapi` | Authored AsyncAPI repository contract | partial | src/lib/repo/specs.ts | tests/oas-derivation.test.ts | validate-repo-spec-matrix.mjs#asyncapi-yaml | not-required/n/a | partial |
| `repo-postman-collection` | Postman collection repository contract | partial | src/lib/repo/specs.ts | tests/oas-derivation.test.ts | validate-repo-spec-matrix.mjs#postman-collection | not-required/n/a | partial |
| `repo-json-schema` | Direct JSON Schema repository selection | partial | src/lib/repo/specs.ts | tests/repo-spec-inventory.test.ts | validate-resolution-closure.mjs#json-schema | not-required/n/a | partial |
| `repo-avro` | Direct Avro repository selection | partial | src/lib/repo/specs.ts | tests/repo-spec-inventory.test.ts | validate-resolution-closure.mjs#avro | not-required/n/a | partial |
| `repo-protobuf` | Protobuf repository contract | partial | src/lib/repo/specs.ts | tests/oas-derivation.test.ts | validate-repo-spec-matrix.mjs#protobuf | not-required/n/a | partial |
| `repo-smithy-single` | Single Smithy model file | partial | src/lib/repo/specs.ts | tests/repo-spec-inventory.test.ts | validate-repo-spec-matrix.mjs#smithy | not-required/n/a | partial |
| `repo-smithy-project-closure` | Smithy project closure from smithy-build.json | partial | src/lib/repo/smithy-project.ts<br>src/lib/repo/specs.ts | tests/repo-spec-inventory.test.ts | validate-resolution-closure.mjs#smithy-project | not-required/n/a | partial |
| `repo-explicit-spec-path` | Explicit spec-path selection | full | src/runtime.ts<br>src/contracts.ts | tests/repo-resolution-integration.test.ts<br>tests/discovery.test.ts | validate-resolution-closure.mjs#explicit-spec-path | not-required/n/a | full |
| `repo-service-root` | Explicit service-root monorepo scoping | full | src/runtime.ts<br>src/lib/repo/catalog.ts<br>src/lib/repo/specs.ts | tests/catalog.test.ts<br>tests/repo-spec-inventory.test.ts | validate-resolution-closure.mjs#service-root | not-required/n/a | full |
| `repo-same-tier-ambiguity` | Same-tier repository contract ambiguity | manual-review | src/lib/repo/specs.ts<br>src/runtime.ts | tests/repo-spec-inventory.test.ts<br>tests/repo-resolution-integration.test.ts | validate-resolution-closure.mjs#same-tier-ambiguity | not-required/n/a | n/a |
| `backstage-local` | Backstage local catalog API definition | full | src/lib/repo/catalog.ts | tests/catalog.test.ts | validate-repo-spec-matrix.mjs#backstage-yaml-local-openapi | not-required/n/a | full |
| `backstage-remote-allowlisted` | Backstage remote definition with exact allowlist | full | src/lib/repo/catalog.ts<br>src/lib/fetch/spec-fetcher.ts<br>src/lib/fetch/remote-fetch-policy.ts | tests/discovery.test.ts<br>tests/spec-fetcher-security.test.ts | validate-resolution-closure.mjs#remote-allowlist | not-required/n/a | full |
| `backstage-multi-entity-ambiguity` | Multi-document Backstage API ambiguity | manual-review | src/lib/repo/catalog.ts<br>src/runtime.ts | tests/catalog.test.ts | validate-resolution-closure.mjs#backstage-multi | not-required/n/a | n/a |
| `tag-postman-repo` | Exact postman:repo tag correlation | full | src/lib/resolve/narrowing-pipeline.ts<br>src/lib/aws/tagging-client.ts | tests/narrowing.test.ts<br>tests/tag-correlation.test.ts | validate-resolution-closure.mjs#github-org-repo-canonical | required/passed | full |
| `tag-github-org-repo-split` | Exact GithubOrg+GithubRepo tag correlation | full | src/lib/resolve/narrowing-pipeline.ts<br>src/lib/aws/tagging-client.ts | tests/narrowing.test.ts<br>tests/tag-correlation.test.ts | validate-resolution-closure.mjs#github-org-repo-split | required/passed | full |
| `tag-multi-environment-ambiguity` | Multi-environment exact tag ambiguity | manual-review | src/lib/resolve/narrowing-pipeline.ts<br>src/runtime.ts | tests/narrowing.test.ts<br>tests/tag-correlation.test.ts | validate-resolution-closure.mjs#github-org-repo-multi-env | required/passed | n/a |
| `apigw-rest-native` | API Gateway REST native OpenAPI export | full | src/lib/aws/client.ts<br>src/lib/providers/api-gateway.ts | tests/aws-client.test.ts<br>tests/providers.test.ts | validate-p3-surfaces.mjs#n/a | required/passed | full |
| `apigw-rest-fallback` | API Gateway REST recognized export fallback | partial | src/lib/spec/rest-api-fallback-openapi.ts | tests/rest-api-model-merge.test.ts | n/a | required/passed | partial |
| `apigw-http-deployed-stage` | API Gateway HTTP deployed-stage export | full | src/runtime.ts<br>src/lib/aws/client.ts | tests/stage-selection-provenance.test.ts | validate-resolution-closure.mjs#provenance-deployed-stage | required/passed | full |
| `apigw-http-latest-configuration` | API Gateway HTTP latest-configuration mode | full | src/runtime.ts<br>src/contracts.ts | tests/stage-selection-provenance.test.ts | validate-resolution-closure.mjs#provenance-latest-configuration | required/passed | full |
| `apigw-websocket-partial` | API Gateway WebSocket partial control-plane reconstruction | partial | src/lib/spec/websocket-openapi.ts | tests/websocket-openapi.test.ts | n/a | required/passed | partial |
| `stage-evidence-safe-selection` | Evidence-safe stage precedence | full | src/runtime.ts | tests/stage-selection-provenance.test.ts | validate-resolution-closure.mjs#stage-precedence | required/passed | n/a |
| `appsync-graphql` | AppSync GraphQL SDL export | partial | src/lib/providers/appsync.ts | tests/appsync-client.test.ts<br>tests/providers.test.ts | n/a | required/passed | partial |
| `appsync-merged-associations` | AppSync merged API source associations | partial | src/lib/providers/appsync.ts<br>src/lib/aws/appsync-client.ts | tests/appsync-client.test.ts<br>tests/stage-selection-provenance.test.ts | n/a | required/passed | partial |
| `appsync-events` | AppSync Events channel namespaces | partial | src/lib/providers/appsync-events.ts | tests/p3-providers.test.ts | validate-p3-surfaces.mjs#appsync-events | required/passed | partial |
| `eventbridge-schemas` | EventBridge Schema Registry | full | src/lib/providers/eventbridge-schemas.ts | tests/providers.test.ts | n/a | required/passed | full |
| `eventbridge-surfaces` | EventBridge rules/pipes/API destinations | partial | src/lib/providers/eventbridge-surfaces.ts | tests/p3-providers.test.ts | validate-p3-surfaces.mjs#eventbridge-rule | required/passed | partial |
| `cloudformation-embedded` | CloudFormation embedded/referenced OpenAPI (live stack) | full | src/lib/providers/cloudformation.ts | tests/providers.test.ts | n/a | required/passed | full |
| `glue-schema` | Glue Schema Registry | partial | src/lib/providers/glue.ts | tests/providers.test.ts | n/a | required/passed | partial |
| `ssm-registry` | SSM /postman/specs registry | full | src/lib/providers/ssm.ts | tests/providers.test.ts<br>tests/discovery.test.ts | n/a | required/passed | full |
| `sns-contracts` | SNS contract resolution + sidecars | partial | src/lib/providers/sns.ts | tests/providers.test.ts | n/a | required/passed | partial |
| `lambda-url` | Lambda Function URL synthesized contract | partial | src/lib/providers/lambda-url.ts | tests/providers.test.ts | n/a | required/passed | partial |
| `lambda-event-source` | Lambda event source mappings | partial | src/lib/providers/lambda-event-source.ts | tests/p3-providers.test.ts | validate-p3-surfaces.mjs#lambda-event-source | required/passed | partial |
| `bedrock-action-groups` | Bedrock Agent action groups | partial | src/lib/providers/bedrock-action-groups.ts | tests/p3-providers.test.ts | validate-p3-surfaces.mjs#bedrock-action-group | required/passed | partial |
| `alb-listener-rules` | ALB listener rules | partial | src/lib/providers/alb-listener-rules.ts | tests/p3-providers.test.ts | validate-p3-surfaces.mjs#alb-listener-rule | required/passed | partial |
| `verified-permissions` | Verified Permissions schemas | partial | src/lib/providers/verified-permissions.ts | tests/p3-providers.test.ts | validate-p3-surfaces.mjs#verified-permissions | required/passed | partial |
| `step-functions` | Step Functions ASL definitions | partial | src/lib/providers/step-functions.ts | tests/p3-providers.test.ts | validate-p3-surfaces.mjs#step-functions | required/passed | partial |
| `iac-cfn-sam-static` | Static CloudFormation/SAM OpenAPI extraction | full | src/lib/iac/cloudformation.ts<br>src/lib/iac/resolve.ts | tests/iac-static-resolution.test.ts | validate-resolution-closure.mjs#iac-cfn-inline | not-required/n/a | full |
| `iac-cdk-assembly` | Static CDK cloud assembly extraction | full | src/lib/iac/cdk.ts | tests/iac-static-resolution.test.ts<br>tests/repo-build-artifacts.test.ts | validate-resolution-closure.mjs#iac-cdk-assembly | not-required/n/a | full |
| `iac-terraform-literal` | Static Terraform literal/local OpenAPI references | full | src/lib/iac/terraform.ts | tests/iac-static-resolution.test.ts | validate-resolution-closure.mjs#iac-terraform-literal | not-required/n/a | full |
| `iac-serverless-static` | Static Serverless Framework config extraction | full | src/lib/iac/serverless.ts | tests/iac-static-resolution.test.ts | validate-resolution-closure.mjs#iac-serverless-static | not-required/n/a | full |
| `iac-repo-signals` | IaC/repo signal fingerprinting | partial | src/lib/repo/signals.ts | tests/scan.test.ts | validate-iac-signals.mjs#cloudformation-sam | not-required/n/a | n/a |
| `remote-deny-by-default` | Deny-by-default remote fetch | full | src/lib/fetch/remote-fetch-policy.ts<br>src/lib/fetch/spec-fetcher.ts | tests/spec-fetcher-security.test.ts<br>tests/discovery.test.ts | validate-resolution-closure.mjs#remote-denied | not-required/n/a | n/a |
| `local-path-containment` | Local path/symlink containment | full | src/lib/utils/resolve-path-within-root.ts<br>src/lib/repo/smithy-project.ts | tests/path-security.test.ts<br>tests/repo-spec-inventory.test.ts | validate-resolution-closure.mjs#path-escape | not-required/n/a | n/a |
| `expected-identity-mismatch` | Expected account/partition mismatch fail-closed | full | src/runtime.ts<br>src/lib/aws/client.ts | tests/stage-selection-provenance.test.ts<br>tests/preflight.test.ts | validate-resolution-closure.mjs#identity-mismatch | required/passed | n/a |
| `provider-denial-typed` | Typed provider probe denials in resolution-json | full | src/lib/providers/registry.ts<br>src/runtime.ts | tests/providers.test.ts<br>tests/stage-selection-provenance.test.ts | validate-resolution-closure.mjs#provider-denial | required/passed | n/a |
| `deterministic-ordering-limits` | Deterministic ordering and scan/resource limits | full | src/lib/repo/specs.ts<br>src/lib/repo/scan.ts<br>src/lib/iac/resolve.ts | tests/repo-spec-inventory.test.ts<br>tests/scan.test.ts | validate-resolution-closure.mjs#deterministic-order | not-required/n/a | n/a |
| `exclude-org-wide-sweep` | Organization-wide account/role/region sweeps | intentionally-excluded | — | — | validate-support-ledger.mjs#exclusion | not-required/n/a | n/a |
| `exclude-build-tool-execution` | Automatic cdk synth / sam build / terraform / smithy builds | intentionally-excluded | src/lib/iac/resolve.ts | tests/iac-static-resolution.test.ts | validate-resolution-closure.mjs#iac-no-exec | not-required/n/a | n/a |
| `exclude-remote-state` | Automatic remote Terraform/Pulumi state download | intentionally-excluded | src/lib/iac/terraform.ts | tests/iac-static-resolution.test.ts | validate-support-ledger.mjs#exclusion | not-required/n/a | n/a |
| `exclude-s3-enumeration` | S3 bucket enumeration | intentionally-excluded | src/lib/aws/s3-client.ts | tests/iac-static-resolution.test.ts | validate-support-ledger.mjs#exclusion | not-required/n/a | n/a |
| `exclude-unauth-graphql-introspection` | Unauthenticated GraphQL endpoint introspection | intentionally-excluded | src/lib/providers/appsync.ts | — | validate-support-ledger.mjs#exclusion | not-required/n/a | n/a |
| `exclude-fabricated-openapi` | Fabricated OpenAPI for non-contract AWS resources | intentionally-excluded | — | tests/p3-providers.test.ts | validate-support-ledger.mjs#exclusion | not-required/n/a | n/a |
| `exclude-silent-first-wins` | Silent first-API/first-document selection | intentionally-excluded | src/runtime.ts<br>src/lib/repo/specs.ts | tests/repo-spec-inventory.test.ts<br>tests/catalog.test.ts | validate-resolution-closure.mjs#same-tier-ambiguity | not-required/n/a | n/a |

## Intentional exclusions

- **Organization-wide account/role/region sweeps** (`exclude-org-wide-sweep`): One authenticated account and region per run; org sweeps belong to hub/distribution systems.
- **Automatic cdk synth / sam build / terraform / smithy builds** (`exclude-build-tool-execution`): Static extraction and existing artifacts only; never execute untrusted repo build tools.
- **Automatic remote Terraform/Pulumi state download** (`exclude-remote-state`): Only explicitly supplied local state/output artifacts are eligible.
- **S3 bucket enumeration** (`exclude-s3-enumeration`): Only exact trusted bucket/key/version references are eligible.
- **Unauthenticated GraphQL endpoint introspection** (`exclude-unauth-graphql-introspection`): AppSync management-plane SDL is preferred; endpoint introspection is not automatic.
- **Fabricated OpenAPI for non-contract AWS resources** (`exclude-fabricated-openapi`): Event/control-plane representations remain native or explicitly partial; no invented business endpoints.
- **Silent first-API/first-document selection** (`exclude-silent-first-wins`): Ambiguity returns ranked manual-review or discover-many groups.

## Rationale index

### `repo-openapi-3x`

Direct repo-local OpenAPI 3.x is a primary authored contract.

### `repo-swagger-2`

Swagger 2.0 resolves natively then derives partial OpenAPI 3.x.

### `repo-graphql-single`

Single GraphQL SDL is selected as repo-spec with partial OpenAPI derivation.

### `repo-graphql-multi-compose`

GraphQL files are grouped by service root and composed deterministically.

### `repo-asyncapi`

AsyncAPI resolves as repo-spec with partial OpenAPI derivation.

### `repo-postman-collection`

Postman collections resolve as repo-spec with partial OpenAPI derivation.

### `repo-json-schema`

Validated JSON Schema files are first-class repo-spec candidates, not derivation-only.

### `repo-avro`

Validated Avro schemas are first-class repo-spec candidates.

### `repo-protobuf`

Protobuf service definitions resolve as repo-spec with partial OpenAPI derivation.

### `repo-smithy-single`

Single .smithy files resolve as repo-spec.

### `repo-smithy-project-closure`

smithy-build.json resolves bounded local sources/imports; JSON config is never model source.

### `repo-explicit-spec-path`

Explicit spec-path skips same-tier auto-selection.

### `repo-service-root`

service-root scopes inventory and Backstage entities to one service directory.

### `repo-same-tier-ambiguity`

Multiple same-tier contracts return ranked manual-review; never silent first-wins.

### `backstage-local`

Local Backstage API definitions resolve before AWS discovery.

### `backstage-remote-allowlisted`

Remote Backstage refs fetch only when remote-fetch-allowlist-json exactly allows host/path.

### `backstage-multi-entity-ambiguity`

Every kind:API entity is a candidate; resolve-one does not pick first YAML document by file order.

### `tag-postman-repo`

Canonical postman:repo exact match runs before heuristic narrowing.

### `tag-github-org-repo-split`

GithubOrg/GithubRepo split tags are an exact conjunction after postman:repo.

### `tag-multi-environment-ambiguity`

Exact per-environment duplicates remain ranked ambiguity unless explicit evidence selects one.

### `apigw-rest-native`

Native REST export is current-run live-proven.

### `apigw-rest-fallback`

Fallback applies only to recognized export limitations and is labeled partial.

### `apigw-http-deployed-stage`

HTTP with an evidenced stage exports deployed-stage truth.

### `apigw-http-latest-configuration`

No-stage HTTP export is latest-configuration, distinct from deployed-stage as proved by live divergence after an undeployed change.

### `apigw-websocket-partial`

WebSocket remains partial-control-plane unless native fidelity is proven.

### `stage-evidence-safe-selection`

Stages auto-resolve only for explicit, IaC-linked, singleton, or uniquely evidenced cases; HTTP divergence proves no prod-name heuristic collapse.

### `appsync-graphql`

AppSync SDL export is current-run live-proven.

### `appsync-merged-associations`

Merged SDL exports once; source associations are retained as provenance without recursive source export.

### `appsync-events`

Current-run live-proven partial event channel representation.

### `eventbridge-schemas`

OpenApi3 schemas export full OpenAPI JSON.

### `eventbridge-surfaces`

Partial control-plane surfaces are current-run live-proven.

### `cloudformation-embedded`

Current-run live CFN embedded extraction proven.

### `glue-schema`

Glue Avro/JSON/Proto export is current-run live-proven.

### `ssm-registry`

Inline content, allowlisted URL fetch, and pointer artifacts are current-run live-proven.

### `sns-contracts`

SNS contract chain and webhook sidecar are current-run live-proven.

### `lambda-url`

Synthesized catch-all URL surface is current-run live-proven.

### `lambda-event-source`

Partial webhook surface is current-run live-proven.

### `bedrock-action-groups`

Bedrock OpenAPI subset is current-run live-proven.

### `alb-listener-rules`

Partial HTTP path surface is current-run live-proven.

### `verified-permissions`

Metadata-only OpenAPI is current-run live-proven.

### `step-functions`

Partial execution-start surface is current-run live-proven.

### `iac-cfn-sam-static`

Inline Body/DefinitionBody and local DefinitionUri without executing builds.

### `iac-cdk-assembly`

Follows existing cloud assembly; does not run cdk synth.

### `iac-terraform-literal`

Literal bodies and local file refs only; no HCL evaluation or remote state fetch.

### `iac-serverless-static`

Static YAML/config and package artifacts only; JS/TS config and plugins refused.

### `iac-repo-signals`

Signals provide provider/ID hints; authored contracts and static extraction outrank hints.

### `remote-deny-by-default`

Absent/empty remote-fetch-allowlist-json denies all remote spec fetches.

### `local-path-containment`

Canonical containment before every local read; escaping symlinks refused.

### `expected-identity-mismatch`

expected-account-id / expected-partition mismatches fail closed with sanitized errors.

### `provider-denial-typed`

Denials, errors, and timeouts are recorded in provenance rather than silently omitted from evidence.

### `deterministic-ordering-limits`

Candidate/file order is deterministic; depth/file/byte/time bounds terminate scans.

### `exclude-org-wide-sweep`

One authenticated account and region per run; org sweeps belong to hub/distribution systems.

### `exclude-build-tool-execution`

Static extraction and existing artifacts only; never execute untrusted repo build tools.

### `exclude-remote-state`

Only explicitly supplied local state/output artifacts are eligible.

### `exclude-s3-enumeration`

Only exact trusted bucket/key/version references are eligible.

### `exclude-unauth-graphql-introspection`

AppSync management-plane SDL is preferred; endpoint introspection is not automatic.

### `exclude-fabricated-openapi`

Event/control-plane representations remain native or explicitly partial; no invented business endpoints.

### `exclude-silent-first-wins`

Ambiguity returns ranked manual-review or discover-many groups.

# Validation Evidence

This is the single customer-safe evidence document for the discovery surfaces documented in `validation/README.md`.

Raw AWS identifiers, request IDs, credential-bearing output, temporary workspace paths, and `*.local.json` files must stay out of this document. The validation scripts keep raw manifests and detailed command output in gitignored local JSON files, then refresh the generated evidence sections below.

## Evidence Summary

Captured on 2026-05-31. Generated matrix sections in this document are refreshed by:

- `validate-repo-spec-matrix.mjs` for repo-local and Backstage contract discovery.
- `validate-live-aws-surfaces.mjs` for live AWS provider validation.
- `validate-iac-signals.mjs` for IaC and repo-signal discovery.
- `capture-live-manifest.mjs` for the sanitized live resource summary.

## Coverage

| Surface | Validated behavior | Current evidence |
| --- | --- | --- |
| Repo-local specs | OpenAPI 3.0/3.1 resolve as full OpenAPI. Swagger 2.0, GraphQL SDL, AsyncAPI, Postman collections, protobuf, and Smithy resolve as primary artifacts with partial OpenAPI 3.x derivations. | `check-validation-fixtures.mjs` passed with 25 required files and 10 marker checks. `validate-repo-spec-matrix.mjs` passed 12 cases. |
| Backstage catalog | Root `catalog-info.yaml` and `catalog-info.yml` API definitions are selected before AWS discovery. Local OpenAPI, local GraphQL, and remote `$text` OpenAPI references are covered. | The repo spec matrix includes local OpenAPI, local GraphQL, and remote OpenAPI Backstage cases. |
| API Gateway REST | REST API export produces OpenAPI 3.0 YAML. | The live AWS matrix passed the `api-gateway-rest` case with `source-type=gateway-export`, `provider-type=api-gateway`, and `spec-format=openapi-yaml`. |
| API Gateway HTTP | HTTP API export produces OpenAPI 3.0 YAML. | The live AWS matrix passed the `api-gateway-http` case with `source-type=gateway-export`, `provider-type=api-gateway`, and `spec-format=openapi-yaml`. |
| API Gateway WebSocket | WebSocket route metadata produces partial OpenAPI 3.0 YAML with route-selection and route-key metadata. | The live AWS matrix passed the `api-gateway-websocket` case with `gatewayType=WEBSOCKET` and `spec-format=openapi-yaml`. |
| AppSync | AppSync APIs are discovered and GraphQL SDL is exported. The exported SDL derives partial OpenAPI 3.1. | The live AWS matrix passed the `appsync` case with `source-type=appsync-schema`, `provider-type=appsync`, and `spec-format=graphql-sdl`. |
| EventBridge Schemas | EventBridge schema registries are discovered. OpenApi3 schemas export as OpenAPI JSON; JSON Schema content is recorded with derivation status. | The live AWS matrix passed the `eventbridge-schemas` case with `source-type=eventbridge-schema`, `provider-type=eventbridge-schemas`, and `spec-format=openapi-json`. |
| CloudFormation embedded specs | CloudFormation stacks are discovered and embedded or referenced OpenAPI bodies are extracted. | The live AWS matrix passed the `cloudformation-embedded` case with `source-type=cfn-embedded`, `provider-type=cloudformation`, and `spec-format=openapi-json`. |
| Glue Schema Registry | Glue schema registries are discovered and the latest schema version is exported. Avro, JSON Schema, and protobuf are represented as native artifacts with partial OpenAPI 3.1 derivation. | The live AWS matrix passed the `glue-schema` case with `source-type=glue-schema`, `provider-type=glue`, and `spec-format=avro`. |
| SSM registry | `/postman/specs/{service}/content` resolves inline content. `/postman/specs/{service}/spec-url` fetches remote content or emits a pointer artifact on fetch failure. | The live AWS matrix passed `ssm-registry`, `ssm-url-registry`, and `ssm-url-pointer` with AsyncAPI, JSON Schema, and pointer-style OpenAPI artifacts. |
| SNS contracts | SNS topics resolve durable contracts through repo, generated, SSM, catalog, EventBridge-derived, code-derived, and manual-review origins. Metadata sidecars are emitted. HTTP/S subscriptions emit an OpenAPI 3.1 webhook sidecar. | The live AWS matrix passed `sns-ssm-content` and `sns-webhook-sidecar` with `source-type=sns-contract`, `provider-type=sns`, `spec-format=asyncapi-yaml`, `contractOrigin=ssm-content`, partial OpenAPI 3.1 derivation, and `webhook.openapi.json` markers. |
| Lambda Function URL | Lambda Function URLs synthesize OpenAPI 3.0 YAML with server URL, catch-all path, standard methods, and AWS auth metadata. | The live AWS matrix passed the `lambda-url` case with `source-type=lambda-url-export`, `provider-type=lambda-url`, `gatewayType=LAMBDA_URL`, and `spec-format=openapi-yaml`. |
| IaC and repo signals | CloudFormation/SAM, Terraform, CDK, Pulumi, workflow, README, GraphQL, Lambda URL, SNS/EventBridge bridge, and SNS contract fixtures produce provider hints and contract file signals. | `validate-iac-signals.mjs` passed 5 cases. Signal-discovered `asyncapi.yaml` and `schema.graphql` fixtures both derive OpenAPI 3.x. |

## Live AWS Status

The live validation stack is `spec-discovery-validation` in `us-east-1`. The latest captured stack status was `UPDATE_COMPLETE`, and `validate-live-aws-surfaces.mjs` passed 13 live AWS cases.

<!-- evidence:live-resource-summary:start -->
## Live Resource Summary

- Captured at: 2026-05-31T15:47:08.247Z
- Stack: spec-discovery-validation
- Region: us-east-1
- Account: XXXXXXXXXXXX
- Status: UPDATE_COMPLETE
- Output keys: GlueRegistryName, GraphqlApiId, HttpApiId, LambdaFunctionName, LambdaFunctionUrl, RestApiId, SchemaRegistryName, SnsSubscriptionTopicArn, SnsTestTopicArn, SnsUrlTopicArn, WebSocketApiId

Raw live identifiers are stored only in `live-resource-manifest.local.json`.
<!-- evidence:live-resource-summary:end -->

<!-- evidence:repo-spec-matrix:start -->
## Repo Spec Matrix Evidence

- Captured at: 2026-05-31T15:43:08.808Z
- Cases: 12
- Passed: 12
- Failed: 0

| Case | Source Type | Spec Format | OAS | Result |
| --- | --- | --- | --- | --- |
| openapi-3.0-yaml | repo-spec | openapi-yaml | 3.0.3 full | pass |
| openapi-3.1-json | repo-spec | openapi-json | 3.1.0 full | pass |
| swagger-2.0-yaml | repo-spec | openapi-yaml | 3.0.3 partial | pass |
| graphql-sdl | repo-spec | graphql-sdl | 3.1.0 partial | pass |
| asyncapi-yaml | repo-spec | asyncapi-yaml | 3.1.0 partial | pass |
| postman-collection | repo-spec | postman-collection | 3.1.0 partial | pass |
| protobuf | repo-spec | protobuf | 3.1.0 partial | pass |
| smithy | repo-spec | smithy | 3.1.0 partial | pass |
| smithy-build | repo-spec | smithy | 3.1.0 partial | pass |
| backstage-yaml-local-openapi | repo-spec | openapi-yaml | 3.0.3 full | pass |
| backstage-yml-local-graphql | repo-spec | graphql-sdl | 3.1.0 partial | pass |
| backstage-remote-openapi | repo-spec | openapi-yaml | 3.0.3 full | pass |
<!-- evidence:repo-spec-matrix:end -->

<!-- evidence:live-aws-surfaces:start -->
## Live AWS Surface Evidence

- Captured at: 2026-05-31T15:43:30.706Z
- Elapsed ms: 10095
- Stack: spec-discovery-validation
- Region: us-east-1
- Cases: 13
- Passed: 13
- Failed: 0

| Case | Runner | Source Type | Provider | Format | Elapsed ms | Result |
| --- | --- | --- | --- | --- | ---: | --- |
| api-gateway-rest | runtime | gateway-export | api-gateway | openapi-yaml | 857 | pass |
| api-gateway-http | runtime | gateway-export | api-gateway | openapi-yaml | 1383 | pass |
| api-gateway-websocket | runtime | gateway-export | api-gateway | openapi-yaml | 1453 | pass |
| appsync | runtime | appsync-schema | appsync | graphql-sdl | 1019 | pass |
| eventbridge-schemas | runtime | eventbridge-schema | eventbridge-schemas | openapi-json | 855 | pass |
| cloudformation-embedded | runtime | cfn-embedded | cloudformation | openapi-json | 525 | pass |
| glue-schema | runtime | glue-schema | glue | avro | 867 | pass |
| ssm-registry | runtime | ssm-registry | ssm | asyncapi-yaml | 719 | pass |
| ssm-url-registry | runtime | ssm-registry | ssm | json-schema | 926 | pass |
| ssm-url-pointer | runtime | ssm-registry | ssm | openapi-json | 655 | pass |
| lambda-url | runtime | lambda-url-export | lambda-url | openapi-yaml | 789 | pass |
| sns-ssm-content | runtime | sns-contract | sns | asyncapi-yaml | 8081 | pass |
| sns-webhook-sidecar | runtime | sns-contract | sns | asyncapi-yaml | 8353 | pass |
<!-- evidence:live-aws-surfaces:end -->

<!-- evidence:iac-repo-signals-matrix:start -->
## IaC and Repo Signal Matrix Evidence

- Captured at: 2026-05-31T15:43:08.614Z
- Cases: 5
- Passed: 5
- Failed: 0

| Case | Provider hints | Other checks | Result |
| --- | --- | ---: | --- |
| cloudformation-sam | appsync, sns, eventbridge-schemas, glue, api-gateway, lambda-url | 5 | pass |
| terraform | appsync, api-gateway, sns, eventbridge-schemas, glue, lambda-url | 4 | pass |
| cdk | appsync, sns, api-gateway, eventbridge-schemas, lambda-url | 4 | pass |
| pulumi | appsync, api-gateway, sns, lambda-url | 4 | pass |
| workflow-readme-graphql | lambda-url, sns, eventbridge-schemas, appsync | 5 | pass |
<!-- evidence:iac-repo-signals-matrix:end -->

# Validation Evidence

This is the single customer-safe evidence document for the discovery surfaces documented in `validation/README.md`.

Raw AWS identifiers, request IDs, credential-bearing output, temporary workspace paths, and `*.local.json` files must stay out of this document. The validation scripts keep raw manifests and detailed command output in gitignored local JSON files, then refresh the generated evidence sections below.

## Evidence Summary

Captured on 2026-06-01. Generated matrix sections in this document are refreshed by:

- `validate-repo-spec-matrix.mjs` for repo-local and Backstage contract discovery.
- `validate-live-aws-surfaces.mjs` for live AWS provider validation.
- `validate-iac-signals.mjs` for IaC and repo-signal discovery.
- `validate-p3-surfaces.mjs` for supplemental P3 AWS-derived fixture coverage.
- `capture-live-manifest.mjs` for the sanitized live resource summary.

## Coverage

| Surface | Validated behavior | Current evidence |
| --- | --- | --- |
| Repo-local specs | OpenAPI 3.0/3.1 resolve as full OpenAPI, including versioned/reference filename variants. Swagger 2.0, GraphQL SDL, AsyncAPI, Postman collections, JSON Schema, Avro, protobuf, and Smithy resolve as primary or derivable artifacts with partial OpenAPI 3.x derivations. The GraphQL fixture proves operation, required variable, and component preservation; the AsyncAPI fixture proves channel payload schema, example, channel name, and subscribe direction preservation; the Postman fixture proves query/header parameters, JSON request example, auth type, and response example preservation; the JSON Schema and Avro fixtures prove named component schemas and `$ref` request bodies rather than anonymous wrappers. Protobuf and Smithy fixtures prove service/RPC operation extraction with named input/output components. | `check-validation-fixtures.mjs` passed with 39 required files and 26 marker checks. `validate-repo-spec-matrix.mjs` passed 15 cases. |
| Backstage catalog | Root and nested `catalog-info.yaml` / `catalog-info.yml` API definitions are selected before AWS discovery. Local OpenAPI, local GraphQL, and remote `$text` OpenAPI references are covered. | The repo spec matrix includes local OpenAPI, local GraphQL, and remote OpenAPI Backstage cases. The IaC/repo signal matrix includes `nested-backstage` proving bounded nested catalog detection. |
| API Gateway REST | REST API export produces full OpenAPI 3.0 YAML. When native export hits a known API Gateway export limitation, the fallback synthesizes partial OpenAPI 3.0 from live REST resources, methods, and models. | The live AWS matrix passed `api-gateway-rest` and `api-gateway-rest-fallback` with `source-type=gateway-export`, `provider-type=api-gateway`, `spec-format=openapi-yaml`, and fallback completeness marked partial. |
| API Gateway HTTP | HTTP API export produces OpenAPI 3.0 YAML. | The live AWS matrix passed the `api-gateway-http` case with `source-type=gateway-export`, `provider-type=api-gateway`, and `spec-format=openapi-yaml`. |
| API Gateway WebSocket | WebSocket API Gateway v2 metadata produces partial OpenAPI 3.0 YAML with route-selection, route keys, operation names, request models, component schemas, integrations, authorizers when present, and route responses when AWS exposes them. | The live AWS matrix passed the `api-gateway-websocket` case with `gatewayType=WEBSOCKET`, `spec-format=openapi-yaml`, and markers for `OrderMessage`, `OrderAck`, `x-amazon-apigateway-integration`, route model selection, request models, and route responses. |
| AppSync | AppSync APIs are discovered and GraphQL SDL is exported. The exported SDL derives partial OpenAPI 3.1. | The live AWS matrix passed the `appsync` case with `source-type=appsync-schema`, `provider-type=appsync`, and `spec-format=graphql-sdl`. |
| EventBridge Schemas | EventBridge schema registries are discovered. OpenApi3 schemas export as OpenAPI JSON; JSON Schema content is recorded with derivation status. | The live AWS matrix passed the `eventbridge-schemas` case with `source-type=eventbridge-schema`, `provider-type=eventbridge-schemas`, and `spec-format=openapi-json`. |
| CloudFormation embedded specs | CloudFormation stacks are discovered and embedded or referenced OpenAPI bodies are extracted. | The live AWS matrix passed the `cloudformation-embedded` case with `source-type=cfn-embedded`, `provider-type=cloudformation`, and `spec-format=openapi-json`. |
| Glue Schema Registry | Glue schema registries are discovered and the latest schema version is exported. Avro, JSON Schema, and protobuf are represented as native artifacts with partial OpenAPI 3.1 derivation. | The live AWS matrix passed the `glue-schema` case with `source-type=glue-schema`, `provider-type=glue`, and `spec-format=avro`. |
| SSM registry | `/postman/specs/{service}/content` resolves inline content. `/postman/specs/{service}/spec-url` fetches remote content or emits a pointer artifact on fetch failure. | The live AWS matrix passed `ssm-registry`, `ssm-url-registry`, and `ssm-url-pointer` with AsyncAPI, JSON Schema, and pointer-style OpenAPI artifacts. |
| SNS contracts | SNS topics resolve durable contracts through repo, generated, SSM, catalog, EventBridge-derived, code-derived, and manual-review origins. Metadata sidecars are emitted. HTTP/S subscriptions emit an OpenAPI 3.1 webhook sidecar with `x-sns-*` extensions for delivery variant, filter policy, filter policy scope, delivery policy, and redrive policy when AWS exposes those attributes. | The live AWS matrix passed `sns-ssm-content` and `sns-webhook-sidecar` with `source-type=sns-contract`, `provider-type=sns`, `spec-format=asyncapi-yaml`, `contractOrigin=ssm-content`, partial OpenAPI 3.1 derivation, and `webhook.openapi.json` markers for the SNS extension fields. |
| Lambda Function URL | Lambda Function URLs synthesize OpenAPI 3.0 YAML with server URL, catch-all path, standard methods, and AWS auth metadata. | The live AWS matrix passed the `lambda-url` case with `source-type=lambda-url-export`, `provider-type=lambda-url`, `gatewayType=LAMBDA_URL`, and `spec-format=openapi-yaml`. |
| P3 AWS-derived surfaces | AppSync Events, EventBridge rules/pipes/API destinations, Bedrock Agent action groups, ALB listener rules, Lambda event source mappings, Verified Permissions schemas, and Step Functions ASL definitions emit partial OpenAPI JSON evidence without inventing business endpoints. | The live AWS matrix passed `appsync-events`, `eventbridge-rule`, `eventbridge-pipe`, `eventbridge-api-destination`, `bedrock-action-group`, `alb-listener-rule`, `lambda-event-source`, `verified-permissions`, and `step-functions`. `validate-p3-surfaces.mjs` also passed 9 supplemental fixture cases. |
| IaC and repo signals | CloudFormation/SAM, Terraform, CDK, Pulumi, workflow, serverless config, Helm/Kubernetes Ingress, docker-compose, ECS task definitions, `application.yml`, `appsettings.json`, README, GraphQL, Lambda URL, SNS/EventBridge bridge, and SNS contract fixtures produce provider hints, URL hints, custom domains, and contract file signals. | `validate-iac-signals.mjs` passed 8 cases. Signal-discovered `asyncapi.yaml` and `schema.graphql` fixtures both derive OpenAPI 3.x. |

## Live AWS Status

The live validation stack is `spec-discovery-validation` in `us-east-1`. The latest captured stack status was `UPDATE_COMPLETE`, and `validate-live-aws-surfaces.mjs` passed 24 live AWS cases, including the modeled REST route and all AWS-derived P3 surfaces.

<!-- evidence:live-resource-summary:start -->
## Live Resource Summary

- Captured at: 2026-07-18T02:45:12.848Z
- Stack: spec-discovery-validation
- Region: us-east-1
- Account: XXXXXXXXXXXX
- Status: UPDATE_COMPLETE
- Output keys: AlbListenerRuleArn, AppSyncEventApiId, AppSyncEventApiName, AppSyncEventChannelNamespaceName, BedrockActionGroupName, BedrockAgentId, EventBridgeApiDestinationName, EventBridgePipeName, EventBridgeRuleName, GlueRegistryName, GraphqlApiId, HttpApiId, LambdaEventSourceMappingId, LambdaFunctionName, LambdaFunctionUrl, RestApiId, SchemaRegistryName, SnsSubscriptionTopicArn, SnsTestTopicArn, SnsUrlTopicArn, StepFunctionsStateMachineArn, StepFunctionsStateMachineName, VerifiedPermissionsPolicyStoreId, WebSocketApiId

Raw live identifiers are stored only in `live-resource-manifest.local.json`.
<!-- evidence:live-resource-summary:end -->

<!-- evidence:repo-spec-matrix:start -->
## Repo Spec Matrix Evidence

- Captured at: 2026-07-17T22:53:54.693Z
- Cases: 15
- Passed: 15
- Failed: 0

| Case | Source Type | Spec Format | Derived OAS | Result |
| --- | --- | --- | --- | --- |
| openapi-3.0-yaml | repo-spec | openapi-yaml | 3.0.3 full openapi-json | pass |
| openapi-3.1-json | repo-spec | openapi-json | 3.1.0 full openapi-json | pass |
| versioned-openapi-reference | repo-spec | openapi-yaml | 3.0.3 full openapi-json | pass |
| swagger-2.0-yaml | repo-spec | openapi-yaml | 3.0.3 partial openapi-json | pass |
| graphql-sdl | repo-spec | graphql-sdl | 3.1.0 partial openapi-json | pass |
| asyncapi-yaml | repo-spec | asyncapi-yaml | 3.1.0 partial openapi-json | pass |
| postman-collection | repo-spec | postman-collection | 3.1.0 partial openapi-json | pass |
| json-schema-derivation | derivation-only | json-schema | 3.1.0 partial openapi-json | pass |
| avro-derivation | derivation-only | avro | 3.1.0 partial openapi-json | pass |
| protobuf | repo-spec | protobuf | 3.1.0 partial openapi-json | pass |
| smithy | repo-spec | smithy | 3.1.0 partial openapi-json | pass |
| smithy-build | repo-spec | smithy | 3.1.0 partial openapi-json | pass |
| backstage-yaml-local-openapi | repo-spec | openapi-yaml | 3.0.3 full openapi-json | pass |
| backstage-yml-local-graphql | repo-spec | graphql-sdl | 3.1.0 partial openapi-json | pass |
| backstage-remote-openapi | repo-spec | openapi-yaml | 3.0.3 full openapi-json | pass |
<!-- evidence:repo-spec-matrix:end -->

<!-- evidence:live-aws-surfaces:start -->
## Live AWS Surface Evidence

- Captured at: 2026-07-18T05:22:33.717Z
- Elapsed ms: 12938
- Stack: spec-discovery-validation
- Region: us-east-1
- Cases: 24
- Passed: 24
- Failed: 0
- Route-only REST checks: 5/5 passed (export content omission, audit, warning, live JSON response, Content-Length)
- Contract-control wire checks: 6/6 passed (clean 204, managed-service normalization, valid/invalid schema payloads, Content-Length)

| Case | Runner | Source Type | Provider | Format | Contract audit | Derived OAS | Elapsed ms | Result |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| api-gateway-rest | runtime | gateway-export | api-gateway | openapi-yaml | schema-incomplete (4 response(s) without content) | 3.0.3 full | 1717 | pass |
| api-gateway-rest-modeled-route | runtime | gateway-export | api-gateway | openapi-yaml | schema-incomplete (4 response(s) without content) | 3.0.3 full | 1353 | pass |
| api-gateway-rest-fallback | live-sdk | gateway-export | api-gateway | openapi-yaml |  | 3.0.3 partial | 466 | pass |
| api-gateway-http | runtime | gateway-export | api-gateway | openapi-yaml | schema-complete (0 response(s) without content) | 3.0.3 full | 1483 | pass |
| api-gateway-websocket | runtime | gateway-export | api-gateway | openapi-yaml | schema-incomplete (1 response(s) without content) | 3.0.3 partial | 1709 | pass |
| appsync | runtime | appsync-schema | appsync | graphql-sdl |  | 3.1.0 partial | 717 | pass |
| appsync-events | runtime | appsync-event-api | appsync-events | openapi-json |  | 3.1.0 partial | 535 | pass |
| eventbridge-schemas | runtime | eventbridge-schema | eventbridge-schemas | openapi-json |  | 3.0.3 full | 885 | pass |
| eventbridge-rule | runtime | eventbridge-surface | eventbridge | openapi-json |  | 3.1.0 partial | 440 | pass |
| eventbridge-pipe | runtime | eventbridge-surface | eventbridge | openapi-json |  | 3.1.0 partial | 529 | pass |
| eventbridge-api-destination | runtime | eventbridge-surface | eventbridge | openapi-json |  | 3.1.0 partial | 320 | pass |
| cloudformation-embedded | runtime | cfn-embedded | cloudformation | openapi-json |  | 3.0.3 full | 757 | pass |
| glue-schema | runtime | glue-schema | glue | avro |  | 3.1.0 partial | 830 | pass |
| ssm-registry | runtime | ssm-registry | ssm | asyncapi-yaml |  | 3.1.0 partial | 717 | pass |
| ssm-url-registry | runtime | ssm-registry | ssm | json-schema |  | 3.1.0 partial | 831 | pass |
| ssm-url-pointer | runtime | ssm-registry | ssm | openapi-json |  | 3.1.0 partial | 631 | pass |
| lambda-url | runtime | lambda-url-export | lambda-url | openapi-yaml |  | 3.0.3 partial | 753 | pass |
| lambda-event-source | runtime | lambda-event-source | lambda-event-source | openapi-json |  | 3.1.0 partial | 799 | pass |
| verified-permissions | runtime | verified-permissions-schema | verified-permissions | openapi-json |  | 3.1.0 partial | 413 | pass |
| step-functions | runtime | step-functions-asl | step-functions | openapi-json |  | 3.1.0 partial | 497 | pass |
| alb-listener-rule | runtime | alb-listener-rule | alb-listener-rule | openapi-json |  | 3.1.0 partial | 498 | pass |
| bedrock-action-group | runtime | bedrock-action-group | bedrock-action-group | openapi-json |  | 3.0.3 partial | 969 | pass |
| sns-ssm-content | runtime | sns-contract | sns | asyncapi-yaml |  | 3.1.0 partial | 9173 | pass |
| sns-webhook-sidecar | runtime | sns-contract | sns | asyncapi-yaml |  | 3.1.0 partial | 9562 | pass |
<!-- evidence:live-aws-surfaces:end -->

<!-- evidence:iac-repo-signals-matrix:start -->
## IaC and Repo Signal Matrix Evidence

- Captured at: 2026-07-17T22:53:54.998Z
- Cases: 8
- Passed: 8
- Failed: 0

| Case | Provider hints | Other checks | Result |
| --- | --- | ---: | --- |
| cloudformation-sam | appsync, sns, eventbridge-schemas, glue, api-gateway, lambda-url | 6 | pass |
| terraform | appsync, api-gateway, sns, eventbridge-schemas, glue, lambda-url | 5 | pass |
| cdk | appsync, sns, api-gateway, eventbridge-schemas, lambda-url | 5 | pass |
| pulumi | api-gateway, appsync, sns, lambda-url | 5 | pass |
| workflow-readme-graphql | lambda-url, sns, eventbridge-schemas, appsync | 6 | pass |
| expanded-configs | sns, lambda-url | 5 | pass |
| nested-backstage |  | 5 | pass |
| deployment-configs | api-gateway, lambda-url | 5 | pass |
<!-- evidence:iac-repo-signals-matrix:end -->

<!-- evidence:p3-surfaces:start -->
## P3 Surface Fixture Evidence

- Captured at: 2026-07-17T22:53:55.238Z
- Cases: 9
- Passed: 9
- Failed: 0
- Scope: supplemental fixture coverage for AWS-derived surfaces; live AWS coverage is recorded in the Live AWS Surface Evidence section.

| Case | Provider Type | Artifact | Completeness | Result |
| --- | --- | --- | --- | --- |
| eventbridge-rule | eventbridge | openapi-json | partial | pass |
| eventbridge-pipe | eventbridge | openapi-json | partial | pass |
| eventbridge-api-destination | eventbridge | openapi-json | partial | pass |
| bedrock-action-group | bedrock-action-group | openapi-json | partial | pass |
| appsync-events | appsync-events | openapi-json | partial | pass |
| alb-listener-rule | alb-listener-rule | openapi-json | partial | pass |
| lambda-event-source | lambda-event-source | openapi-json | partial | pass |
| verified-permissions | verified-permissions | openapi-json | partial | pass |
| step-functions | step-functions | openapi-json | partial | pass |
<!-- evidence:p3-surfaces:end -->

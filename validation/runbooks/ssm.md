# SSM Registry Validation

Surface: SSM Parameter Store registry under `/postman/specs/{service-name}/`.

## Fixture

Use `validation/fixtures/aws/live-stack.yaml`.

## Expected Evidence

- Provider type: `ssm`
- Source type: `ssm-registry`
- Inline `content` beats URL fetch for the same service.
- URL fetch produces fetched content when reachable or a pointer artifact when unreachable.
- OAS derivation: full OpenAPI for OpenAPI content, or partial OpenAPI 3.1 for AsyncAPI, JSON Schema, GraphQL, protobuf, and Postman content.

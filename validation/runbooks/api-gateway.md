# API Gateway Validation

Surfaces: REST, HTTP, and WebSocket API Gateway discovery.

## Fixtures

Use `validation/fixtures/aws/live-stack.yaml`.

## Reproduction

```bash
aws cloudformation deploy \
  --template-file validation/fixtures/aws/live-stack.yaml \
  --stack-name spec-discovery-validation \
  --region us-east-1 \
  --capabilities CAPABILITY_IAM

npm run build
node validation/scripts/capture-live-manifest.mjs --stack-name spec-discovery-validation --region us-east-1
node validation/scripts/validate-live-aws-surfaces.mjs
node validation/scripts/run-cli-surface.mjs --surface discover-many --region us-east-1 --keep-workspace true
```

For the route-only REST fixture, retain the CLI result JSON and warning log. Confirm the exported OpenAPI response has no `content`, then verify:

```text
openapiContractAudit.schemaVersion = 1
openapiContractAudit.status = schema-incomplete
openapiContractAudit.responsesWithoutContent >= 1
warning prefix = AWS_OPENAPI_CONTRACT_INCOMPLETE:
```

Pass that exact exported spec to the released bootstrap CLI. Run the generated cloud contract collection against the live `/health` route and retain a receipt showing the endpoint returns `{"status":"ok"}`, the contract run exits zero, and the legal nonzero `Content-Length` assertion passes. Do not enrich the fixture with an API Gateway response model for this check; the missing model is the behavior under test.

## Expected Evidence

- REST API exports OpenAPI 3.0 YAML.
- Route-only REST exports carry a schema-version-1 `schema-incomplete` audit and the actionable warning without modifying the exported OpenAPI.
- The same route-only export passes downstream bootstrap contract execution against its real JSON response without an invented empty-body assertion.
- REST API fallback reads live resources, methods, and models and synthesizes partial OpenAPI 3.0 YAML when native export hits a known API Gateway export limitation.
- HTTP API exports OpenAPI 3.0 YAML.
- WebSocket API resolves as API Gateway v2 and writes partial OpenAPI 3.0 YAML synthesized from live route metadata, request models, component schemas, integration metadata, authorizers when present, and route responses.

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

## Expected Evidence

- REST API exports OpenAPI 3.0 YAML.
- HTTP API exports OpenAPI 3.0 YAML.
- WebSocket API resolves as API Gateway v2 and writes partial OpenAPI 3.0 YAML synthesized from live WebSocket route metadata.

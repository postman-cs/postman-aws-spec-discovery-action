# SNS Contract Validation

Surface: SNS contract resolver.

## Fixtures

- `validation/fixtures/aws/live-stack.yaml`
- `validation/fixtures/repo-spec/asyncapi.yaml`
- `validation/fixtures/repo-spec/openapi-3.1.json` for webhook sidecar comparison

## Expected Evidence

- Provider type: `sns`
- Source type: `sns-contract` or `manual-review`
- Contract origin covers repo AsyncAPI, repo JSON Schema, generated AsyncAPI, SSM content, SSM URL, catalog URL, EventBridge-derived, code-derived, and manual review.
- Metadata sidecar is emitted for every SNS resolution.
- HTTP/S subscriptions emit `webhook.openapi.json` with OpenAPI 3.1 webhooks.
- Webhook operations include `x-sns-delivery-variant`, `x-sns-filter-policy`, `x-sns-filter-policy-scope`, `x-sns-delivery-policy`, and `x-sns-redrive-policy` when those attributes are present.
- OAS derivation: partial OpenAPI 3.1 from the canonical AsyncAPI/JSON Schema artifact, plus OpenAPI 3.1 webhook sidecar for HTTP/S subscriptions.

Run `node validation/scripts/validate-live-aws-surfaces.mjs` after `capture-live-manifest.mjs` to reproduce the SNS validation.

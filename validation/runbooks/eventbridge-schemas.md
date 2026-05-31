# EventBridge Schemas Validation

Surface: EventBridge Schema Registry.

## Fixture

Use `validation/fixtures/aws/live-stack.yaml`.

## Expected Evidence

- Provider type: `eventbridge-schemas`
- Source type: `eventbridge-schema`
- Spec format: `openapi-json` for OpenApi3 schema content or `json-schema` for raw JSON schema content.
- The validation fixture stores OpenApi3 schema content and should resolve as `openapi-json`.

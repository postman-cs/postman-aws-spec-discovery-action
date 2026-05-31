# Glue Schema Registry Validation

Surface: Glue Schema Registry.

## Fixture

Use `validation/fixtures/aws/live-stack.yaml`.

## Expected Evidence

- Provider type: `glue`
- Source type: `glue-schema`
- Spec format: `avro`, `json-schema`, or `protobuf`
- OAS derivation: partial OpenAPI 3.1 from the exported schema artifact.

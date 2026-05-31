# CloudFormation Validation

Surfaces: live CloudFormation stack correlation and embedded OpenAPI extraction.

## Fixtures

- `validation/fixtures/aws/live-stack.yaml`
- `validation/fixtures/iac/cloudformation/template.yaml`

## Expected Evidence

- Provider type: `cloudformation`
- Source type: `cfn-embedded`
- Spec format: `openapi-json` or `openapi-yaml`
- Evidence references the stack and resource type, with stack identifiers sanitized.

# Lambda Function URL Validation

Surface: Lambda Function URL synthetic OpenAPI.

## Fixtures

- `validation/fixtures/aws/live-stack.yaml`
- `validation/fixtures/iac/cloudformation/lambda-url.yaml`
- Live Lambda Function URL resources are captured in the local manifest when the validation stack is deployed.

## Expected Evidence

- Provider type: `lambda-url`
- Source type: `lambda-url-export`
- Spec format: `openapi-yaml`
- Generated OAS includes server URL, catch-all `/{proxy}` path, standard HTTP methods, auth type, invoke mode, CORS, and SigV4 security when IAM auth is enabled.

Run `node validation/scripts/validate-live-aws-surfaces.mjs` after `capture-live-manifest.mjs` to reproduce the Lambda URL validation.

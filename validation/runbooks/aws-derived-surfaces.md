# AWS-Derived Surface Runbook

This runbook covers P3 discovery surfaces that derive partial OpenAPI evidence from AWS metadata rather than native spec exports:

- AppSync Events channel namespaces
- EventBridge rules, pipes, and API destinations
- Bedrock Agent action groups
- ALB listener rules
- Lambda event source mappings
- Verified Permissions schemas
- Step Functions ASL definitions

Current status: fixture-only / official-doc-backed, not live-validated.

## Reproduce

Run from the repository root:

```bash
npm run build
node validation/scripts/check-validation-fixtures.mjs
node validation/scripts/validate-p3-surfaces.mjs
```

The script reads `validation/fixtures/aws/p3-surfaces.json`, runs each provider through the packaged `dist/index.cjs` exports, and refreshes the `P3 Surface Fixture Evidence` section in `validation/evidence/README.md`.

## Expected Artifacts

All P3 AWS-derived surfaces emit `index.json` as partial OpenAPI JSON:

- EventBridge rules and pipes are represented as webhooks with `x-aws-eventbridge-*` metadata.
- EventBridge API destinations are represented as HTTP operations with destination metadata.
- Bedrock action groups preserve inline or S3-backed OpenAPI schemas and add `x-aws-bedrock-agent-action-group`.
- AppSync Events emits publish and subscribe webhooks per channel namespace.
- ALB listener rules derive path/method/query constraints with `x-aws-alb-listener-rule`.
- Lambda event source mappings preserve filter criteria and batch/source settings.
- Verified Permissions emits authorization schema metadata with empty `paths`.
- Step Functions emits a partial execution-start operation with ASL metadata.

Do not claim live AWS support for these surfaces until dedicated live resources are added to `validation/fixtures/aws/live-stack.yaml` and `validate-live-aws-surfaces.mjs`.

## Official Source Backing

- EventBridge rules and API destinations: https://docs.aws.amazon.com/eventbridge/latest/APIReference/
- EventBridge Pipes filter criteria: https://docs.aws.amazon.com/eventbridge/latest/pipes-reference/API_FilterCriteria.html
- Bedrock action group OpenAPI schemas: https://docs.aws.amazon.com/bedrock/latest/userguide/agents-api-schema.html
- AppSync Events and channel namespaces: https://docs.aws.amazon.com/appsync/latest/eventapi/channel-namespaces.html
- ALB listener rule conditions: https://docs.aws.amazon.com/elasticloadbalancing/latest/application/rule-condition-types.html
- Lambda event filtering: https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html
- Verified Permissions schemas: https://docs.aws.amazon.com/verifiedpermissions/latest/apireference/API_GetSchema.html
- Step Functions ASL definitions: https://docs.aws.amazon.com/step-functions/latest/dg/statemachine-structure.html

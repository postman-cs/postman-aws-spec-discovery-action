# AWS-Derived Surface Runbook

This runbook covers P3 discovery surfaces that derive partial OpenAPI evidence from AWS metadata rather than native spec exports:

- AppSync Events channel namespaces
- EventBridge rules, pipes, and API destinations
- Bedrock Agent action groups
- ALB listener rules
- Lambda event source mappings
- Verified Permissions schemas
- Step Functions ASL definitions

Current status: live-validated against dedicated resources in the `spec-discovery-validation` stack. Fixture validation remains as deterministic supplemental coverage for provider-specific metadata shapes.

## Reproduce

Run from the repository root:

```bash
npm run build
ALB_VPC_ID=$(aws ec2 describe-vpcs \
  --region us-east-1 \
  --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' \
  --output text)
ALB_SUBNET_IDS=$(aws ec2 describe-subnets \
  --region us-east-1 \
  --filters Name=vpc-id,Values="$ALB_VPC_ID" Name=default-for-az,Values=true \
  --query 'Subnets[0:2].SubnetId' \
  --output text | tr '\t' ',')
aws cloudformation deploy \
  --template-file validation/fixtures/aws/live-stack.yaml \
  --stack-name spec-discovery-validation \
  --region us-east-1 \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides AlbVpcId="$ALB_VPC_ID" AlbSubnetIds="$ALB_SUBNET_IDS"
node validation/scripts/capture-live-manifest.mjs --stack-name spec-discovery-validation --region us-east-1
node validation/scripts/validate-live-aws-surfaces.mjs
node validation/scripts/check-validation-fixtures.mjs
node validation/scripts/validate-p3-surfaces.mjs
```

The live stack creates dedicated resources for AppSync Events, EventBridge rules/pipes/API destinations, Bedrock Agent action groups, ALB listener rules, Lambda event source mappings, Verified Permissions schemas, and Step Functions ASL definitions. `capture-live-manifest.mjs` records sanitized stack outputs, `validate-live-aws-surfaces.mjs` proves live AWS derivation, and `validate-p3-surfaces.mjs` refreshes supplemental fixture coverage.

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

## Official Source Backing

- EventBridge rules and API destinations: https://docs.aws.amazon.com/eventbridge/latest/APIReference/
- EventBridge Pipes filter criteria: https://docs.aws.amazon.com/eventbridge/latest/pipes-reference/API_FilterCriteria.html
- Bedrock action group OpenAPI schemas: https://docs.aws.amazon.com/bedrock/latest/userguide/agents-api-schema.html
- AppSync Events and channel namespaces: https://docs.aws.amazon.com/appsync/latest/eventapi/channel-namespaces.html
- ALB listener rule conditions: https://docs.aws.amazon.com/elasticloadbalancing/latest/application/rule-condition-types.html
- Lambda event filtering: https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html
- Verified Permissions schemas: https://docs.aws.amazon.com/verifiedpermissions/latest/apireference/API_GetSchema.html
- Step Functions ASL definitions: https://docs.aws.amazon.com/step-functions/latest/dg/statemachine-structure.html

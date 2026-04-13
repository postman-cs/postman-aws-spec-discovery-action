# Live Testing Runbook

End-to-end integration tests that run the built CLI against real AWS resources. These tests validate the full discovery and resolution pipeline, including SNS contract resolution with subscription enrichment, metadata sidecars, and webhook sidecars.

## Prerequisites

### AWS account

You need an AWS account with sufficient IAM permissions. The minimum policy for all providers is documented in the project README under "Full IAM policy (all providers)." In addition to those read-only permissions, deploying the test stack requires:

- `cloudformation:CreateStack`, `cloudformation:UpdateStack`, `cloudformation:DeleteStack`, `cloudformation:DescribeStacks`, `cloudformation:DescribeStackEvents`
- `sqs:CreateQueue`, `sqs:DeleteQueue`, `sqs:SetQueueAttributes`, `sqs:GetQueueAttributes`
- `iam:CreateRole`, `iam:DeleteRole`, `iam:AttachRolePolicy`, `iam:DetachRolePolicy` (only if the stack includes IAM resources via `CAPABILITY_IAM`)
- Standard resource creation permissions for SNS, SSM, API Gateway, AppSync, EventBridge Schemas, and Glue

AWS CLI must be configured and authenticated (`aws sts get-caller-identity` should succeed).

### Local environment

- Node.js 24+
- Dependencies installed: `npm ci`
- CLI built: `npm run build`

Live tests execute `dist/cli.cjs`, **not** source TypeScript. Always rebuild before running live tests.

## Stack deployment

The test CloudFormation stack creates all the AWS resources needed by the live tests.

### Deploy

```bash
aws cloudformation deploy \
  --template-file tests/live/test-resources.yaml \
  --stack-name spec-discovery-test \
  --region us-east-1 \
  --capabilities CAPABILITY_IAM
```

### Verify

```bash
aws cloudformation describe-stacks \
  --stack-name spec-discovery-test \
  --query 'Stacks[0].StackStatus'
```

Expected output: `"CREATE_COMPLETE"` or `"UPDATE_COMPLETE"`.

### What the stack creates

| Category | Resources |
| --- | --- |
| SNS topics | 5 topics: `SpecDiscoveryTestTopic`, `SpecDiscoveryTaggedTopic` (tagged `postman:project-name=test-service`), `SpecDiscoveryTestTopic.fifo` (FIFO), `SpecDiscoverySubscribedTopic`, `SpecDiscoveryUrlTopic` |
| SQS queues | 2 queues: `SpecDiscoverySubscriptionQueue` (envelope delivery), `SpecDiscoveryRawSubscriptionQueue` (raw delivery) -- both subscribed to `SpecDiscoverySubscribedTopic` |
| SNS subscriptions | SQS envelope, SQS raw-payload, HTTPS to `https://example.com/sns-webhook-test` |
| SSM parameters | 4 parameters: inline AsyncAPI content + format for `spec-discovery-test-topic`, spec-url + format for `spec-discovery-url-topic` |
| API Gateway | 1 REST API (`spec-discovery-test-rest` with prod stage), 1 HTTP API (`spec-discovery-test-http`), 1 WebSocket API (`spec-discovery-test-websocket`) |
| AppSync | 1 GraphQL API (`spec-discovery-test-graphql`) with schema |
| EventBridge | 1 Schema Registry (`spec-discovery-test-registry`) with `OrderCreated` schema |
| Glue | 1 Schema Registry (`spec-discovery-test-glue-registry`) with Avro schema |

The HTTPS subscription to `example.com` will remain in `PendingConfirmation` state permanently. This is expected and does not affect test execution.

## Running live tests

### Standard command

```bash
npm run test:live:sns
```

### Direct vitest invocation

```bash
npx vitest run --config vitest.live.config.ts
```

### Configuration details

- **Region**: hardcoded to `us-east-1` (cannot be overridden without code changes)
- **Timeout**: 180 seconds per test
- **Workspaces**: tests create temporary directories in the OS temp folder, cleaned up automatically via `afterEach`
- **Retry**: built-in retry (up to 3 attempts) with 1500ms throttle backoff on `TooManyRequests` errors

### Recommended workflow

```bash
npm run build && npm run test:live:sns
```

Always rebuild before running live tests since they execute the bundled `dist/cli.cjs`.

## What the tests cover

The live test suite (`tests/live/sns-integration.test.ts`) contains 7 tests:

| Test | Description |
| --- | --- |
| discover-many | Full multi-provider discovery including SNS with subscription metadata and webhook sidecars. Validates service count, output directory structure, metadata sidecar content, and webhook sidecar OpenAPI structure. Confirms both `sns` and `api-gateway` providers appear. |
| resolve-one with repo-local AsyncAPI | Copies `asyncapi.yaml` fixture into workspace, verifies SNS contract resolution prefers repo-local AsyncAPI. Checks spec format is `asyncapi-yaml` and exported file contains `asyncapi: 2.6.0`. |
| resolve-one with repo-local JSON Schema | Copies `schema.json` fixture into workspace, verifies SNS contract resolution uses repo-local JSON Schema. Checks spec format is `json-schema` and exported file contains `$schema`. |
| resolve-one with SSM inline content | No local contract in workspace. Verifies fallback to SSM inline content at `/postman/specs/spec-discovery-test-topic/content`. Checks resolution evidence references the SSM path. |
| resolve-one with SSM spec-url fetch | No local contract in workspace. Verifies fallback to SSM `spec-url` at `/postman/specs/spec-discovery-url-topic/spec-url`, which points to `https://json.schemastore.org/package`. Validates metadata sidecar is emitted with `contractOrigin: ssm-url`. |
| resolve-one manual-review | No local contract, no SSM match for `SpecDiscoverySubscribedTopic`. Verifies `resolution-status: unresolved` and `source-type: manual-review`. |
| Tag-based candidate ranking | Uses `SpecDiscoveryTaggedTopic` (tagged `postman:project-name=test-service`) with `expected-service-name=test-service`. Verifies tag-based scoring selects the correct topic and `service-name` output matches. |

## Troubleshooting

### Build dependency

Tests run `dist/cli.cjs`, not source TypeScript. If tests fail with `CLI bundle not found`, rebuild:

```bash
npm run build && npm run test:live:sns
```

### TooManyRequests / throttling

The test harness has built-in retry with 1500ms backoff. Accounts with many APIs may still exhaust retries. If throttling persists:

1. Wait a few minutes and rerun
2. Reduce concurrent AWS activity in the account
3. Multiple runs may be needed for heavily loaded accounts

### SSM URL test fails with `resolution-status: unresolved`

Verify the SSM parameters exist:

```bash
aws ssm get-parameters-by-path \
  --path /postman/specs/spec-discovery-url-topic \
  --region us-east-1
```

Confirm the URL (`https://json.schemastore.org/package`) is reachable from your network:

```bash
curl -sI https://json.schemastore.org/package | head -1
```

### External URL dependency

The SSM URL test fetches `json.schemastore.org`. If that site is down, the test will fail. This is an expected external dependency.

### Region mismatch

All stack resources must be in `us-east-1`. The test harness hardcodes `INPUT_AWS_REGION=us-east-1`. Deploying the stack in a different region will cause all tests to fail.

### Account resource collision

The stack uses fixed resource names (e.g., `SpecDiscoveryTestTopic`, `spec-discovery-test-rest`). Only one instance of the stack can exist per account. If a previous deployment exists, update or delete it before redeploying.

### Subscription PendingConfirmation

The HTTPS subscription to `example.com` will permanently show `PendingConfirmation`. This is expected behavior -- the endpoint never confirms. Tests account for this state.

## Stack teardown

### Delete

```bash
aws cloudformation delete-stack \
  --stack-name spec-discovery-test \
  --region us-east-1
```

### Verify deletion

```bash
aws cloudformation wait stack-delete-complete \
  --stack-name spec-discovery-test \
  --region us-east-1
```

This command blocks until the stack is fully deleted.

## Test architecture

### Separation of unit and live tests

| Config | File | Tests | Command | Requires AWS |
| --- | --- | --- | --- | --- |
| `vitest.config.ts` | Unit tests | 276 tests in `tests/**/*.test.ts` | `npm test` | No |
| `vitest.live.config.ts` | Live tests | 7 tests in `tests/live/**/*.test.ts` | `npm run test:live:sns` | Yes |

The two configs are completely separate. Unit tests explicitly exclude `tests/live/`, and live tests only include `tests/live/`. There is no shared setup between them.

### Live test fixtures

Located in `tests/live/fixtures/`:

- `asyncapi.yaml` -- AsyncAPI 2.6.0 contract used by the repo-local AsyncAPI test
- `schema.json` -- JSON Schema (draft 2020-12) used by the repo-local JSON Schema test
- `asyncapi-malformed.yaml` -- malformed AsyncAPI file (available for negative testing)

### How live tests work

Each test:

1. Creates a temporary workspace directory via `mkdtemp`
2. Writes a minimal `template.yaml` with an `AWS::SNS::Topic` resource (and optionally copies fixture files)
3. Invokes `dist/cli.cjs` via `execFileSync` with environment variables controlling mode, region, and service name
4. Parses both stdout JSON and `result.json` file output, verifying they match
5. Asserts on resolution status, source type, provider type, spec format, file existence, and content
6. Cleans up the workspace in `afterEach`

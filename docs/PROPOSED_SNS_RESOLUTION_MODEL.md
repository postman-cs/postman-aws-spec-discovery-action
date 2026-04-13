## Proposed SNS Resolution Model

> **Implementation Status: IMPLEMENTED** -- This design document has been implemented as of the current release. See the [deviations from design](#deviations-from-design) section below for differences between this proposal and the actual implementation.
>
> For the next-phase expansion plan, including subscription-aware modeling, SSM URL fetch support, EventBridge-derived fallbacks, and code-derived resolution, see [PROPOSED_SNS_RESOLUTION_EXPANSION_MODEL.md](./PROPOSED_SNS_RESOLUTION_EXPANSION_MODEL.md).

### Deviations from design

The following aspects differ from the original proposal:

1. **SSM URL fetch is not implemented for SNS.** The SNS provider only uses `content` entries from SSM Parameter Store (`/postman/specs/{service-name}/content`). URL entries (`/postman/specs/{service-name}/url`) are not fetched. This is intentional -- SNS contract resolution prioritizes content that is immediately available rather than remote fetches that may fail.

2. **discover-many exports manual-review results as files.** The original design did not specify this behavior. In the implementation, `discover-many` mode writes `manual-review.json` files for every topic that lacks a resolvable contract, giving full visibility into contract coverage gaps.

3. **Tag-based naming uses `postman:project-name` specifically.** The design mentioned tag-based naming generally. The implementation uses the `postman:project-name` tag as the primary source for the service/topic name, falling back to the ARN-derived topic name.

4. **SNS candidate scoring.** The implementation scores candidates against service hints with the following weights:
   - Exact topic name match: +60
   - `postman:project-name` tag exact match: +50
   - Partial name match (contains): +40
   - Any tag value contains hint: +20
   - Resolved confidence floor: 60 (minimum)

5. **resolve-one now uses multi-source peer resolution for API Gateway and SNS.** SNS is no longer a post-gateway fallback. When SNS IaC signals are present, `resolve-one` evaluates both sources as peers and selects deterministically using confidence and origin-aware tie-breaks.
   - Higher-confidence candidate wins (`gateway-export` vs `sns-contract`)
   - Equal-confidence ties prefer SNS only for repo-local origins (`repo-asyncapi`, `repo-json-schema`)
   - Equal-confidence ties prefer API Gateway when SNS is SSM-backed (`ssm`) or otherwise non-repo-local
   - If only one source resolves, that source is selected
   - If neither source resolves, result is `manual-review` with combined evidence from both resolution paths

6. **Phase 2 and Phase 3 are not yet implemented.** Catalog alignment, drift-aware automation, and agent mode integration remain future work.

---

### Purpose

This document proposes how `postman-aws-spec-discovery-action` should add **AWS SNS** as a first-class provider for **event-driven contract resolution**, with a focus on the the customer requirement to detect **contract drift** across publisher/consumer boundaries rather than only discovering HTTP endpoints.

The core design principle is:

> SNS support is not just topic discovery. It is the ability to discover a topic, resolve a durable contract for the messages on that topic, and feed that contract into downstream documentation, testing, catalog, and agent workflows.

### Problem Statement

the customer's architecture uses large numbers of SNS topics to propagate events between services. Their primary failure mode is not simple uptime loss. It is:

- a producer changes an event payload unexpectedly
- an upstream team makes a change the downstream team does not control
- a consumer still receives messages, but payload shape or semantics drift
- breakage is detected late, often only after downstream impact

SNS does not provide a native exportable API spec like API Gateway. Therefore, adding SNS requires a **resolution model for event contracts**, not just an AWS resource listing.

## Goals

- Add SNS as a supported provider in discovery and resolution.
- Detect SNS topic usage from repository IaC and code signals.
- Resolve an event contract for a topic from repo-local files or SSM pointers.
- Make `resolve-one` capable of returning an SNS-backed contract, not only REST/GraphQL specs.
- Enable downstream contract testing and drift detection in API Catalog and Agent mode.

## Non-Goals

- Inferring full contracts from live SNS traffic in v1.
- Building end-to-end queue lag or runtime observability in this action.
- Solving all multi-message-type topic modeling in the first release.

## Proposed Contract Model

### Canonical representation

The action should support two event contract representations for SNS:

1. **AsyncAPI** (`asyncapi.yaml`, `asyncapi.yml`, `asyncapi.json`) for topic-level documentation and workflow metadata.
2. **JSON Schema** (`schema.json`, `event.schema.json`, `*.schema.json`) for payload validation when AsyncAPI is not present.

The preferred precedence is:

1. AsyncAPI
2. JSON Schema
3. SSM pointer/content
4. manual review

### New contract additions

The following contract changes are proposed in `src/contracts.ts`:

- Add `sns` to `ProviderType`
- Add `sns-contract` to `SourceType`
- Add `asyncapi-yaml` and `asyncapi-json` to `SpecFormat`

This allows SNS contracts to be represented distinctly from generic repo specs while still using the existing output model.

## 1. Discovery Logic

### `src/lib/repo/signals.ts` updates

`collectRepoSignals()` should add SNS detection patterns alongside the existing API Gateway/AppSync/EventBridge/Glue patterns.

### CloudFormation / SAM patterns

Add provider hints for:

- `AWS::SNS::Topic`
- `AWS::SNS::Subscription`
- `AWS::Serverless::Function` blocks containing SNS event bindings
- topic ARN references such as `arn:aws:sns:`

### Terraform patterns

Add provider hints for:

- `resource "aws_sns_topic"`
- `resource "aws_sns_topic_subscription"`
- `aws_sns_topic.` references in interpolations

### CDK / TypeScript patterns

For synthesized or source CDK projects, add hints for:

- `aws-cdk-lib/aws-sns`
- `new sns.Topic(`
- `sns.Topic.fromTopicArn(`
- `subscriptions.*Subscription`
- `SnsEventSource`

### Detection output

`providerHints` should include `sns` whenever these patterns are found. Evidence strings should identify the file and match source, for example:

- `Detected sns provider hint in template.yaml`
- `Detected sns provider hint in infra/topics.tf`

### Optional follow-up scan

As a second pass, the repo scan can look for likely event-contract files near SNS infrastructure:

- `asyncapi.yaml`
- `contracts/<topic>.yaml`
- `schemas/<topic>.schema.json`
- `events/<topic>/asyncapi.yaml`

This does not replace resolution; it improves confidence and evidence.

## 2. Resolution Strategy

Because SNS has no native exportable spec, the action must resolve a contract using an explicit source-of-truth chain.

### Resolution precedence for SNS

For a discovered SNS topic, resolve in this order:

1. **Repo-local AsyncAPI** matching topic name, service name, or known aliases
2. **Repo-local JSON Schema** matching topic name, event name, or service folder
3. **SSM `/postman/specs/` registry** entry pointing to AsyncAPI/JSON Schema content or URL
4. **manual-review** if a topic exists but no trustworthy contract source is found

### Repo-local resolution

Extend `src/lib/repo/specs.ts` with SNS-aware matchers, or add a sibling module such as `src/lib/repo/event-contracts.ts`.

Suggested candidate locations:

- `asyncapi.yaml`
- `asyncapi.yml`
- `asyncapi.json`
- `spec/asyncapi.yaml`
- `api/asyncapi.yaml`
- `contracts/*.yaml`
- `contracts/*.json`
- `schemas/*.schema.json`
- `events/**/asyncapi.yaml`

Validation rules:

- AsyncAPI must contain `asyncapi`
- JSON Schema must contain `$schema`, `type`, `properties`, or similar schema markers
- Topic-specific matches should outrank generic repo-wide contracts

### SSM-backed resolution

Reuse the existing `SsmSdkClient` and `/postman/specs/{service-name}/{key}` convention, but allow topic-aware aliases.

Recommended conventions:

- `/postman/specs/{service-or-topic}/url`
- `/postman/specs/{service-or-topic}/content`
- `/postman/specs/{service-or-topic}/format`
- `/postman/specs/{service-or-topic}/topic-name`

For SNS, `format` should support:

- `asyncapi-yaml`
- `asyncapi-json`
- `json-schema`

If an SSM URL resolves successfully, the fetched contract becomes the resolved SNS spec. If fetch fails, fallback should behave like current SSM behavior: preserve a pointer artifact and emit evidence.

### New provider shape

Add `src/lib/providers/sns.ts` with a provider that:

- probes SNS read access
- lists topic candidates
- resolves contract metadata from repo signals and/or SSM
- exports the resolved contract file into `output-dir`

Unlike API Gateway, SNS export is not an AWS-generated document. The provider is therefore a **contract resolver**, not an AWS spec exporter.

## 3. Runtime Integration

### `src/runtime.ts` provider registration

Update `buildProviderRegistry()` to register `SnsProvider` after `SsmProvider`, using a new `SnsSdkClient` for topic listing and tagging.

### `resolve-one` integration

Today `resolve-one` mainly returns:

- `repo-spec`
- `gateway-export`
- `manual-review`

To support SNS, `runResolution()` must become multi-source rather than API-Gateway-first.

### Proposed `resolve-one` order

1. Backstage/local repo spec check
2. Repo-local event contract check (AsyncAPI / JSON Schema)
3. API Gateway candidate resolution
4. SNS candidate resolution
5. SSM-backed contract fallback
6. manual review

### Selection model

Introduce a generalized source chooser that evaluates:

- repo OpenAPI / GraphQL specs
- repo event contracts
- API Gateway exports
- SNS contracts
- SSM registrations

This likely means replacing the current API-Gateway-specific `chooseSource()` behavior with a scored candidate list, where SNS candidates produce:

- `sourceType: 'sns-contract'`
- `provider-type: 'sns'`
- `spec-format: asyncapi-yaml | asyncapi-json | json-schema`

### Output behavior

Resolved SNS contracts should write files like:

- `discovered-specs/<service-or-topic>/asyncapi.yaml`
- `discovered-specs/<service-or-topic>/asyncapi.json`
- `discovered-specs/<service-or-topic>/schema.json`

`resolution-json` should include SNS evidence such as:

- detected topic name
- matched contract file
- matched SSM registration
- fallback reason if contract could not be resolved

## 4. Contract Validation and Drift Detection

### Downstream contract testing

Once the SNS contract is resolved, downstream Postman automation can use it to generate:

- documentation for topic payloads
- contract tests that validate payload shape
- smoke-like validations for publisher/consumer fixtures
- CI assertions that block breaking schema drift when configured to do so

### Drift detection model

The main drift signal the customer wants is:

- a producer changes a required field
- a field type changes
- a field disappears or is renamed
- a consumer still runs but downstream assumptions are broken

Resolved SNS contracts should therefore be treated as a durable baseline that downstream systems compare against:

- repository changes in publisher code
- generated examples or fixtures
- observed consumer expectations
- catalog-linked service metadata

### API Catalog integration

In API Catalog, SNS-backed services/topics should surface:

- contract presence/absence
- last resolved contract format
- producer/consumer linkage
- contract drift failures
- governance compliance for event contracts

This enables health to include more than uptime. A service may still be reachable while its event contract is unhealthy.

### Agent mode integration

Agent mode should be able to consume SNS contract metadata the same way it consumes REST/GraphQL metadata. Example questions it should eventually answer:

- Which topics changed contract this week?
- Which consumers depend on this topic?
- Which services have SNS topics without a resolved contract?
- Did a producer introduce schema drift relative to the approved AsyncAPI/JSON Schema?

## Suggested Implementation Phases

### Phase 1: Discovery + resolution MVP

- add `sns` provider/source/format types
- add SNS repo signal detection
- add repo-local AsyncAPI/JSON Schema matching
- allow SSM to resolve SNS contracts
- add `SnsProvider` and `SnsSdkClient`
- extend `resolve-one` to emit `sns-contract`

### Phase 2: Catalog alignment

- publish SNS contract metadata into downstream catalog flows
- expose contract presence and contract failures in summaries
- distinguish transport health from contract health

### Phase 3: Drift-aware automation

- generate publisher/consumer contract validations
- add breaking-change comparison rules
- support topic-to-service dependency analysis in agent workflows

## Risks and Open Questions

- **Canonical format**: should AsyncAPI be mandatory or just preferred?
- **Topic granularity**: one topic may carry multiple event types.
- **Ownership mapping**: topic names do not always map cleanly to service names.
- **Observed vs declared truth**: should future versions compare live payloads against declared schemas?

## Recommendation

Proceed with an MVP that treats SNS as a **resolved event-contract provider** rather than an AWS export provider.

That gives the customer the missing capability they asked for:

- discover SNS-backed integrations
- resolve a durable contract source
- generate downstream contract coverage
- detect event-driven drift earlier than endpoint-only monitoring can

This is the minimum viable path that aligns the AWS action with the customer's core requirement: **event-driven contract drift detection**, not just resource discovery.

## Implementation Reference

The Phase 1 MVP has been implemented across these files:

| File | Role |
| --- | --- |
| `src/lib/providers/sns.ts` | `SnsProvider` -- contract resolver (repo-local AsyncAPI/JSON Schema, SSM content, manual-review fallback) |
| `src/lib/aws/sns-client.ts` | `SnsSdkClient` -- wraps `sns:ListTopics`, `sns:GetTopicAttributes`, `sns:ListTagsForResource` |
| `src/lib/repo/signals.ts` | SNS IaC detection patterns for CloudFormation, Terraform, CDK, Pulumi; contract evidence scanning |
| `src/runtime.ts` | `resolve-one` SNS fallback logic, `scoreSnsCandidate()`, `discover-many` SNS registration |
| `src/contracts.ts` | `sns` provider type, `sns-contract` source type, `asyncapi-yaml`/`asyncapi-json` spec formats |

## Proposed SNS Resolution Expansion Model

> **Implementation Status: PROPOSED** -- This document extends the implemented SNS contract resolver described in [PROPOSED_SNS_RESOLUTION_MODEL.md](./PROPOSED_SNS_RESOLUTION_MODEL.md). It is the planning surface for the next mission and is intentionally decision-complete.

### Summary

The current SNS resolver proves the basic model:

- detect SNS usage from repo signals
- list live topics
- resolve repo-local AsyncAPI or JSON Schema
- fall back to SSM inline content
- return `manual-review` when no trustworthy source exists

The next step is to treat SNS as a richer contract surface rather than only a topic-to-payload lookup. In practice, the useful contract is a combination of:

1. the canonical event payload
2. how SNS delivers that payload to each subscriber
3. what filters narrow delivery to specific consumers
4. what fallback sources can produce a durable contract when no hand-authored spec exists

This expansion keeps the current SNS model intact and adds more automatic resolution methods without requiring new inputs or explicit opt-in.

### Design Principles

- Keep SNS zero-config. New methods auto-attempt when SNS repo hints are present.
- Preserve one canonical primary contract per topic.
- Represent subscriber-specific behavior as variants and metadata, not as a competing primary output.
- Prefer deterministic sources over inferred ones.
- Keep provenance explicit. A resolved contract must say where it came from.
- Do not collapse SNS-derived artifacts into the existing EventBridge provider. Bridge-derived schemas remain SNS provenance.

## Goals

- Expand SNS resolution beyond repo-local files and SSM inline content.
- Model subscription-aware delivery semantics for SQS, Lambda, and HTTP/S subscribers.
- Support richer remote contract resolution using existing repo or SSM URLs.
- Add lower-confidence fallback paths for schema discovery and code-derived resolution.
- Preserve backward compatibility for current action inputs and outputs.

## Non-Goals

- No generic live traffic sniffing from SNS or SQS.
- No arbitrary remote repo crawling or authenticated catalog search.
- No broad AST inference across every supported language.
- No replacement of the canonical SNS output with per-subscriber artifacts.
- No new required inputs, feature flags, or migration steps in this mission.

## Canonical Output Model

### Primary output

Each resolved SNS topic continues to emit one primary contract file under the normal output directory.

Canonical precedence:

1. repo-local AsyncAPI
2. repo-local JSON Schema
3. repo-local generated AsyncAPI artifacts from known conventions
4. SSM inline content
5. SSM `url` / `spec-url` fetch
6. explicit remote contract URLs already referenced by checked-in repo config or catalog files
7. EventBridge-derived schema fallback
8. code-derived fallback from explicit machine-readable schema sources
9. `manual-review`

### Sidecar outputs

Subscriber-aware details are emitted as sidecars and metadata, not separate primary resolutions.

Required sidecars:

- `sns-resolution-metadata.json`
- optional per-subscriber variant descriptors
- optional HTTP/S webhook sidecar when a topic has HTTP/S subscriptions

### Provenance

The resolver must capture the origin of the canonical contract in an internal enum and in exported metadata.

Required origin values:

- `repo-asyncapi`
- `repo-json-schema`
- `generated-asyncapi`
- `ssm-content`
- `ssm-url`
- `catalog-url`
- `eventbridge-derived`
- `code-derived`
- `manual-review`

## Resolution Methods

### 1. Repo-local generated AsyncAPI artifacts

This method extends the existing repo-local search to include generated or tool-managed AsyncAPI files that are not limited to the current hard-coded filenames.

Search scope:

- `spec/**/*.asyncapi.{yaml,yml,json}`
- `contracts/**/*.asyncapi.{yaml,yml,json}`
- `events/**/asyncapi.{yaml,yml,json}`
- framework-specific generated output directories that are already repo-tracked

Acceptance rules:

- the file must contain a valid `asyncapi` top-level field
- files whose path includes the topic name or normalized service name outrank generic generated docs
- repo-tracked generated artifacts outrank SSM and remote fetches

### 2. SSM URL and `spec-url` fetch support

SNS should reuse the existing SSM remote fetch behavior already implemented for the generic SSM provider.

Behavior:

- if SNS SSM lookup finds inline `content`, keep current precedence and return it immediately
- if no inline `content` exists and `url` or `spec-url` exists, call the shared `fetchSpecFromUrl()` helper
- on successful fetch, detect format from fetched content and return it as canonical output
- on fetch failure, return a pointer-style artifact or evidence matching the current SSM provider behavior rather than hard-failing resolution

Constraints:

- no new URL validation policy beyond the shared fetcher
- no SNS-specific remote auth flow
- no retry behavior beyond the shared fetch helper defaults

### 3. Explicit remote contract URLs from repo-tracked config

SNS should be able to resolve contracts from explicit remote URLs already referenced by checked-in project config.

Allowed sources:

- Backstage catalog entries
- repo-tracked contract registry files
- explicit SNS contract URL configuration in checked-in YAML or JSON

Rules:

- only use URLs that are explicitly declared in the repo
- do not perform generic web search to discover contract URLs
- remote repo or catalog URLs are lower precedence than repo-local artifacts and SSM content
- the resulting origin must be `catalog-url`, not `repo-spec`

### 4. Subscription-aware enrichment

The SNS resolver must inspect subscriptions for each candidate topic and enrich the canonical topic contract with delivery behavior.

Required AWS reads:

- `ListSubscriptionsByTopic`
- `GetSubscriptionAttributes`

Required modeled subscription fields:

- `protocol`
- `endpoint`
- `RawMessageDelivery`
- `FilterPolicy`
- `FilterPolicyScope`
- `RedrivePolicy`
- `DeliveryPolicy`

Derived variant classes:

- `raw-payload`
- `sns-envelope`

Rules:

- subscription inspection never replaces the canonical contract
- missing permission to read subscriptions degrades to evidence only
- subscription metadata is written to the sidecar even when no new variants are emitted

### 5. Message attribute and filter-policy modeling

SNS attributes and filter policies must be modeled as part of the contract surface.

Behavior:

- preserve message attributes as structured metadata in `sns-resolution-metadata.json`
- when the canonical contract is AsyncAPI and does not already define headers, add derived header definitions for known message attributes in the emitted copy
- record whether filtering is attribute-based or message-body-based
- do not synthesize a narrowed payload schema from filter policies in the initial implementation

Rationale:

- filter policies often define subscriber-specific slices of a shared topic
- they are useful for downstream docs and testing
- they are not trustworthy enough to become the canonical payload schema without explicit authoring

### 6. HTTP/S webhook sidecars

When a topic has HTTP or HTTPS subscriptions, the resolver should emit a webhook-oriented sidecar derived from the canonical SNS contract.

Behavior:

- generate an OpenAPI 3.1 webhook document describing the HTTP callback payload shape
- include whether delivery is raw or wrapped
- include subscriber endpoint identity in metadata only, not in the webhook path shape
- keep the SNS canonical contract primary; the webhook file is supplementary

Output naming:

- `webhook.openapi.json` or `webhook.openapi.yaml`

### 7. EventBridge-derived fallback

If direct SNS sources fail, the resolver may attempt a bridge-derived schema from EventBridge.

This is not the existing EventBridge provider path. It is an SNS fallback path used only when SNS is the user’s target and a bridge flow exists.

Eligibility:

- no repo-local AsyncAPI or JSON Schema resolved
- no SSM content or remote URL resolved
- repo or AWS evidence suggests an SNS-to-EventBridge bridge exists

Strong bridge indicators:

- repo IaC declares an SNS-to-Lambda-to-EventBridge pipeline
- EventBridge schema names match topic or service hints
- schema content matches known SNS payload shape or bridge event wrapper

Rules:

- origin is `eventbridge-derived`
- confidence is lower than direct SNS or repo-owned sources
- it never outranks repo-local, SSM, or explicit catalog-backed contracts
- if the bridge appears to transform the event materially, metadata must mark the contract as transformed rather than raw SNS payload

### 8. Code-derived fallback

When no stronger contract exists, the resolver may derive a contract from explicit machine-readable code sources.

Accepted JS/TS sources:

- local JSON Schema files referenced by publisher code
- Zod or TypeBox schemas tied to an SNS publisher or topic constant
- repo-tracked generated AsyncAPI emitted by code-first tooling

Accepted Java sources:

- Springwolf-generated AsyncAPI artifacts
- explicit SNS operation annotations only when the topic name and payload type are statically recoverable

Rules:

- code-derived fallback only runs after direct repo, SSM, and remote URL sources fail
- do not infer contracts from arbitrary DTOs without explicit SNS linkage
- do not parse business logic to guess field semantics
- if multiple candidate schemas exist, resolution falls back to manual review with evidence instead of guessing

## Runtime Integration

### `resolve-one`

`resolve-one` must treat every SNS method above as part of a single SNS resolution pipeline, not as separate peer providers.

Required order:

1. existing repo spec or catalog-based API contract logic
2. API Gateway or other non-SNS resolution already implemented today
3. SNS canonical resolution pipeline
4. SNS sidecar generation and enrichment
5. final `manual-review` if SNS canonical resolution still fails

This preserves current global runtime precedence while making SNS itself more capable.

### `discover-many`

`discover-many` continues to register SNS as a provider. The provider now emits:

- the canonical SNS contract
- optional metadata sidecar
- optional webhook sidecar

Existing discover-many summary behavior remains unchanged.

## Contract and Output Changes

### `src/contracts.ts`

Add optional fields to both `ResolutionResult` and `DiscoveredService`:

- `contractOrigin?: string`
- `metadataPath?: string`
- `variantCount?: number`

Add new action outputs:

- `contract-origin`
- `contract-metadata-path`
- `variant-count`

Keep the current externally visible values unchanged:

- `source-type` remains `sns-contract`
- `provider-type` remains `sns`

### Output directory conventions

Per-topic output folder layout:

- primary contract file
- `sns-resolution-metadata.json`
- optional `webhook.openapi.json`

If multiple subscriber variants are emitted as standalone descriptors, store them under:

- `variants/<subscriber-id>.json`

## Required AWS Client Additions

Extend the SNS client interface with:

- `listSubscriptionsByTopic(topicArn)`
- `getSubscriptionAttributes(subscriptionArn)`

These reads must be non-fatal. Access-denied or unsupported conditions become evidence and do not abort topic resolution.

## Testing Requirements

### Canonical precedence

Add tests that prove deterministic selection across:

- repo-local AsyncAPI
- repo-local JSON Schema
- generated AsyncAPI artifact
- SSM inline content
- SSM URL fetch
- catalog URL
- EventBridge-derived schema
- code-derived schema
- manual review

### SSM URL behavior

Add tests for:

- successful URL fetch
- fetch timeout or invalid URL with pointer-style fallback
- precedence of SSM content over SSM URL

### Subscription enrichment

Add tests for:

- SQS subscriptions with raw delivery
- SQS subscriptions with wrapped delivery
- Lambda subscriptions using SNS envelope shape
- HTTP/S subscriptions producing webhook sidecars
- missing subscription read permissions degrading to evidence only

### Filter policy handling

Add tests for:

- `MessageAttributes` scope
- `MessageBody` scope
- filter metadata recorded without narrowing canonical payload

### EventBridge-derived fallback

Add tests proving:

- it runs only after stronger SNS sources fail
- it uses explicit SNS provenance
- transformed bridge events are flagged as transformed
- it never replaces native EventBridge provider behavior

### Code-derived fallback

Add tests for:

- JS/TS schema artifact linked to a topic
- generated Springwolf AsyncAPI artifact
- ambiguous code-derived candidates producing manual review instead of guessed output

### Backward compatibility

Add regression tests proving:

- existing SNS outputs remain valid
- current consumers that only read `spec-path`, `source-type`, and `provider-type` continue to work

## Rollout Order

### Phase 1: Deterministic expansion

- generated AsyncAPI artifact search
- SSM URL fetch support for SNS
- explicit repo-tracked remote contract URL support
- subscription inspection and metadata sidecar
- new origin and metadata outputs

### Phase 2: Delivery variants

- raw vs wrapped subscriber modeling
- message attribute enrichment
- webhook sidecar generation for HTTP/S subscribers

### Phase 3: AWS-derived fallback

- EventBridge-derived bridge resolution

### Phase 4: Code-derived fallback

- JS/TS explicit schema extraction
- Springwolf and generated AsyncAPI support

## Acceptance Criteria

- A repo with no hand-authored SNS spec but an SSM `spec-url` can now resolve a canonical SNS contract automatically.
- A repo with SNS subscriptions produces a metadata sidecar that describes delivery protocol, raw delivery, and filter policies.
- A topic with HTTP/S subscribers emits a webhook sidecar without replacing the canonical SNS contract.
- A topic with no direct contract but a verified SNS-to-EventBridge bridge can resolve a lower-confidence fallback contract.
- Existing SNS resolution flows still work unchanged for current users who do not consume the new metadata outputs.

## Open Questions Deferred

These are intentionally out of scope for this mission and must not be pulled in implicitly:

- traffic-based inference from live SNS payloads
- schema synthesis from filter policies
- arbitrary language-wide AST inference
- generic remote contract search across the open web or private systems

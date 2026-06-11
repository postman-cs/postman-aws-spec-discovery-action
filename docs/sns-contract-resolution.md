# SNS Contract Resolution

SNS is handled as a **contract resolver** rather than an AWS spec exporter. SNS has no native exportable API specification, so the provider resolves durable event contracts through a 9-level precedence chain. For each discovered SNS topic, the resolution chain is:

1. **Repo-local AsyncAPI** (`asyncapi.yaml`, `asyncapi.yml`, `asyncapi.json`) -- validated by checking for the `asyncapi` top-level key. Files with the topic name in their path are prioritized.
2. **Repo-local JSON Schema** (`schema.json`, `*.schema.json`) -- validated by checking for `$schema`, `type`, `properties`, or similar schema markers.
3. **Generated AsyncAPI artifacts** -- scans `spec/**/`, `contracts/**/`, and `events/**/` for repo-tracked generated AsyncAPI files (e.g. from code-first tooling). Must contain a valid `asyncapi` top-level field. Path-matched files outrank generic generated docs.
4. **SSM inline content** (`/postman/specs/{service-name}/content`) -- fuzzy name matching strips `.fifo` suffixes and normalizes camelCase to kebab-case.
5. **SSM URL / spec-url fetch** (`/postman/specs/{service-name}/url` or `spec-url`) -- when no inline content exists, the action fetches the registered URL using the shared spec fetcher. On fetch failure, a pointer-style artifact is emitted instead of hard-failing.
6. **Explicit remote contract URLs** -- resolves contracts from URLs already referenced by checked-in repo config: Backstage catalog entries and repo-tracked contract registry files. Origin is `catalog-url`.
7. **EventBridge-derived fallback** -- when no direct SNS contract exists and evidence suggests an SNS-to-EventBridge bridge (e.g. IaC pipeline declarations or matching schema names), the resolver attempts to derive a contract from EventBridge Schema Registry. Origin is `eventbridge-derived` with lower confidence than direct sources. Transformed bridge events are flagged in metadata.
8. **Code-derived fallback** -- extracts contracts from explicit machine-readable code sources: Zod schemas, TypeBox schemas, JSON Schema definitions linked to SNS publishers, and Springwolf-generated AsyncAPI artifacts. Only runs when stronger sources fail. Ambiguous candidates fall through to manual review.
9. **Manual review fallback** -- writes a `manual-review.json` pointer when no contract source is found.

## Subscription-aware enrichment

The SNS provider inspects topic subscriptions (SQS, Lambda, HTTP/S) and classifies delivery variants:

- **raw-payload**: subscriber receives the raw message body (when `RawMessageDelivery` is enabled)
- **sns-envelope**: subscriber receives the full SNS envelope with `Message`, `MessageAttributes`, `TopicArn`, etc.

Subscription metadata -- including protocol, raw delivery mode, filter policies, filter policy scope, redrive policy, and delivery policy -- is captured in the resolution metadata sidecar. Missing subscription read permissions degrade gracefully to evidence-only output.

## Resolution sidecars

Every SNS resolution emits a **metadata sidecar** (`sns-resolution-metadata.json`) alongside the primary contract. The sidecar contains:

- `contractOrigin` -- provenance of the canonical contract (e.g. `repo-asyncapi`, `ssm-url`, `code-derived`)
- subscription details (protocol, endpoint, raw delivery, filter policies)
- message attributes and filter policy scope
- variant count

When a topic has HTTP or HTTPS subscriptions, a supplementary **webhook sidecar** (`webhook.openapi.json`) is emitted. This is an OpenAPI 3.1 document describing the HTTP callback payload shape, including whether delivery is raw or wrapped. Webhook operations also carry SNS-specific `x-sns-*` extensions for delivery variant, filter policy, filter policy scope, delivery policy, and redrive policy when those subscription attributes are available. The webhook sidecar is supplementary; the canonical SNS contract remains primary.

## Mode behavior

- **resolve-one**: API Gateway and SNS are peer sources when SNS IaC signals are present. The resolver compares the best API Gateway and SNS candidates by confidence, selects the higher-confidence source, and applies deterministic tie-breaks: repo-local SNS origins (`repo-asyncapi`, `repo-json-schema`) win ties, while SSM-backed SNS contracts lose ties to API Gateway. Topics whose resolution produces a `manual-review` result are skipped (the next topic is tried).
- **discover-many**: SNS runs alongside all other providers. Every discovered topic gets exported, including those that produce `manual-review` results.

## SNS candidate scoring

SNS topics are scored separately from API Gateway candidates. When multiple topics exist, each is scored against service name hints (from `expected-service-name`, repo slug, or repo URL):

| Signal | Points | Description |
| --- | --- | --- |
| Exact name match | +60 | Topic name matches a service hint exactly (after FIFO suffix stripping) |
| `postman:project-name` tag match | +50 | The `postman:project-name` tag value matches a service hint exactly |
| Partial name match | +40 | Topic name contains the service hint or vice versa |
| Tag value contains hint | +20 | Any tag value on the topic contains the service hint |

Topics are sorted by score (highest first). On a tie, topics are sorted alphabetically. The resolved confidence is the maximum of 60 or the candidate score. FIFO topics (`.fifo` suffix) are handled transparently -- the suffix is stripped during name normalization for scoring.

The `max-candidates` input also applies to SNS: if more topics exist than the cap, only the top-scored topics are tried.

## Topic naming and SSM integration

**Topic naming**: The `postman:project-name` tag on the SNS topic is used as the service name. If no tag is set, the topic name from the ARN is used as a fallback.

**SSM integration for SNS**: When repo-local contracts are not found, the action checks SSM Parameter Store at `/postman/specs/{service-name}/`. Matching is fuzzy: `.fifo` suffixes are stripped and camelCase names are normalized to kebab-case. Inline `content` entries are preferred; if no content exists, `url` or `spec-url` entries are fetched using the shared spec fetcher (HTTPS only). On fetch failure, a pointer-style artifact is emitted. Example SSM registration:

```bash
aws ssm put-parameter \
  --name /postman/specs/order-events/content \
  --type String \
  --overwrite \
  --value '{"asyncapi":"2.6.0","info":{"title":"Order Events"},"channels":{}}'

aws ssm put-parameter \
  --name /postman/specs/order-events/format \
  --type String \
  --overwrite \
  --value asyncapi-json
```

## Example layouts

**Example repo layout** for an event-driven microservice:

```
template.yaml          # SAM template with AWS::SNS::Topic
asyncapi.yaml          # AsyncAPI contract for the main topic
events/
  order-placed/
    asyncapi.yaml      # Topic-specific contract (prioritized by path match)
  order-shipped/
    schema.json        # JSON Schema fallback
contracts/
  notifications/
    asyncapi.yaml      # Generated AsyncAPI artifact (scanned at level 3)
```

**Example output directory** after SNS resolution:

```
discovered-specs/
  order-events/
    asyncapi.yaml                    # Primary contract
    sns-resolution-metadata.json     # Metadata sidecar (always emitted)
    webhook.openapi.json             # Webhook sidecar (when HTTP/S subscriptions exist)
```

## Required IAM permissions for SNS contract discovery

- `sns:ListTopics` -- enumerate topics in the account
- `sns:GetTopicAttributes` -- read topic metadata (non-fatal if denied; topic still becomes a candidate)
- `sns:ListTagsForResource` -- read topic tags for naming and scoring (non-fatal if denied)
- `sns:ListSubscriptionsByTopic` -- enumerate subscriptions for delivery variant enrichment (non-fatal if denied; degrades to evidence only)
- `sns:GetSubscriptionAttributes` -- read subscription details including raw delivery, filter policies, and redrive policies (non-fatal if denied)

If SNS also resolves contracts from SSM, `ssm:GetParametersByPath` is additionally required. If the EventBridge-derived fallback is attempted, EventBridge Schema Registry permissions (`schemas:*`) are additionally useful.

## Edge cases

- **FIFO topics**: The `.fifo` suffix is stripped during topic naming and SSM matching but preserved in the topic ARN.
- **Path traversal protection**: Topic names are validated against the repo root before writing output files. Names that would escape the workspace are rejected.
- **Attribute/tag fetch failures**: If `sns:GetTopicAttributes` or `sns:ListTagsForResource` fails for a specific topic, the topic still becomes a candidate with empty attributes/tags.
- **Subscription fetch failures**: If `sns:ListSubscriptionsByTopic` or `sns:GetSubscriptionAttributes` is denied, the metadata sidecar is still emitted with empty subscription data. Resolution continues without variant enrichment.
- **File scan limits**: Contract file scanning uses the same limits as IaC scanning: maximum 50 files, maximum directory depth of 4.
- **Probe failure**: If the SNS probe fails, it is non-fatal in both modes. In `resolve-one`, the action falls back to `manual-review`. In `discover-many`, the SNS provider is silently skipped.
- **EventBridge-derived fallback**: Only attempted when no direct SNS contract source exists and bridge evidence is present. Transformed events are flagged as such in the metadata sidecar. Does not replace the native EventBridge provider.
- **Code-derived fallback**: Only runs after all stronger sources fail. Ambiguous candidates fall through to manual review rather than guessing. Supported frameworks: Zod, TypeBox, JSON Schema definitions, and Springwolf.
- **Dry run**: SNS respects `dry-run` -- topics are listed and contracts are resolved but no files are written to disk.

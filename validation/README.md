# AWS Spec Discovery Validation

This directory is the customer-facing validation package for the AWS spec discovery action. It documents how each discovery surface is exercised, what artifact the action emits, and whether that artifact is already OpenAPI or can be represented as a partial OpenAPI 3.x document.

The package answers four questions:

1. Which discovery surfaces are supported?
2. How can a customer reproduce the behavior?
3. What sanitized evidence proves the current implementation?
4. Does every advertised README/providers claim map to ledger, tests, and evidence?

## Directory Layout

| Directory / file | Purpose |
| --- | --- |
| `support-ledger.json` | Machine-readable support ledger (source of truth for coverage enforcement). |
| `SUPPORT_LEDGER.md` | Human-readable ledger rendered from JSON. |
| `fixtures/` | Minimal repo files and CloudFormation templates that trigger every discovery path, including `fixtures/closure/` for POS-391 resolution-closure cases. |
| `scripts/` | Reproducible validation commands for local fixture checks, closure matrices, live AWS checks, ledger enforcement, and manifest capture. |
| `runbooks/` | Step-by-step instructions for reproducing each surface. |
| `evidence/` | Sanitized summaries and coverage matrices safe to commit. Raw live identifiers stay in gitignored `*.local.json` files. |

## Coverage Matrix

See [`SUPPORT_LEDGER.md`](SUPPORT_LEDGER.md) for the enforceable per-method matrix (implementation seam, unit/fixture test, local validation case, live requirement/status, completeness, rationale, and intentional exclusions).

High-level surface index remains in `evidence/README.md`.

## Reproduce offline validation (no AWS)

Run from the action repository root after `npm run build` when scripts import `dist/`:

```bash
npm run validate:fixtures
npm run validate:support-ledger
npm run validate:resolution-closure
npm run validate:repo-spec
npm run validate:iac-signals
npm run validate:p3-surfaces
npm run validate:live-required-plan
```

Or equivalently:

```bash
node validation/scripts/check-validation-fixtures.mjs
node validation/scripts/validate-support-ledger.mjs
node validation/scripts/validate-resolution-closure.mjs
node validation/scripts/validate-repo-spec-matrix.mjs
node validation/scripts/validate-iac-signals.mjs
node validation/scripts/validate-p3-surfaces.mjs
node validation/scripts/emit-live-required-matrix.mjs
```

`validate-support-ledger.mjs` fails if advertised README/providers support lacks ledger/test/evidence mapping. `validate-resolution-closure.mjs` covers GithubOrg/GithubRepo tag fixtures, JSON Schema/Avro selection fixtures, Smithy project closure, GraphQL grouping, monorepo/Backstage ambiguity, static IaC fixtures, adversarial remote/local boundaries, provenance schema examples, and deterministic ordering/limits via fixture checks plus the named vitest suites.

## Live AWS Resources

The live validation stack is intentionally kept running for future e2e assertions. Raw identifiers are captured in:

```text
validation/evidence/live-resource-manifest.local.json
```

That file is gitignored. Commit only the sanitized evidence summary in `evidence/README.md`.

Required live cases are listed in `docs/LIVE_TESTING_RUNBOOK.md` and emitted into `evidence/README.md` under **Live Required Cases**. The complete live runner executes them and fails when required stack fixtures are missing. Its raw built-CLI receipt is gitignored at `validation/evidence/built-cli-live.local.json`; its sanitized committed summary is `validation/evidence/live-validation-summary.json`.

## Reading the Evidence

- `evidence/README.md` is the single customer-facing evidence summary.
- `SUPPORT_LEDGER.md` is the enforceable method-level matrix.
- Raw matrix details are stored only in gitignored `*.local.json` files.

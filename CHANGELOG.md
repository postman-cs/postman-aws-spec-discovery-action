# Changelog

All notable changes to this project are documented in this file.

The format follows Keep a Changelog and this project uses Semantic Versioning.

## [2.1.0] - 2026-07-17

### Added
- Ambiguous resolve-one runs now populate `candidates-json` with a deterministic, sanitized ranked candidate array and append a GitHub Step Summary (no `GITHUB_TOKEN` required, fail-soft when `GITHUB_STEP_SUMMARY` is unwritable).
- Local CDK/SAM build-artifact probe: `cdk.out/*.template.json` and `.aws-sam/build/template.yaml` are inspected for inline OpenAPI documents after direct repo specs, resolving a single embedded document as `cfn-embedded` and surfacing multi-document ambiguity as ranked candidates without guessing.
- Native REST `GetExport` results are additively enriched with existing API Gateway Models and RequestValidators: missing `components.schemas`, request media `$ref`s, root `x-amazon-apigateway-request-validators`, and operation validator names are filled without overwriting any native value; enrichment failures fall back to the untouched native export.

### Changed
- Absolute-path redaction no longer rewrites relative artifact references (for example `cdk.out/stack.template.json#LogicalId`) in sanitized output.

## [0.7.0] - 2026-05-19

### Added
- Lambda Function URL discovery via `lambda:ListFunctions`, `lambda:GetFunctionUrlConfig`, and `lambda:ListTags`, with synthesized OpenAPI 3.0 YAML output and CloudFormation/SAM, Terraform, CDK, Pulumi, and `lambda-url` hostname signal detection.

## [0.3.0] - 2026-03-23

### Added
- SDK preflight checks with optional permission probe.
- Output path confinement for repo/workspace safety.
- Bounded discovery controls (`max-candidates`, `dry-run`).
- Structured discover-many export summary output (`export-summary-json`).
- Resolution JSON schema at `schemas/resolution-json.schema.json`.
- CI and release workflow automation.

### Changed
- Binary status contract remains `resolved`/`unresolved`.
- Improved error sanitization and debug-gated diagnostics behavior.
- Simplified the public GitHub Action interface to the core repo-first inputs: `aws-region`, `gateway-id`, `stage`, and `output-dir`.
- Repositioned advanced and legacy behavior into the CLI path instead of the primary GitHub Action interface.

### Removed
- `driftStatus` from resolution payload contract.

# Changelog

All notable changes to this project are documented in this file.

The format follows Keep a Changelog and this project uses Semantic Versioning.

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

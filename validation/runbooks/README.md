# Validation Runbooks

These runbooks explain how to reproduce each discovery surface without reading implementation details. Each runbook uses the same structure:

1. Identify the fixture or live AWS resource.
2. Run the packaged action bundle, not source TypeScript.
3. Confirm the primary artifact and OpenAPI derivation status.
4. Record sanitized evidence under `validation/evidence/`.

Raw AWS identifiers, account IDs, ARNs, request IDs, and temporary paths should stay in gitignored `*.local.json` files.

## Common Commands

```bash
npm run build
node validation/scripts/check-validation-fixtures.mjs
node validation/scripts/validate-repo-spec-matrix.mjs
node validation/scripts/validate-iac-signals.mjs
node validation/scripts/capture-live-manifest.mjs --stack-name spec-discovery-validation --region us-east-1
node validation/scripts/validate-live-aws-surfaces.mjs
```

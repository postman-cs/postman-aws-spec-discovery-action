# repo-spec Validation

Surfaces: OpenAPI/Swagger, GraphQL SDL, AsyncAPI, Postman collection, protobuf, Smithy.

## Fixtures

Use `validation/fixtures/repo-spec/`.

## Reproduction

```bash
npm run build
node validation/scripts/check-validation-fixtures.mjs
node validation/scripts/validate-repo-spec-matrix.mjs
node validation/scripts/run-cli-surface.mjs --surface repo-openapi --keep-workspace true
node validation/scripts/run-cli-surface.mjs --surface repo-graphql --keep-workspace true
node validation/scripts/run-cli-surface.mjs --surface repo-asyncapi --keep-workspace true
```

`validate-repo-spec-matrix.mjs` executes all repo-spec formats through the real bundled runtime with stubbed AWS dependencies. It writes detailed local output to the gitignored `validation/evidence/repo-spec-matrix.local.json` file and refreshes the repo-spec matrix section in `validation/evidence/README.md`.

## Expected Evidence

- `resolution-status=resolved`
- `source-type=repo-spec`
- `spec-format` matches the fixture format
- OAS column records full OpenAPI 3.0/3.1 for OpenAPI sources or partial OpenAPI 3.0/3.1 for converted native API formats
- `spec-path` points at the repo fixture rather than generated AWS output

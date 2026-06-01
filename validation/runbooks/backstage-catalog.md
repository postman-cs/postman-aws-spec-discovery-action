# Backstage Catalog Validation

Surface: root or nested `catalog-info.yaml` / `catalog-info.yml` with `kind: API`.

## Fixtures

Use `validation/fixtures/backstage/catalog-info.yaml`, `validation/fixtures/backstage/catalog-info.yml`, and `validation/fixtures/iac/backstage/services/orders/catalog-info.yaml`.

## Reproduction

```bash
npm run build
node validation/scripts/validate-repo-spec-matrix.mjs
node validation/scripts/run-cli-surface.mjs --surface backstage --keep-workspace true
```

## Expected Evidence

- Local catalog definitions resolve before broader AWS discovery.
- Remote `$text` definitions are fetched when no local repo spec is present.
- Nested service/package/app catalog definitions are detected within the bounded repo scan and local relative paths are resolved from the catalog file directory.
- `source-type=repo-spec` and evidence mentions Backstage catalog.
- OAS derivation is full OpenAPI for OpenAPI catalog refs and partial OpenAPI 3.1 for GraphQL catalog refs.

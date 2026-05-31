# Backstage Catalog Validation

Surface: `catalog-info.yaml` / `catalog-info.yml` with `kind: API`.

## Fixtures

Use `validation/fixtures/backstage/catalog-info.yaml` and `validation/fixtures/backstage/catalog-info.yml`.

## Reproduction

```bash
npm run build
node validation/scripts/validate-repo-spec-matrix.mjs
node validation/scripts/run-cli-surface.mjs --surface backstage --keep-workspace true
```

## Expected Evidence

- Local catalog definitions resolve before broader AWS discovery.
- Remote `$text` definitions are fetched when no local repo spec is present.
- `source-type=repo-spec` and evidence mentions Backstage catalog.
- OAS derivation is full OpenAPI for OpenAPI catalog refs and partial OpenAPI 3.1 for GraphQL catalog refs.

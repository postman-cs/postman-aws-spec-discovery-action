# AppSync Validation

Surface: AppSync GraphQL schema export.

## Fixture

Use `validation/fixtures/aws/live-stack.yaml`.

## Expected Evidence

- Provider type: `appsync`
- Source type: `appsync-schema`
- Spec format: `graphql-sdl`
- OAS derivation: partial OpenAPI 3.1 from the exported GraphQL SDL.

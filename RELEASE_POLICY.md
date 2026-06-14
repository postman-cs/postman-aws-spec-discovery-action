# Release Policy

This repository releases the AWS spec discovery action and CLI independently from the other Postman onboarding actions.

## Source of truth

- Git tags and GitHub releases are the public release identifiers.
- `package.json` version supports npm packaging, but tags are authoritative for GitHub Action consumers.
- Bundled files in `dist/` are part of the released action artifact.

## Tag policy

- Immutable releases use `v1.x.y` tags.
- The rolling `v1` alias may move to the latest compatible `v1.x.y` release.
- Never rewrite or force-push an existing release tag.
- Keep older tags published for reproducibility.

## Release checks

Before publishing a new immutable tag:

1. Confirm `README.md` examples still match the supported action inputs and outputs.
2. Run the repository validators for the changed surface.
3. Run `npm run docs:tables` when `action.yml` changes.
4. Run `npm run check:dist` for source changes that affect the bundled action or CLI.
5. Confirm `SECURITY.md` and `SUPPORT.md` still describe the current credential and support model.
6. Push the immutable tag and verify the GitHub release.

## Compatibility

This action emits `spec-path`, `service-name`, and resolution metadata for downstream actions. Changes to output names, output types, required inputs, or resolution semantics are breaking changes and require a new major release.

Examples should prefer `@v1` for quick starts and immutable `@v1.x.y` tags for reproducible workflows. Security-sensitive environments can pin to a full commit SHA.

## Suite release order

AWS discovery can be released on its own unless a downstream onboarding example depends on a new composite or bootstrap feature. If multiple onboarding actions change together, release lower-level actions first, then update the composite action after its pinned dependencies are available.

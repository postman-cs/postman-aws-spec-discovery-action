# Contributing to postman-aws-spec-discovery-action

Thank you for your interest in contributing. This guide covers the workflow and standards for submitting changes.

## Getting Started

1. Fork and clone the repository
2. Install dependencies: `npm ci`
3. Create a feature branch: `git checkout -b my-change`

## Development Workflow

```bash
npm ci              # Install dependencies
npm test            # Run tests (vitest)
npm run typecheck   # TypeScript type checking
npm run lint        # ESLint
npm run build       # Bundle to dist/ (esbuild)
```

## Before Submitting a PR

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm run build` has been run and `dist/` is updated
- [ ] Changes are focused and address a single concern
- [ ] New functionality includes tests
- [ ] If changing SNS provider logic, signals, or runtime integration, run live integration tests: `npm run build && npm run test:live:sns`. See [docs/LIVE_TESTING_RUNBOOK.md](docs/LIVE_TESTING_RUNBOOK.md) for AWS setup.

### Rebuilding dist/

This action ships bundled JavaScript in `dist/`. After any source change, run `npm run build` and include the updated `dist/` files in your commit. CI bundles once then runs read-only `npm run verify:dist:assert`; the pre-push hook uses `npm run verify:dist` (rebuild + diff + assert).

## Release E2E Status

This repo is not directly blocked by the central live release e2e gate in Phase
1. The current `postman-actions-e2e` pipeline exercises the lower-level
`resolve-service-token`, `bootstrap`, `repo-sync`, and `smoke-flow` CLI actions;
it does not yet run AWS spec discovery as the released artifact.

Do not describe an AWS spec discovery release as live-e2e-gated until the
harness includes real AWS discovery coverage and this repo's release workflow
waits on that gate. Continue to run the live SNS integration tests when changing
SNS provider logic, signals, or runtime integration.

## Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). All commits must follow this format:

```
<type>: <description>

[optional body]

[optional footer(s)]
```

**Types:** `feat`, `fix`, `docs`, `chore`, `ci`, `refactor`, `test`, `perf`, `revert`

**Examples:**

```
feat: add retry logic to spec upload
fix: handle 429 rate limit in API client
docs: update CLI usage examples
ci: add ESLint to CI workflow
```

Commit messages are validated in CI via commitlint. Optionally install git hooks locally for faster feedback -- see [Local Git Hooks](#local-git-hooks).

## Local Git Hooks (Optional)

For commit message validation before push:

```bash
npx husky init
echo 'npx --no-install commitlint --edit "$1"' > .husky/commit-msg
```

This is optional. CI validates commit messages on every pull request regardless.

## Code Style

- TypeScript strict mode
- ESLint enforced (run `npm run lint` or `npm run lint:fix`)
- Keep changes minimal and focused
- Match existing patterns in the codebase

## Reporting Issues

Use the GitHub issue templates for bug reports and feature requests. For questions, open a Discussion thread.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

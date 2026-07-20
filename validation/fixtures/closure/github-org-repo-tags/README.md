# GithubOrg/GithubRepo tag correlation fixtures

Local/mock cases for exact repository tag correlation. Live proof requires a checked-out GithubOrg/GithubRepo-tagged service repo plus ambient AWS credentials.

## Cases

- `canonical-postman-repo`: exact `postman:repo=owner/repo` match resolves one gateway.
- `github-org-repo-split-tags`: exact `GithubOrg=owner` AND `GithubRepo=repo` match resolves one gateway.
- `multi-environment`: two exact the customer matches with distinct Environment tags remain ambiguity-safe.

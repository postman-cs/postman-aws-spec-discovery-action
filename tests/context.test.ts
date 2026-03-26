import { describe, expect, it } from 'vitest';
import { detectRepoContext, type GitProvider } from '../src/lib/repo/context.js';

function envWith(vars: Record<string, string>): NodeJS.ProcessEnv {
  return vars as NodeJS.ProcessEnv;
}

describe('detectRepoContext', () => {
  describe('provider detection from explicit input', () => {
    it.each<[string, GitProvider]>([
      ['github', 'github'],
      ['gitlab', 'gitlab'],
      ['bitbucket', 'bitbucket'],
      ['azure-devops', 'azure-devops'],
    ])('explicit provider "%s" returns %s', (input, expected) => {
      const ctx = detectRepoContext({ gitProvider: input }, envWith({}));
      expect(ctx.provider).toBe(expected);
    });
  });

  describe('provider detection from URL', () => {
    it('detects github from URL', () => {
      const ctx = detectRepoContext({ repoUrl: 'https://github.com/org/repo' }, envWith({}));
      expect(ctx.provider).toBe('github');
    });

    it('detects gitlab from URL', () => {
      const ctx = detectRepoContext({ repoUrl: 'https://gitlab.com/org/repo' }, envWith({}));
      expect(ctx.provider).toBe('gitlab');
    });

    it('detects bitbucket from URL', () => {
      const ctx = detectRepoContext({ repoUrl: 'https://bitbucket.org/workspace/repo' }, envWith({}));
      expect(ctx.provider).toBe('bitbucket');
    });

    it('detects azure-devops from dev.azure.com URL', () => {
      const ctx = detectRepoContext({ repoUrl: 'https://dev.azure.com/org/project/_git/repo' }, envWith({}));
      expect(ctx.provider).toBe('azure-devops');
    });

    it('detects azure-devops from visualstudio.com URL', () => {
      const ctx = detectRepoContext({ repoUrl: 'https://org.visualstudio.com/project/_git/repo' }, envWith({}));
      expect(ctx.provider).toBe('azure-devops');
    });
  });

  describe('provider detection from env vars', () => {
    it('detects github from GITHUB_REPOSITORY', () => {
      const ctx = detectRepoContext({}, envWith({ GITHUB_REPOSITORY: 'org/repo' }));
      expect(ctx.provider).toBe('github');
    });

    it('detects gitlab from CI_PROJECT_PATH', () => {
      const ctx = detectRepoContext({}, envWith({ CI_PROJECT_PATH: 'group/project' }));
      expect(ctx.provider).toBe('gitlab');
    });

    it('detects gitlab from GITLAB_CI', () => {
      const ctx = detectRepoContext({}, envWith({ GITLAB_CI: 'true' }));
      expect(ctx.provider).toBe('gitlab');
    });

    it('detects bitbucket from BITBUCKET_REPO_SLUG', () => {
      const ctx = detectRepoContext({}, envWith({ BITBUCKET_REPO_SLUG: 'my-repo' }));
      expect(ctx.provider).toBe('bitbucket');
    });

    it('detects azure-devops from BUILD_REPOSITORY_URI', () => {
      const ctx = detectRepoContext({}, envWith({ BUILD_REPOSITORY_URI: 'https://dev.azure.com/org/project/_git/repo' }));
      expect(ctx.provider).toBe('azure-devops');
    });

    it('returns unknown with no signals', () => {
      const ctx = detectRepoContext({}, envWith({}));
      expect(ctx.provider).toBe('unknown');
    });
  });

  describe('GitHub context', () => {
    it('resolves full context from GitHub env vars', () => {
      const ctx = detectRepoContext({}, envWith({
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'postman-cs/my-api',
        GITHUB_REF_NAME: 'main',
        GITHUB_SHA: 'abc123def456',
      }));
      expect(ctx).toEqual({
        provider: 'github',
        repoUrl: 'https://github.com/postman-cs/my-api',
        repoSlug: 'postman-cs/my-api',
        ref: 'main',
        sha: 'abc123def456',
      });
    });
  });

  describe('GitLab context', () => {
    it('resolves full context from GitLab env vars', () => {
      const ctx = detectRepoContext({}, envWith({
        CI_PROJECT_URL: 'https://gitlab.com/group/project',
        CI_PROJECT_PATH: 'group/project',
        CI_COMMIT_REF_NAME: 'develop',
        CI_COMMIT_SHA: 'deadbeef1234',
      }));
      expect(ctx).toEqual({
        provider: 'gitlab',
        repoUrl: 'https://gitlab.com/group/project',
        repoSlug: 'group/project',
        ref: 'develop',
        sha: 'deadbeef1234',
      });
    });
  });

  describe('Bitbucket context', () => {
    it('resolves full context from Bitbucket env vars', () => {
      const ctx = detectRepoContext({}, envWith({
        BITBUCKET_GIT_HTTP_ORIGIN: 'https://bitbucket.org/myworkspace/my-repo',
        BITBUCKET_WORKSPACE: 'myworkspace',
        BITBUCKET_REPO_SLUG: 'my-repo',
        BITBUCKET_BRANCH: 'feature/api',
        BITBUCKET_COMMIT: 'cafe1234babe',
      }));
      expect(ctx).toEqual({
        provider: 'bitbucket',
        repoUrl: 'https://bitbucket.org/myworkspace/my-repo',
        repoSlug: 'myworkspace/my-repo',
        ref: 'feature/api',
        sha: 'cafe1234babe',
      });
    });
  });

  describe('Azure DevOps context', () => {
    it('resolves full context from Azure DevOps env vars', () => {
      const ctx = detectRepoContext({}, envWith({
        BUILD_REPOSITORY_URI: 'https://dev.azure.com/org/project/_git/repo',
        BUILD_REPOSITORY_NAME: 'repo',
        BUILD_SOURCEBRANCHNAME: 'release/v2',
        BUILD_SOURCEVERSION: 'f00dcafe9876',
      }));
      expect(ctx).toEqual({
        provider: 'azure-devops',
        repoUrl: 'https://dev.azure.com/org/project/_git/repo',
        repoSlug: 'repo',
        ref: 'release/v2',
        sha: 'f00dcafe9876',
      });
    });
  });

  describe('explicit input overrides env vars', () => {
    it('input repoUrl takes precedence over env', () => {
      const ctx = detectRepoContext(
        { repoUrl: 'https://custom.example.com/org/repo' },
        envWith({ GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'other/repo' })
      );
      expect(ctx.repoUrl).toBe('https://custom.example.com/org/repo');
    });

    it('input ref takes precedence over env', () => {
      const ctx = detectRepoContext(
        { ref: 'custom-branch' },
        envWith({ GITHUB_REF_NAME: 'main' })
      );
      expect(ctx.ref).toBe('custom-branch');
    });

    it('input sha takes precedence over env', () => {
      const ctx = detectRepoContext(
        { sha: 'custom-sha' },
        envWith({ GITHUB_SHA: 'env-sha' })
      );
      expect(ctx.sha).toBe('custom-sha');
    });
  });

  describe('SSH URL normalization', () => {
    it('converts SSH URL to HTTPS', () => {
      const ctx = detectRepoContext({ repoUrl: 'git@github.com:org/repo.git' }, envWith({}));
      expect(ctx.repoUrl).toBe('https://github.com/org/repo');
    });

    it('strips .git suffix from HTTPS URL', () => {
      const ctx = detectRepoContext({ repoUrl: 'https://github.com/org/repo.git' }, envWith({}));
      expect(ctx.repoUrl).toBe('https://github.com/org/repo');
    });
  });

  describe('empty and whitespace handling', () => {
    it('treats empty strings as undefined', () => {
      const ctx = detectRepoContext({}, envWith({
        GITHUB_REPOSITORY: '',
        GITHUB_REF_NAME: '  ',
        GITHUB_SHA: '',
      }));
      expect(ctx.provider).toBe('unknown');
      expect(ctx.repoSlug).toBeUndefined();
      expect(ctx.ref).toBeUndefined();
      expect(ctx.sha).toBeUndefined();
    });
  });
});

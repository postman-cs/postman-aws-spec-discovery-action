import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createLocalReferenceTraversalState,
  resolveLocalReadWithinRoot,
  withLocalReferenceDepth,
  type LocalReferenceTraversalState
} from '../utils/resolve-path-within-root.js';
import { DEFAULT_IAC_BOUNDS, type IacResolutionError } from './types.js';

export interface IacReadBudget {
  files: number;
  cumulativeBytes: number;
  maxFiles: number;
  maxFileBytes: number;
  maxCumulativeBytes: number;
  maxDepth: number;
  truncated: boolean;
}

export function createIacReadBudget(overrides: Partial<IacReadBudget> = {}): IacReadBudget {
  return {
    files: 0,
    cumulativeBytes: 0,
    maxFiles: overrides.maxFiles ?? DEFAULT_IAC_BOUNDS.maxFiles,
    maxFileBytes: overrides.maxFileBytes ?? DEFAULT_IAC_BOUNDS.maxFileBytes,
    maxCumulativeBytes: overrides.maxCumulativeBytes ?? DEFAULT_IAC_BOUNDS.maxCumulativeBytes,
    maxDepth: overrides.maxDepth ?? DEFAULT_IAC_BOUNDS.maxDepth,
    truncated: false
  };
}

export function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

export function createIacTraversal(): LocalReferenceTraversalState {
  return createLocalReferenceTraversalState();
}

/**
 * Hardened bounded local read using resolveLocalReadWithinRoot.
 * Rejects escaping symlinks, cycles, oversized files, and cumulative budgets.
 */
export async function readIacFile(
  repoRoot: string,
  targetPath: string,
  budget: IacReadBudget,
  errors: IacResolutionError[],
  options: {
    fieldName?: string;
    basePath?: string;
    traversal?: LocalReferenceTraversalState;
    countAsReference?: boolean;
  } = {}
): Promise<{ content: string; relativePath: string } | undefined> {
  if (budget.files >= budget.maxFiles) {
    budget.truncated = true;
    errors.push({
      code: 'bounds-exceeded',
      path: toPosix(targetPath),
      message: `IaC scan exceeded maxFiles=${budget.maxFiles}`
    });
    return undefined;
  }

  const traversal = options.traversal;
  const limits = {
    maxDepth: budget.maxDepth,
    maxRefs: budget.maxFiles,
    maxBytesPerFile: budget.maxFileBytes,
    maxTotalBytes: budget.maxCumulativeBytes
  };

  try {
    const resolved = traversal
      ? await withLocalReferenceDepth(traversal, () =>
          resolveLocalReadWithinRoot(repoRoot, targetPath, {
            fieldName: options.fieldName ?? 'iac-path',
            basePath: options.basePath,
            traversal,
            limits,
            countAsReference: options.countAsReference
          })
        )
      : await resolveLocalReadWithinRoot(repoRoot, targetPath, {
          fieldName: options.fieldName ?? 'iac-path',
          basePath: options.basePath,
          limits,
          countAsReference: false
        });

    const content = await readFile(resolved.absolutePath, 'utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > budget.maxFileBytes) {
      errors.push({
        code: 'bounds-exceeded',
        path: toPosix(resolved.relativePath),
        message: `File exceeds maxFileBytes=${budget.maxFileBytes}`
      });
      return undefined;
    }
    if (budget.cumulativeBytes + bytes > budget.maxCumulativeBytes) {
      budget.truncated = true;
      errors.push({
        code: 'bounds-exceeded',
        path: toPosix(resolved.relativePath),
        message: `IaC scan exceeds maxCumulativeBytes=${budget.maxCumulativeBytes}`
      });
      return undefined;
    }
    budget.files += 1;
    budget.cumulativeBytes += bytes;
    return { content, relativePath: toPosix(resolved.relativePath) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const relative = toPosix(targetPath);
    if (/does not exist|dangling/i.test(message)) {
      errors.push({ code: 'missing-file', path: relative, message });
    } else if (/escap|symbolic link/i.test(message)) {
      errors.push({ code: 'path-escape', path: relative, message });
    } else if (/exceeded|limit/i.test(message)) {
      errors.push({ code: 'bounds-exceeded', path: relative, message });
    } else {
      errors.push({ code: 'unreadable', path: relative, message });
    }
    return undefined;
  }
}

export function dirnamePosix(relativePath: string): string {
  const dir = path.posix.dirname(toPosix(relativePath));
  return dir === '.' ? '' : dir;
}

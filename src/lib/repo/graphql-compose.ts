import path from 'node:path';

export interface GraphqlFileInput {
  path: string;
  content: string;
}

export interface GraphqlServiceGroup {
  serviceRoot: string;
  /** Canonical path for the composed candidate (preferred schema file or first member). */
  path: string;
  memberPaths: string[];
  content: string;
  evidence: string[];
}

/**
 * Group GraphQL SDL files by service root and concatenate member content
 * in deterministic lexical path order.
 */
export function groupGraphqlByServiceRoot(files: GraphqlFileInput[]): GraphqlServiceGroup[] {
  const byRoot = new Map<string, GraphqlFileInput[]>();
  for (const file of files) {
    const normalized = toPosix(file.path);
    const serviceRoot = serviceRootFor(normalized);
    const bucket = byRoot.get(serviceRoot) ?? [];
    bucket.push({ path: normalized, content: file.content });
    byRoot.set(serviceRoot, bucket);
  }

  const groups: GraphqlServiceGroup[] = [];
  for (const serviceRoot of [...byRoot.keys()].sort((a, b) => a.localeCompare(b))) {
    const members = (byRoot.get(serviceRoot) ?? []).sort((a, b) => a.path.localeCompare(b.path));
    if (members.length === 0) continue;
    const preferred =
      members.find((member) => {
        const base = path.posix.basename(member.path).toLowerCase();
        return base === 'schema.graphql' || base === 'schema.gql';
      }) ?? members[0];
    const memberPaths = members.map((member) => member.path);
    const content = members.map((member) => member.content.trimEnd()).join('\n\n') + '\n';
    groups.push({
      serviceRoot,
      path: preferred.path,
      memberPaths,
      content,
      evidence: [
        members.length > 1
          ? `Grouped ${members.length} GraphQL SDL files under service root ${serviceRoot}`
          : `Resolved GraphQL SDL from ${preferred.path}`,
        ...memberPaths.map((memberPath) => `Included GraphQL SDL ${memberPath}`)
      ]
    });
  }
  return groups;
}

export function serviceRootFor(relativePath: string): string {
  const normalized = toPosix(relativePath);
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length >= 2 && (parts[0] === 'packages' || parts[0] === 'services' || parts[0] === 'apps')) {
    return `${parts[0]}/${parts[1]}`;
  }
  const dirname = path.posix.dirname(normalized);
  if (dirname === '.' || dirname === '') {
    return '.';
  }
  // Prefer package-ish parents over deep schema subfolders for common layouts.
  const base = path.posix.basename(dirname);
  if (base === 'graphql' || base === 'schema' || base === 'schemas' || base === 'api' || base === 'src') {
    const parent = path.posix.dirname(dirname);
    return parent === '.' ? '.' : parent;
  }
  return dirname;
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

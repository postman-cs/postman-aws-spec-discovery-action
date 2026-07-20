import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { S3SpecClient } from '../aws/s3-client.js';
import { resolveCloudFormationTemplate } from './cloudformation.js';
import { classifyIacArtifact } from './freshness.js';
import { readIacFile, toPosix, type IacReadBudget } from './read.js';
import {
  SUPPORTED_CDK_ASSEMBLY_MAJOR_MAX,
  type IacResolutionError,
  type IacSpecCandidate
} from './types.js';

interface CdkArtifact {
  type?: string;
  properties?: {
    templateFile?: string;
    directoryName?: string;
    file?: string;
    [key: string]: unknown;
  };
  metadata?: Record<string, unknown>;
}

interface CdkManifest {
  version?: string;
  artifacts?: Record<string, CdkArtifact>;
}

function parseMajorVersion(version: string | undefined): number | undefined {
  if (!version) return undefined;
  const match = /^(\d+)\./.exec(version.trim());
  if (!match) return undefined;
  return Number(match[1]);
}

async function resolveAssemblyDirectory(
  repoRoot: string,
  assemblyDir: string,
  budget: IacReadBudget,
  errors: IacResolutionError[],
  options: {
    s3Client?: S3SpecClient;
    visitedAssemblies?: Set<string>;
    sourceHints?: string[];
  }
): Promise<IacSpecCandidate[]> {
  const visited = options.visitedAssemblies ?? new Set<string>();
  const relativeDir = toPosix(assemblyDir);
  if (visited.has(relativeDir)) return [];
  visited.add(relativeDir);

  const manifestRelative = relativeDir === '.' || relativeDir === ''
    ? 'manifest.json'
    : `${relativeDir}/manifest.json`;

  const manifestFile = await readIacFile(repoRoot, manifestRelative, budget, errors, {
    fieldName: 'cdk-manifest',
    countAsReference: false
  });

  const candidates: IacSpecCandidate[] = [];

  if (!manifestFile) {
    // Fallback: scan *.template.json directly under cdk.out (legacy layouts).
    return resolveTemplateGlob(repoRoot, relativeDir || 'cdk.out', budget, errors, options);
  }

  let manifest: CdkManifest;
  try {
    manifest = JSON.parse(manifestFile.content) as CdkManifest;
  } catch (error) {
    errors.push({
      code: 'malformed',
      path: manifestFile.relativePath,
      message: `Failed to parse CDK manifest: ${error instanceof Error ? error.message : String(error)}`
    });
    return [];
  }

  const major = parseMajorVersion(manifest.version);
  if (major === undefined || major > SUPPORTED_CDK_ASSEMBLY_MAJOR_MAX) {
    const artifactClass = await classifyIacArtifact(repoRoot, manifestFile.relativePath, options.sourceHints);
    candidates.push({
      id: `${manifestFile.relativePath}:unsupported-version`,
      source: 'cdk',
      kind: 'unresolved-evidence',
      artifactClass,
      sourcePath: manifestFile.relativePath,
      schemaVersion: manifest.version,
      evidence: [
        `Unsupported CDK cloud assembly schema version ${manifest.version ?? 'unknown'} (max major ${SUPPORTED_CDK_ASSEMBLY_MAJOR_MAX})`
      ],
      unresolvedExpression: manifest.version ?? 'missing-version'
    });
    errors.push({
      code: 'unsupported-manifest',
      path: manifestFile.relativePath,
      message: `Unsupported CDK assembly schema version ${manifest.version ?? 'unknown'}`
    });
    return candidates;
  }

  const artifacts = manifest.artifacts ?? {};
  for (const artifactId of Object.keys(artifacts).sort()) {
    const artifact = artifacts[artifactId];
    if (!artifact) continue;
    const type = artifact.type ?? '';

    if (type === 'aws:cloudformation:stack') {
      const templateFile = artifact.properties?.templateFile;
      if (typeof templateFile !== 'string' || !templateFile.trim()) {
        candidates.push({
          id: `${manifestFile.relativePath}#${artifactId}:missing-template`,
          source: 'cdk',
          kind: 'unresolved-evidence',
          artifactClass: await classifyIacArtifact(repoRoot, manifestFile.relativePath, options.sourceHints),
          sourcePath: manifestFile.relativePath,
          logicalId: artifactId,
          schemaVersion: manifest.version,
          evidence: [`CDK stack artifact ${artifactId} missing templateFile`],
          unresolvedExpression: 'missing-templateFile'
        });
        continue;
      }
      const templateRelative = relativeDir
        ? toPosix(path.posix.join(relativeDir, templateFile))
        : toPosix(templateFile);
      const stackCandidates = await resolveCloudFormationTemplate(
        repoRoot,
        templateRelative,
        budget,
        errors,
        {
          s3Client: options.s3Client,
          sourceHints: options.sourceHints ?? ['cdk.json'],
          forceSource: 'cdk'
        }
      );
      for (const candidate of stackCandidates) {
        candidate.schemaVersion = manifest.version;
        candidate.evidence = [
          ...candidate.evidence,
          `CDK assembly ${manifestFile.relativePath} artifact ${artifactId} (schema ${manifest.version})`
        ];
        candidates.push(candidate);
      }
      continue;
    }

    if (type === 'cdk:cloud-assembly' || type === 'aws:cdk:cloud-assembly') {
      const nestedDir = artifact.properties?.directoryName;
      if (typeof nestedDir !== 'string' || !nestedDir.trim()) {
        candidates.push({
          id: `${manifestFile.relativePath}#${artifactId}:nested-missing`,
          source: 'cdk',
          kind: 'unresolved-evidence',
          artifactClass: await classifyIacArtifact(repoRoot, manifestFile.relativePath, options.sourceHints),
          sourcePath: manifestFile.relativePath,
          logicalId: artifactId,
          schemaVersion: manifest.version,
          evidence: [`Nested cloud assembly ${artifactId} missing directoryName`],
          unresolvedExpression: 'missing-directoryName'
        });
        continue;
      }
      const nestedRelative = relativeDir
        ? toPosix(path.posix.join(relativeDir, nestedDir))
        : toPosix(nestedDir);
      const nested = await resolveAssemblyDirectory(repoRoot, nestedRelative, budget, errors, {
        ...options,
        visitedAssemblies: visited
      });
      for (const candidate of nested) {
        candidate.evidence = [
          ...candidate.evidence,
          `Via nested CDK assembly ${artifactId}`
        ];
        candidates.push(candidate);
      }
      continue;
    }

    if (type === 'cdk:asset' || type === 'aws:cdk:asset') {
      // Asset metadata is freshness evidence only; never invent OpenAPI from asset hashes.
      const file = artifact.properties?.file ?? artifact.properties?.path;
      if (typeof file === 'string') {
        const assetPath = relativeDir ? `${relativeDir}/${file}` : file;
        candidates.push({
          id: `${manifestFile.relativePath}#${artifactId}:asset`,
          source: 'cdk',
          kind: 'unresolved-evidence',
          artifactClass: await classifyIacArtifact(repoRoot, toPosix(assetPath), options.sourceHints),
          sourcePath: toPosix(assetPath),
          logicalId: artifactId,
          schemaVersion: manifest.version,
          evidence: [`CDK asset metadata recorded for ${artifactId} at ${assetPath}; not treated as OpenAPI`]
        });
      }
    }
  }

  return candidates;
}

async function resolveTemplateGlob(
  repoRoot: string,
  directory: string,
  budget: IacReadBudget,
  errors: IacResolutionError[],
  options: { s3Client?: S3SpecClient; sourceHints?: string[] }
): Promise<IacSpecCandidate[]> {
  const absolute = path.resolve(repoRoot, directory);
  let entries: string[];
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isDirectory()) return [];
    entries = (await readdir(absolute)).filter((name) => name.endsWith('.template.json')).sort();
  } catch {
    return [];
  }

  const candidates: IacSpecCandidate[] = [];
  for (const entry of entries) {
    const relative = toPosix(path.posix.join(directory, entry));
    const stackCandidates = await resolveCloudFormationTemplate(
      repoRoot,
      relative,
      budget,
      errors,
      {
        s3Client: options.s3Client,
        sourceHints: options.sourceHints ?? ['cdk.json'],
        forceSource: 'cdk'
      }
    );
    candidates.push(...stackCandidates);
  }
  return candidates;
}

/**
 * Follow an existing CDK cloud assembly (cdk.out/manifest.json) into supported
 * nested templates/assets. Never runs cdk synth.
 */
export async function resolveCdkAssembly(
  repoRoot: string,
  budget: IacReadBudget,
  errors: IacResolutionError[],
  options: { s3Client?: S3SpecClient } = {}
): Promise<IacSpecCandidate[]> {
  const cdkOut = path.resolve(repoRoot, 'cdk.out');
  try {
    const info = await lstat(cdkOut);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  return resolveAssemblyDirectory(repoRoot, 'cdk.out', budget, errors, {
    s3Client: options.s3Client,
    sourceHints: ['cdk.json']
  });
}

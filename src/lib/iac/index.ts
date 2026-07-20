export {
  resolveStaticIacCandidates,
  contentBearingIacCandidates
} from './resolve.js';
export {
  DEFAULT_IAC_BOUNDS,
  SUPPORTED_CDK_ASSEMBLY_MAJOR_MAX,
  API_RESOURCE_TYPES,
  type IacArtifactClass,
  type IacSourceKind,
  type IacCandidateKind,
  type IacResolutionError,
  type IacResolutionErrorCode,
  type IacSpecCandidate,
  type StaticIacResolution,
  type ResolveStaticIacOptions
} from './types.js';
export { classifyIacArtifact, toRepoArtifactClass, artifactClassRank } from './freshness.js';

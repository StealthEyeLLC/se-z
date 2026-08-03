// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
import type { OperationDefinition } from '../operations/definitions.js';

export interface SkillOperationManifest {
  operation: string;
  version: string;
  description: string;
  mutation: boolean;
  risk: 'low' | 'medium' | 'high';
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  handler: string;
}

export interface SkillManifest {
  schemaVersion: '1.0.0';
  name: string;
  version: string;
  entrypoint: string;
  sezCompatibility: string;
  operations: SkillOperationManifest[];
}

export interface PackageSetSkill {
  name: string;
  version: string;
  bundleDigest: string;
  sourceRepository: string;
  sourceCommit: string;
  sourceTree: string;
  sourcePath: string;
}

export interface PackageSetManifest {
  schemaVersion: '1.0.0';
  createdAt: string;
  baseSetDigest: string | null;
  skills: PackageSetSkill[];
  expectedCatalogDigest: string;
}

export interface BundleFile {
  path: string;
  size: number;
  sha256: string;
  mode: '100644' | '100755';
  data?: Buffer;
}

export interface SkillHandlerContext {
  skillName: string;
  skillVersion: string;
  bundleDigest: string;
  activeSetDigest: string | null;
}

export type SkillHandler = (
  input: Record<string, unknown>,
  context: SkillHandlerContext,
) => unknown | Promise<unknown>;

export interface LoadedSkill {
  manifest: SkillManifest;
  source: PackageSetSkill;
  definitions: OperationDefinition[];
}

export interface LoadedPackageSet {
  setDigest: string | null;
  setPath: string | null;
  manifest: PackageSetManifest | null;
  skills: LoadedSkill[];
  definitions: OperationDefinition[];
  handlers: Map<string, SkillHandler>;
  inputValidators: Map<string, (value: unknown) => void>;
  outputValidators: Map<string, (value: unknown) => void>;
  catalogDigest: string;
}

export interface MaterializedGitHubFile {
  path: string;
  mode: '100644' | '100755';
  size: number;
  data: Buffer;
}

export interface MaterializedGitHubSkill {
  repository: string;
  ref: string;
  commit: string;
  tree: string;
  sourcePath: string;
  sourceSubtree: string;
  files: MaterializedGitHubFile[];
  timingsMs: {
    sourceResolution: number;
    sourceMaterialization: number;
  };
}

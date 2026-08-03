// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
import {
  existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, statSync,
} from 'node:fs';
import { basename, dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, sha256Hex } from '../protocol/canonical/canonical.js';
import type { OperationDefinition } from '../operations/definitions.js';
import { compileJsonSchema, SkillValidationError } from './schema.js';
import type {
  BundleFile, LoadedPackageSet, LoadedSkill, PackageSetManifest, PackageSetSkill,
  SkillHandler, SkillManifest, SkillOperationManifest,
} from './types.js';

export const SKILL_SCHEMA_VERSION = '1.0.0';
export const PACKAGE_SET_SCHEMA_VERSION = '1.0.0';
export const MAX_SKILL_FILES = 256;
export const MAX_SKILL_BYTES = 16 * 1024 * 1024;
export const MAX_SKILL_FILE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_SKILL_ROOT = '/opt/se-z/skills';
export const SKILL_RELEASE_ROOT = join(DEFAULT_SKILL_ROOT, 'releases');
export const SKILL_SET_ROOT = join(DEFAULT_SKILL_ROOT, 'sets');
export const SKILL_CURRENT_LINK = join(DEFAULT_SKILL_ROOT, 'current');
export const SKILL_PREVIOUS_LINK = join(DEFAULT_SKILL_ROOT, 'previous');

const DIGEST = /^[a-f0-9]{64}$/;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/;
const OPERATION = /^sez\.skill\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.[a-z0-9._-]{1,128}$/;
const SAFE_REPOSITORY = /^StealthEyeLLC\/[A-Za-z0-9_.-]{1,100}$/;
const SAFE_GIT = /^[a-f0-9]{40}$/;
const MANIFEST_KEYS = ['schemaVersion', 'name', 'version', 'entrypoint', 'sezCompatibility', 'operations'] as const;
const OPERATION_KEYS = ['operation', 'version', 'description', 'mutation', 'risk', 'input', 'output', 'handler'] as const;
const SET_KEYS = ['schemaVersion', 'createdAt', 'baseSetDigest', 'skills', 'expectedCatalogDigest'] as const;
const SET_SKILL_KEYS = ['name', 'version', 'bundleDigest', 'sourceRepository', 'sourceCommit', 'sourceTree', 'sourcePath'] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new SkillValidationError(`${label} has unknown or missing fields`);
  }
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new SkillValidationError(`${label} must be a timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new SkillValidationError(`${label} must be canonical ISO-8601`);
  }
  return value;
}

export function normalizeRelativePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\0')) {
    throw new SkillValidationError(`${label} must be a bounded relative path`);
  }
  const unix = value.replaceAll('\\', '/');
  if (unix.startsWith('/') || /^[A-Za-z]:/.test(unix)) throw new SkillValidationError(`${label} must be relative`);
  const normalized = normalize(unix).replaceAll('\\', '/');
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../') || normalized !== unix) {
    throw new SkillValidationError(`${label} contains traversal or is not normalized`);
  }
  return normalized;
}

export function validateSkillManifest(value: unknown): SkillManifest {
  if (!isObject(value)) throw new SkillValidationError('skill.json must be an object');
  exactKeys(value, MANIFEST_KEYS, 'skill.json');
  if (value.schemaVersion !== SKILL_SCHEMA_VERSION) throw new SkillValidationError('unsupported skill schemaVersion');
  if (typeof value.name !== 'string' || !NAME.test(value.name)) throw new SkillValidationError('skill name is invalid');
  if (typeof value.version !== 'string' || !VERSION.test(value.version)) throw new SkillValidationError('skill version is invalid');
  const entrypoint = normalizeRelativePath(value.entrypoint, 'entrypoint');
  if (typeof value.sezCompatibility !== 'string' || !['0.1.0', '>=0.1.0 <1.0.0'].includes(value.sezCompatibility)) {
    throw new SkillValidationError('sezCompatibility is unsupported');
  }
  if (!Array.isArray(value.operations) || value.operations.length === 0 || value.operations.length > 64) {
    throw new SkillValidationError('operations must contain 1..64 declarations');
  }
  const seen = new Set<string>();
  const operations = value.operations.map((candidate, index): SkillOperationManifest => {
    if (!isObject(candidate)) throw new SkillValidationError(`operations[${index}] must be an object`);
    exactKeys(candidate, OPERATION_KEYS, `operations[${index}]`);
    if (typeof candidate.operation !== 'string' || !OPERATION.test(candidate.operation)) {
      throw new SkillValidationError(`operations[${index}].operation is invalid`);
    }
    if (!candidate.operation.startsWith(`sez.skill.${value.name}.`)) {
      throw new SkillValidationError(`operation ${candidate.operation} is outside the skill namespace`);
    }
    if (seen.has(candidate.operation)) throw new SkillValidationError(`duplicate operation ${candidate.operation}`);
    seen.add(candidate.operation);
    if (typeof candidate.version !== 'string' || !VERSION.test(candidate.version)) throw new SkillValidationError('operation version is invalid');
    if (typeof candidate.description !== 'string' || candidate.description.length < 1 || candidate.description.length > 512) {
      throw new SkillValidationError('operation description is invalid');
    }
    if (typeof candidate.mutation !== 'boolean') throw new SkillValidationError('operation mutation must be boolean');
    if (!['low', 'medium', 'high'].includes(String(candidate.risk))) throw new SkillValidationError('operation risk is invalid');
    if (typeof candidate.handler !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(candidate.handler)) {
      throw new SkillValidationError('operation handler is invalid');
    }
    compileJsonSchema(candidate.input, `${candidate.operation}.input`);
    compileJsonSchema(candidate.output, `${candidate.operation}.output`);
    return {
      operation: candidate.operation,
      version: candidate.version,
      description: candidate.description,
      mutation: candidate.mutation,
      risk: candidate.risk as 'low' | 'medium' | 'high',
      input: candidate.input as Record<string, unknown>,
      output: candidate.output as Record<string, unknown>,
      handler: candidate.handler,
    };
  });
  return {
    schemaVersion: SKILL_SCHEMA_VERSION,
    name: value.name,
    version: value.version,
    entrypoint,
    sezCompatibility: value.sezCompatibility,
    operations,
  };
}

export function validatePackageSetManifest(value: unknown): PackageSetManifest {
  if (!isObject(value)) throw new SkillValidationError('package set must be an object');
  exactKeys(value, SET_KEYS, 'package set');
  if (value.schemaVersion !== PACKAGE_SET_SCHEMA_VERSION) throw new SkillValidationError('unsupported package set schemaVersion');
  const createdAt = canonicalTimestamp(value.createdAt, 'createdAt');
  if (value.baseSetDigest !== null && (typeof value.baseSetDigest !== 'string' || !DIGEST.test(value.baseSetDigest))) {
    throw new SkillValidationError('baseSetDigest is invalid');
  }
  if (typeof value.expectedCatalogDigest !== 'string' || !DIGEST.test(value.expectedCatalogDigest)) {
    throw new SkillValidationError('expectedCatalogDigest is invalid');
  }
  if (!Array.isArray(value.skills) || value.skills.length > 64) throw new SkillValidationError('skills must be bounded');
  const names = new Set<string>();
  const skills = value.skills.map((candidate, index): PackageSetSkill => {
    if (!isObject(candidate)) throw new SkillValidationError(`skills[${index}] must be an object`);
    exactKeys(candidate, SET_SKILL_KEYS, `skills[${index}]`);
    if (typeof candidate.name !== 'string' || !NAME.test(candidate.name) || names.has(candidate.name)) throw new SkillValidationError('set skill name is invalid or duplicate');
    names.add(candidate.name);
    if (typeof candidate.version !== 'string' || !VERSION.test(candidate.version)) throw new SkillValidationError('set skill version is invalid');
    if (typeof candidate.bundleDigest !== 'string' || !DIGEST.test(candidate.bundleDigest)) throw new SkillValidationError('bundleDigest is invalid');
    if (typeof candidate.sourceRepository !== 'string' || !SAFE_REPOSITORY.test(candidate.sourceRepository)) throw new SkillValidationError('sourceRepository is invalid');
    if (typeof candidate.sourceCommit !== 'string' || !SAFE_GIT.test(candidate.sourceCommit)) throw new SkillValidationError('sourceCommit is invalid');
    if (typeof candidate.sourceTree !== 'string' || !SAFE_GIT.test(candidate.sourceTree)) throw new SkillValidationError('sourceTree is invalid');
    return {
      name: candidate.name,
      version: candidate.version,
      bundleDigest: candidate.bundleDigest,
      sourceRepository: candidate.sourceRepository,
      sourceCommit: candidate.sourceCommit,
      sourceTree: candidate.sourceTree,
      sourcePath: normalizeRelativePath(candidate.sourcePath, 'sourcePath'),
    };
  });
  return {
    schemaVersion: PACKAGE_SET_SCHEMA_VERSION,
    createdAt,
    baseSetDigest: value.baseSetDigest as string | null,
    skills,
    expectedCatalogDigest: value.expectedCatalogDigest,
  };
}

function walk(root: string, current: string, result: BundleFile[]): void {
  const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = join(current, entry.name);
    const info = lstatSync(full);
    if (info.isSymbolicLink()) throw new SkillValidationError(`symlink rejected: ${relative(root, full)}`);
    if (info.isDirectory()) {
      walk(root, full, result);
      continue;
    }
    if (!info.isFile()) throw new SkillValidationError(`non-regular file rejected: ${relative(root, full)}`);
    if (info.size > MAX_SKILL_FILE_BYTES) throw new SkillValidationError(`file exceeds 4 MiB: ${relative(root, full)}`);
    const rel = normalizeRelativePath(relative(root, full).split(sep).join('/'), 'bundle file');
    const data = readFileSync(full);
    result.push({
      path: rel,
      size: data.length,
      sha256: sha256Hex(data),
      mode: (info.mode & 0o111) === 0 ? '100644' : '100755',
    });
    if (result.length > MAX_SKILL_FILES) throw new SkillValidationError('bundle exceeds 256 files');
    if (result.reduce((total, file) => total + file.size, 0) > MAX_SKILL_BYTES) throw new SkillValidationError('bundle exceeds 16 MiB');
  }
}

export function describeBundleDirectory(root: string): BundleFile[] {
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new SkillValidationError('bundle root must be a real directory');
  const result: BundleFile[] = [];
  walk(root, root, result);
  const paths = new Set<string>();
  for (const file of result) {
    if (paths.has(file.path)) throw new SkillValidationError(`duplicate normalized path ${file.path}`);
    paths.add(file.path);
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

export function bundleDigest(files: readonly BundleFile[]): string {
  const descriptor = files.map(({ path, size, sha256, mode }) => ({ path, size, sha256, mode }));
  return sha256Hex(canonicalJson(descriptor));
}

export function verifyBundleDirectory(root: string, expectedDigest: string): BundleFile[] {
  const files = describeBundleDirectory(root);
  const observed = bundleDigest(files);
  if (observed !== expectedDigest) throw new SkillValidationError(`bundle digest mismatch: expected ${expectedDigest}, observed ${observed}`);
  return files;
}

export function catalogDigest(definitions: readonly OperationDefinition[]): string {
  return sha256Hex(canonicalJson(definitions.map((definition) => ({
    operation: definition.operation,
    version: definition.version,
    description: definition.description,
    mutation: definition.mutation,
    risk: definition.risk,
    input: definition.input,
    output: definition.output ?? { type: 'object', additionalProperties: false, properties: {} },
  }))));
}

export function packageSetDigest(manifest: PackageSetManifest): string {
  return sha256Hex(canonicalJson(manifest));
}

function contained(root: string, path: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}

export async function loadPackageSetFromPath(
  setPath: string | null,
  coreDefinitions: readonly OperationDefinition[],
  releaseRoot = SKILL_RELEASE_ROOT,
): Promise<LoadedPackageSet> {
  if (setPath === null) {
    return {
      setDigest: null, setPath: null, manifest: null, skills: [], definitions: [],
      handlers: new Map(), inputValidators: new Map(), outputValidators: new Map(),
      catalogDigest: catalogDigest(coreDefinitions),
    };
  }
  const setName = basename(setPath);
  const match = /^([a-f0-9]{64})\.json$/.exec(setName);
  if (!match) throw new SkillValidationError('package set filename is not content-addressed');
  const raw = readFileSync(setPath, 'utf8');
  const parsed = validatePackageSetManifest(JSON.parse(raw));
  const observedSetDigest = packageSetDigest(parsed);
  if (observedSetDigest !== match[1]) throw new SkillValidationError('package set digest does not match filename');
  const coreNames = new Set(coreDefinitions.map((definition) => definition.operation));
  const operationNames = new Set<string>();
  const handlers = new Map<string, SkillHandler>();
  const inputValidators = new Map<string, (value: unknown) => void>();
  const outputValidators = new Map<string, (value: unknown) => void>();
  const definitions: OperationDefinition[] = [];
  const skills: LoadedSkill[] = [];
  for (const source of parsed.skills) {
    const bundleRoot = join(releaseRoot, source.bundleDigest);
    if (!contained(releaseRoot, bundleRoot) || !existsSync(bundleRoot)) throw new SkillValidationError(`bundle missing: ${source.bundleDigest}`);
    const files = verifyBundleDirectory(bundleRoot, source.bundleDigest);
    const fileNames = new Set(files.map((file) => file.path));
    if (!fileNames.has('skill.json')) throw new SkillValidationError(`bundle ${source.bundleDigest} has no skill.json`);
    const manifest = validateSkillManifest(JSON.parse(readFileSync(join(bundleRoot, 'skill.json'), 'utf8')));
    if (manifest.name !== source.name || manifest.version !== source.version) throw new SkillValidationError('package set and skill manifest identity mismatch');
    if (!fileNames.has(manifest.entrypoint)) throw new SkillValidationError(`entrypoint missing: ${manifest.entrypoint}`);
    const entrypoint = join(bundleRoot, manifest.entrypoint);
    if (!contained(bundleRoot, entrypoint) || !statSync(entrypoint).isFile()) throw new SkillValidationError('entrypoint is not a regular contained file');
    const imported = await import(`${pathToFileURL(entrypoint).href}?bundle=${source.bundleDigest}`) as Record<string, unknown>;
    const declaredExports = [...new Set(manifest.operations.map((operation) => operation.handler))].sort();
    const actualExports = Object.keys(imported).sort();
    if (actualExports.length !== declaredExports.length || actualExports.some((name, index) => name !== declaredExports[index])) {
      throw new SkillValidationError(`entrypoint exports do not exactly match declared handlers for ${manifest.name}`);
    }
    const skillDefinitions: OperationDefinition[] = [];
    for (const operation of manifest.operations) {
      if (coreNames.has(operation.operation)) throw new SkillValidationError(`skill operation collides with core: ${operation.operation}`);
      if (operationNames.has(operation.operation)) throw new SkillValidationError(`duplicate skill operation: ${operation.operation}`);
      operationNames.add(operation.operation);
      const handler = imported[operation.handler];
      if (typeof handler !== 'function') throw new SkillValidationError(`handler missing: ${operation.handler}`);
      handlers.set(operation.operation, handler as SkillHandler);
      inputValidators.set(operation.operation, compileJsonSchema(operation.input, `${operation.operation}.input`));
      outputValidators.set(operation.operation, compileJsonSchema(operation.output, `${operation.operation}.output`));
      const definition: OperationDefinition = {
        operation: operation.operation,
        family: 'skill',
        version: operation.version,
        description: operation.description,
        mutation: operation.mutation,
        idempotency: operation.mutation ? 'caller_key' : 'read_only',
        risk: operation.risk,
        input: operation.input,
        output: operation.output,
        errors: ['invalid_request', 'operation_failed'],
        cancellation: operation.mutation ? 'pre_arm_cleanup_post_arm_rollback' : 'not_applicable',
        restartBehavior: operation.mutation ? 'durable_reconcile' : 'read_only',
        postActionVerification: true,
      };
      definitions.push(definition);
      skillDefinitions.push(definition);
    }
    skills.push({ manifest, source, definitions: skillDefinitions });
  }
  const observedCatalogDigest = catalogDigest([...coreDefinitions, ...definitions]);
  if (parsed.expectedCatalogDigest !== observedCatalogDigest) throw new SkillValidationError('package set expectedCatalogDigest mismatch');
  return {
    setDigest: match[1], setPath, manifest: parsed, skills, definitions, handlers,
    inputValidators, outputValidators, catalogDigest: observedCatalogDigest,
  };
}

export async function loadActivePackageSet(
  coreDefinitions: readonly OperationDefinition[],
  currentLink = SKILL_CURRENT_LINK,
  releaseRoot = SKILL_RELEASE_ROOT,
): Promise<LoadedPackageSet> {
  if (!existsSync(currentLink)) return loadPackageSetFromPath(null, coreDefinitions, releaseRoot);
  const info = lstatSync(currentLink);
  if (!info.isSymbolicLink()) throw new SkillValidationError('skills/current must be a symlink');
  const target = resolve(dirname(currentLink), readlinkSync(currentLink));
  const setRoot = join(dirname(releaseRoot), 'sets');
  if (!contained(setRoot, target)) throw new SkillValidationError('skills/current target escapes package-set root');
  return loadPackageSetFromPath(target, coreDefinitions, releaseRoot);
}

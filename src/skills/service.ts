// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
import { randomUUID } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync,
  readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { RuntimeConfig } from '../supervisor/configuration/config.js';
import { canonicalJson, sha256Hex } from '../protocol/canonical/canonical.js';
import { GitHubAppAuthority } from '../github/app-authority.js';
import type { GitHubSkillMaterialization } from '../github/app-authority.js';
import type { OperationDefinition } from '../operations/definitions.js';
import { readReleaseIdentity } from '../operations/definitions.js';
import { OperationError } from '../operations/errors.js';
import {
  bundleDigest, catalogDigest, describeBundleDirectory,
  packageSetDigest, SKILL_CURRENT_LINK, SKILL_PREVIOUS_LINK, SKILL_RELEASE_ROOT,
  SKILL_SET_ROOT, validateSkillManifest,
} from './loader.js';
import type { LoadedPackageSet, PackageSetManifest, PackageSetSkill, SkillManifest } from './types.js';

export const SKILL_DEPLOYMENT_ROOT = '/var/lib/se-z/skill-deployments';
export const SKILL_STAGING_ROOT = '/var/lib/se-z/skill-staging';
const DIGEST = /^[a-f0-9]{64}$/;
const REPOSITORY = /^StealthEyeLLC\/[A-Za-z0-9_.-]{1,100}$/;
const COMMIT = /^[a-f0-9]{40}$/;

export interface SkillServicePaths {
  deploymentRoot: string;
  stagingRoot: string;
  releaseRoot: string;
  setRoot: string;
  currentLink: string;
  previousLink: string;
}


export interface SkillServiceDependencies {
  githubAuthority?: { materializeSkill: (
    repository: unknown,
    ref: unknown,
    skillPath: unknown,
    expectedCommit?: unknown,
  ) => Promise<GitHubSkillMaterialization> };
  scheduleActivation?: (recordPath: string, deploymentId: string) => void;
}

interface DeploymentRecord {
  schemaVersion: '1.0.0';
  deploymentId: string;
  action: 'deploy' | 'rollback';
  idempotencyKeyDigest: string;
  requestDigest?: string;
  request: Record<string, unknown>;
  source: { repository: string; ref: string; path: string; commit: string; tree: string } | null;
  priorActiveSetDigest: string | null;
  priorActiveSetPath: string | null;
  priorPreviousSetPath: string | null;
  candidateSetDigest: string;
  candidateSetPath: string;
  bundleDigest: string | null;
  expectedCatalogDigest: string;
  expectedSkillOperations: string[];
  expectedCoreOperations: string[];
  removedSkillOperations: string[];
  smokeOperation: string | null;
  smokePayload: Record<string, unknown> | null;
  lifecycleState: string;
  timestamps: Record<string, string>;
  timingsMs: Record<string, number>;
  restartStatus: string;
  healthReadback: unknown;
  describeReadback: unknown;
  smokeResult: unknown;
  rollbackStatus: string;
  finalState: string | null;
  redactedError: string | null;
  bundleReused: boolean;
  setReused: boolean;
}

function now(): string { return new Date().toISOString(); }
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new OperationError('invalid_request', message, false, details);
}
function atomicWriteJson(path: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${canonicalJson(value)}\n`, { mode, flag: 'wx' });
  renameSync(temporary, path);
}
function atomicSymlink(link: string, target: string): void {
  mkdirSync(dirname(link), { recursive: true, mode: 0o755 });
  const temporary = `${link}.tmp-${process.pid}-${randomUUID()}`;
  symlinkSync(target, temporary);
  renameSync(temporary, link);
}
function linkTarget(link: string): string | null {
  if (!existsSync(link)) return null;
  if (!lstatSync(link).isSymbolicLink()) throw new Error(`${link} must be a symlink`);
  return resolve(dirname(link), readlinkSync(link));
}
function digestFromSetPath(path: string | null): string | null {
  if (path === null) return null;
  const match = /\/([a-f0-9]{64})\.json$/.exec(path);
  if (!match) throw new Error(`invalid package-set target: ${path}`);
  return match[1];
}
function redact(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.replace(/gh[opusr]_[A-Za-z0-9_]+/g, '[REDACTED]').slice(0, 1000);
}
function makeBundleImmutable(root: string): void {
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
    }
    chmodSync(directory, 0o555);
  };
  visit(root);
}

function definitionsForManifest(manifest: SkillManifest): OperationDefinition[] {
  return manifest.operations.map((operation) => ({
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
  }));
}

function cliInvocation(name: 'preload-cli' | 'activate-cli'): string[] {
  const javascript = fileURLToPath(new URL(`./${name}.js`, import.meta.url));
  if (existsSync(javascript)) return [process.execPath, javascript];
  const typescript = fileURLToPath(new URL(`./${name}.ts`, import.meta.url));
  return [process.execPath, '--import', 'tsx', typescript];
}

export class SkillDeploymentService {
  private readonly paths: SkillServicePaths;
  private github?: SkillServiceDependencies['githubAuthority'];
  private readonly scheduleActivationOverride?: SkillServiceDependencies['scheduleActivation'];

  constructor(
    _config: RuntimeConfig,
    private readonly coreDefinitions: readonly OperationDefinition[],
    private readonly loaded: () => LoadedPackageSet,
    overrides: Partial<SkillServicePaths> = {},
    dependencies: SkillServiceDependencies = {},
  ) {
    this.github = dependencies.githubAuthority;
    this.scheduleActivationOverride = dependencies.scheduleActivation;
    this.paths = {
      deploymentRoot: overrides.deploymentRoot ?? SKILL_DEPLOYMENT_ROOT,
      stagingRoot: overrides.stagingRoot ?? SKILL_STAGING_ROOT,
      releaseRoot: overrides.releaseRoot ?? SKILL_RELEASE_ROOT,
      setRoot: overrides.setRoot ?? SKILL_SET_ROOT,
      currentLink: overrides.currentLink ?? SKILL_CURRENT_LINK,
      previousLink: overrides.previousLink ?? SKILL_PREVIOUS_LINK,
    };
  }

  static handles(operation: string): boolean {
    return ['sez.skill.deploy', 'sez.skill.status', 'sez.skill.rollback', 'sez.skill.list'].includes(operation);
  }

  ensureInitialSet(): string {
    mkdirSync(this.paths.releaseRoot, { recursive: true, mode: 0o755 });
    mkdirSync(this.paths.setRoot, { recursive: true, mode: 0o755 });
    mkdirSync(this.paths.deploymentRoot, { recursive: true, mode: 0o700 });
    mkdirSync(this.paths.stagingRoot, { recursive: true, mode: 0o700 });
    const existing = linkTarget(this.paths.currentLink);
    if (existing !== null) return digestFromSetPath(existing)!;
    const manifest: PackageSetManifest = {
      schemaVersion: '1.0.0',
      createdAt: '1970-01-01T00:00:00.000Z',
      baseSetDigest: null,
      skills: [],
      expectedCatalogDigest: catalogDigest(this.coreDefinitions),
    };
    const digest = packageSetDigest(manifest);
    const path = join(this.paths.setRoot, `${digest}.json`);
    if (!existsSync(path)) {
      atomicWriteJson(path, manifest, 0o444);
      chmodSync(path, 0o444);
    }
    atomicSymlink(this.paths.currentLink, path);
    return digest;
  }

  async execute(operation: string, idempotencyIdentity: string, body: Record<string, unknown>): Promise<unknown> {
    switch (operation) {
      case 'sez.skill.deploy': return this.deploy(idempotencyIdentity, body);
      case 'sez.skill.status': return this.status();
      case 'sez.skill.rollback': return this.rollback(idempotencyIdentity, body);
      case 'sez.skill.list': return this.list();
      default: throw new Error(`unsupported skill operation ${operation}`);
    }
  }

  private findIdempotentRecord(idempotencyIdentity: string, requestDigest: string): DeploymentRecord | null {
    const keyDigest = sha256Hex(idempotencyIdentity);
    if (!existsSync(this.paths.deploymentRoot)) return null;
    for (const name of readdirSync(this.paths.deploymentRoot).sort()) {
      const recordPath = join(this.paths.deploymentRoot, name, 'record.json');
      if (!existsSync(recordPath)) continue;
      const record = JSON.parse(readFileSync(recordPath, 'utf8')) as DeploymentRecord;
      if (record.idempotencyKeyDigest !== keyDigest) continue;
      if (record.requestDigest !== requestDigest) {
        throw new OperationError('deployment_conflict', 'idempotency key conflicts with another skill request', false, {
          deploymentId: record.deploymentId,
        });
      }
      return record;
    }
    return null;
  }

  private async deploy(idempotencyIdentity: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const repository = String(body.repository ?? '');
    const ref = String(body.ref ?? '');
    const skillPath = String(body.skillPath ?? '');
    if (!REPOSITORY.test(repository)) fail('repository must be StealthEyeLLC/<repo>');
    if (!ref || ref.length > 255) fail('ref is required');
    if (!skillPath || skillPath.length > 512) fail('skillPath is required');
    if (body.expectedCommit !== undefined && !COMMIT.test(String(body.expectedCommit))) fail('expectedCommit is invalid');
    if (body.expectedCurrentSetDigest !== undefined && !DIGEST.test(String(body.expectedCurrentSetDigest))) fail('expectedCurrentSetDigest is invalid');
    if (body.smokeOperation !== undefined && typeof body.smokeOperation !== 'string') fail('smokeOperation must be a string');
    if (body.smokePayload !== undefined && !isObject(body.smokePayload)) fail('smokePayload must be an object');

    const requestDigest = sha256Hex(canonicalJson({
      action: 'deploy',
      repository,
      ref,
      skillPath,
      expectedCommit: body.expectedCommit ?? null,
      expectedCurrentSetDigest: body.expectedCurrentSetDigest ?? null,
      smokeOperation: body.smokeOperation ?? null,
      smokePayload: body.smokePayload ?? null,
    }));
    const replay = this.findIdempotentRecord(idempotencyIdentity, requestDigest);
    if (replay !== null) return this.publicRecord(replay);

    const priorPath = linkTarget(this.paths.currentLink);
    const priorDigest = digestFromSetPath(priorPath);
    if (body.expectedCurrentSetDigest !== undefined && body.expectedCurrentSetDigest !== priorDigest) {
      throw new OperationError('deployment_conflict', 'current package-set compare-and-swap mismatch', false, {
        expected: body.expectedCurrentSetDigest, observed: priorDigest,
      });
    }
    const deploymentId = randomUUID();
    const deploymentDirectory = join(this.paths.deploymentRoot, deploymentId);
    const recordPath = join(deploymentDirectory, 'record.json');
    const staging = join(this.paths.stagingRoot, deploymentId);
    mkdirSync(staging, { recursive: false, mode: 0o700 });
    const record: DeploymentRecord = {
      schemaVersion: '1.0.0', deploymentId, action: 'deploy',
      idempotencyKeyDigest: sha256Hex(idempotencyIdentity), requestDigest,
      request: { repository, ref, skillPath },
      source: null, priorActiveSetDigest: priorDigest, priorActiveSetPath: priorPath,
      priorPreviousSetPath: linkTarget(this.paths.previousLink), candidateSetDigest: '', candidateSetPath: '',
      bundleDigest: null, expectedCatalogDigest: '', expectedSkillOperations: [],
      expectedCoreOperations: this.coreDefinitions.map((item) => item.operation), removedSkillOperations: [],
      smokeOperation: body.smokeOperation === undefined ? null : String(body.smokeOperation),
      smokePayload: body.smokePayload === undefined ? null : body.smokePayload as Record<string, unknown>,
      lifecycleState: 'REQUESTED', timestamps: { requestedAt: now() }, timingsMs: {},
      restartStatus: 'not_started', healthReadback: null, describeReadback: null, smokeResult: null,
      rollbackStatus: 'not_started', finalState: null, redactedError: null,
      bundleReused: false, setReused: false,
    };
    atomicWriteJson(recordPath, record);
    try {
      record.lifecycleState = 'MATERIALIZING'; record.timestamps.materializingAt = now(); atomicWriteJson(recordPath, record);
      this.github ??= new GitHubAppAuthority();
      const materialized = await this.github.materializeSkill(repository, ref, skillPath, body.expectedCommit);
      record.source = { repository, ref, path: skillPath, commit: materialized.commit, tree: materialized.tree };
      Object.assign(record.timingsMs, materialized.timingsMs);
      const hashStarted = Date.now();
      for (const file of materialized.files) {
        const destination = join(staging, file.path);
        const root = resolve(staging);
        const resolvedDestination = resolve(destination);
        if (!resolvedDestination.startsWith(`${root}/`)) throw new Error(`materialized path escapes staging: ${file.path}`);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
        writeFileSync(destination, file.data, { mode: file.mode === '100755' ? 0o755 : 0o644, flag: 'wx' });
      }
      const files = describeBundleDirectory(staging);
      const observedBundleDigest = bundleDigest(files);
      record.bundleDigest = observedBundleDigest;
      record.timingsMs.bundleHashing = Date.now() - hashStarted;
      const manifest = validateSkillManifest(JSON.parse(readFileSync(join(staging, 'skill.json'), 'utf8')));
      const entrypoint = join(staging, manifest.entrypoint);
      if (!existsSync(entrypoint) || !statSync(entrypoint).isFile()) throw new Error('declared entrypoint is missing');
      const bundlePath = join(this.paths.releaseRoot, observedBundleDigest);
      if (existsSync(bundlePath)) {
        const existingDigest = bundleDigest(describeBundleDirectory(bundlePath));
        if (existingDigest !== observedBundleDigest) throw new Error('existing bundle failed digest verification');
        record.bundleReused = true;
        rmSync(staging, { recursive: true, force: true });
      } else {
        renameSync(staging, bundlePath);
        for (const file of describeBundleDirectory(bundlePath)) {
          chmodSync(join(bundlePath, file.path), file.mode === '100755' ? 0o555 : 0o444);
        }
        makeBundleImmutable(bundlePath);
      }
      const sourceEntry: PackageSetSkill = {
        name: manifest.name, version: manifest.version, bundleDigest: observedBundleDigest,
        sourceRepository: repository, sourceCommit: materialized.commit, sourceTree: materialized.tree,
        sourcePath: skillPath,
      };
      const currentSkills = this.loaded().manifest?.skills ?? [];
      const candidateSkills = [...currentSkills.filter((item) => item.name !== manifest.name), sourceEntry]
        .sort((a, b) => a.name.localeCompare(b.name));
      const manifestDefinitions = definitionsForManifest(manifest);
      const retainedDefinitions = this.loaded().definitions.filter((definition) => !definition.operation.startsWith(`sez.skill.${manifest.name}.`));
      const expectedCatalogDigest = catalogDigest([...this.coreDefinitions, ...retainedDefinitions, ...manifestDefinitions]);
      const candidate: PackageSetManifest = {
        schemaVersion: '1.0.0', createdAt: now(), baseSetDigest: priorDigest,
        skills: candidateSkills, expectedCatalogDigest,
      };
      const candidateDigest = packageSetDigest(candidate);
      const candidatePath = join(this.paths.setRoot, `${candidateDigest}.json`);
      if (existsSync(candidatePath)) record.setReused = true;
      else { atomicWriteJson(candidatePath, candidate, 0o444); chmodSync(candidatePath, 0o444); }
      record.candidateSetDigest = candidateDigest; record.candidateSetPath = candidatePath;
      record.expectedCatalogDigest = expectedCatalogDigest;
      record.expectedSkillOperations = manifestDefinitions.map((item) => item.operation);
      record.lifecycleState = 'VALIDATING'; record.timestamps.validatingAt = now(); atomicWriteJson(recordPath, record);
      const preloadStarted = Date.now();
      const preload = spawnSync(cliInvocation('preload-cli')[0]!, [
        ...cliInvocation('preload-cli').slice(1), candidatePath, this.paths.releaseRoot,
      ], {
        encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
      });
      record.timingsMs.candidatePreload = Date.now() - preloadStarted;
      if (preload.status !== 0) throw new Error(`candidate preload failed: ${preload.stderr.trim().slice(0, 1000)}`);
      const preloadResult = JSON.parse(preload.stdout) as { catalogDigest?: string };
      if (preloadResult.catalogDigest !== expectedCatalogDigest) throw new Error('candidate preload catalog digest mismatch');
      record.lifecycleState = 'READY'; record.timestamps.readyAt = now(); atomicWriteJson(recordPath, record);
      record.lifecycleState = 'ACTIVATING'; record.timestamps.activatingAt = now(); atomicWriteJson(recordPath, record);
      this.scheduleActivation(recordPath, deploymentId);
      return this.publicRecord(record);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      record.lifecycleState = 'FAILED'; record.finalState = 'FAILED'; record.redactedError = redact(error);
      record.timestamps.failedAt = now(); atomicWriteJson(recordPath, record);
      throw new OperationError('operation_failed', record.redactedError, false, { deploymentId });
    }
  }

  private rollback(idempotencyIdentity: string, body: Record<string, unknown>): Record<string, unknown> {
    if (body.expectedCurrentSetDigest !== undefined && !DIGEST.test(String(body.expectedCurrentSetDigest))) fail('expectedCurrentSetDigest is invalid');
    if (typeof body.reason !== 'string' || body.reason.length < 1 || body.reason.length > 512) fail('reason is required');
    const requestDigest = sha256Hex(canonicalJson({
      action: 'rollback',
      expectedCurrentSetDigest: body.expectedCurrentSetDigest ?? null,
      reason: body.reason,
    }));
    const replay = this.findIdempotentRecord(idempotencyIdentity, requestDigest);
    if (replay !== null) return this.publicRecord(replay);
    const currentPath = linkTarget(this.paths.currentLink);
    const previousPath = linkTarget(this.paths.previousLink);
    if (currentPath === null || previousPath === null) throw new OperationError('resource_unavailable', 'previous package-set pointer is unavailable', false);
    const currentDigest = digestFromSetPath(currentPath)!;
    if (body.expectedCurrentSetDigest !== undefined && body.expectedCurrentSetDigest !== currentDigest) {
      throw new OperationError('deployment_conflict', 'current package-set compare-and-swap mismatch', false);
    }
    const candidate = JSON.parse(readFileSync(previousPath, 'utf8')) as PackageSetManifest;
    const preload = spawnSync(cliInvocation('preload-cli')[0]!, [
      ...cliInvocation('preload-cli').slice(1), previousPath, this.paths.releaseRoot,
    ], {
      encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
    });
    if (preload.status !== 0) throw new OperationError('deployment_integrity_failed', 'previous package set failed preload', false);
    const candidateDigest = digestFromSetPath(previousPath)!;
    const candidateLoadedOperations = candidate.skills.flatMap((skill) => {
      const manifest = validateSkillManifest(JSON.parse(readFileSync(join(this.paths.releaseRoot, skill.bundleDigest, 'skill.json'), 'utf8')));
      return manifest.operations.map((item) => item.operation);
    });
    const currentOperations = this.loaded().definitions.map((item) => item.operation);
    const deploymentId = randomUUID();
    const record: DeploymentRecord = {
      schemaVersion: '1.0.0', deploymentId, action: 'rollback',
      idempotencyKeyDigest: sha256Hex(idempotencyIdentity), requestDigest,
      request: { reason: body.reason }, source: null,
      priorActiveSetDigest: currentDigest, priorActiveSetPath: currentPath, priorPreviousSetPath: previousPath,
      candidateSetDigest: candidateDigest, candidateSetPath: previousPath, bundleDigest: null,
      expectedCatalogDigest: candidate.expectedCatalogDigest,
      expectedSkillOperations: candidateLoadedOperations,
      expectedCoreOperations: this.coreDefinitions.map((item) => item.operation),
      removedSkillOperations: currentOperations.filter((item) => !candidateLoadedOperations.includes(item)),
      smokeOperation: null, smokePayload: null, lifecycleState: 'READY', timestamps: { requestedAt: now(), readyAt: now() },
      timingsMs: {}, restartStatus: 'not_started', healthReadback: null, describeReadback: null,
      smokeResult: null, rollbackStatus: 'requested', finalState: null, redactedError: null,
      bundleReused: true, setReused: true,
    };
    const recordPath = join(this.paths.deploymentRoot, deploymentId, 'record.json');
    atomicWriteJson(recordPath, record);
    record.lifecycleState = 'ACTIVATING'; record.timestamps.activatingAt = now(); atomicWriteJson(recordPath, record);
    try {
      this.scheduleActivation(recordPath, deploymentId);
    } catch (error) {
      record.lifecycleState = 'FAILED'; record.finalState = 'FAILED'; record.redactedError = redact(error);
      record.timestamps.failedAt = now(); atomicWriteJson(recordPath, record);
      throw new OperationError('operation_failed', record.redactedError, false, { deploymentId });
    }
    return this.publicRecord(record);
  }

  private scheduleActivation(recordPath: string, deploymentId: string): void {
    if (this.scheduleActivationOverride !== undefined) {
      this.scheduleActivationOverride(recordPath, deploymentId);
      return;
    }
    const invocation = cliInvocation('activate-cli');
    const unit = `sez-skill-activate-${deploymentId.replaceAll('-', '')}`;
    const scheduled = spawnSync('/usr/bin/systemd-run', [
      '--unit', unit, '--collect', '--quiet', '--no-block', '--property=Type=oneshot',
      ...invocation, recordPath,
    ], { encoding: 'utf8', timeout: 10_000 });
    if (scheduled.status !== 0) {
      const diagnostic = [
        scheduled.error?.message,
        scheduled.stderr.trim(),
        scheduled.stdout.trim(),
        scheduled.signal === null ? undefined : `signal=${scheduled.signal}`,
        scheduled.status === null ? 'status=null' : `status=${scheduled.status}`,
      ].filter((value): value is string => value !== undefined && value.length > 0).join('; ');
      throw new Error(`failed to schedule durable activation: ${diagnostic || 'unknown systemd-run failure'}`);
    }
  }

  private status(): Record<string, unknown> {
    const active = this.loaded();
    const previousPath = linkTarget(this.paths.previousLink);
    const last = this.lastRecord();
    return {
      activeSetDigest: active.setDigest,
      previousSetDigest: digestFromSetPath(previousPath),
      activeSkills: active.skills.map((skill) => ({ ...skill.source })),
      currentCatalogDigest: active.catalogDigest,
      currentCoreOperationCount: this.coreDefinitions.length,
      currentSkillOperationCount: active.definitions.length,
      lastDeploymentRecord: last === null ? null : this.publicRecord(last),
      currentHealth: { status: 'healthy', product: 'se-z' },
      release: readReleaseIdentity(),
    };
  }

  private list(): Record<string, unknown> {
    const active = this.loaded().setDigest;
    const previous = digestFromSetPath(linkTarget(this.paths.previousLink));
    const sets = readdirSync(this.paths.setRoot).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort().slice(-200).map((name) => {
      const digest = name.slice(0, 64);
      const manifest = JSON.parse(readFileSync(join(this.paths.setRoot, name), 'utf8')) as PackageSetManifest;
      return { digest, skills: manifest.skills, active: digest === active, previous: digest === previous };
    });
    const sourceByBundle = new Map<string, PackageSetSkill>();
    for (const set of sets) for (const skill of set.skills) sourceByBundle.set(skill.bundleDigest, skill);
    const bundles = readdirSync(this.paths.releaseRoot).filter((name) => DIGEST.test(name)).sort().slice(-200).map((digest) => {
      const source = sourceByBundle.get(digest);
      return {
        digest, name: source?.name ?? null, version: source?.version ?? null,
        sourceRepository: source?.sourceRepository ?? null, sourceCommit: source?.sourceCommit ?? null,
        sourceTree: source?.sourceTree ?? null,
        active: this.loaded().manifest?.skills.some((item) => item.bundleDigest === digest) ?? false,
        previous: sets.find((set) => set.digest === previous)?.skills.some((item) => item.bundleDigest === digest) ?? false,
      };
    });
    return { bundles, packageSets: sets.map(({ skills: _skills, ...set }) => set), bounded: true, maximum: 200 };
  }

  private lastRecord(): DeploymentRecord | null {
    if (!existsSync(this.paths.deploymentRoot)) return null;
    const candidates = readdirSync(this.paths.deploymentRoot).map((name) => join(this.paths.deploymentRoot, name, 'record.json'))
      .filter((path) => existsSync(path)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return candidates.length === 0 ? null : JSON.parse(readFileSync(candidates[0], 'utf8')) as DeploymentRecord;
  }

  private publicRecord(record: DeploymentRecord): Record<string, unknown> {
    return {
      deploymentId: record.deploymentId, action: record.action, source: record.source,
      priorActiveSetDigest: record.priorActiveSetDigest, candidateSetDigest: record.candidateSetDigest,
      bundleDigest: record.bundleDigest, expectedCatalogDigest: record.expectedCatalogDigest,
      expectedSkillOperations: record.expectedSkillOperations, lifecycleState: record.lifecycleState,
      timestamps: record.timestamps, timingsMs: record.timingsMs, restartStatus: record.restartStatus,
      healthReadback: record.healthReadback, smokeResult: record.smokeResult,
      rollbackStatus: record.rollbackStatus, finalState: record.finalState,
      error: record.redactedError, bundleReused: record.bundleReused, setReused: record.setReused,
    };
  }
}

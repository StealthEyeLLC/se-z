// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
import { randomUUID } from 'node:crypto';
import {
  existsSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { canonicalJson } from '../protocol/canonical/canonical.js';
import type { OperationDefinition } from '../operations/definitions.js';
import { assertJsonSerializable } from './schema.js';
import { loadPackageSetFromPath } from './loader.js';

export interface ActivationRecord {
  action: 'deploy' | 'rollback';
  deploymentId: string;
  priorActiveSetDigest: string | null;
  priorActiveSetPath: string | null;
  priorPreviousSetPath: string | null;
  candidateSetPath: string;
  candidateSetDigest: string;
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
}

export interface ActivationDependencies {
  currentLink: string;
  previousLink: string;
  releaseRoot: string;
  coreDefinitions: readonly OperationDefinition[];
  restart: () => number;
  healthReadback: () => Promise<Record<string, unknown>>;
  delayMs?: number;
  now?: () => Date;
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function atomicWrite(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${canonicalJson(value)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

export function pointerTarget(link: string): string | null {
  if (!existsSync(link)) return null;
  if (!lstatSync(link).isSymbolicLink()) throw new Error(`${link} is not a symlink`);
  return resolve(dirname(link), readlinkSync(link));
}

function packageSetDigestFromPath(path: string | null): string | null {
  if (path === null) return null;
  const match = /\/([a-f0-9]{64})\.json$/.exec(path);
  if (match === null) throw new Error(`invalid package-set target: ${path}`);
  return match[1]!;
}

export function replacePointer(link: string, destination: string | null): void {
  if (destination === null) {
    rmSync(link, { force: true });
    return;
  }
  const temporary = `${link}.tmp-${process.pid}-${randomUUID()}`;
  symlinkSync(destination, temporary);
  renameSync(temporary, link);
}

export function redactActivationError(error: unknown): string {
  return (error instanceof Error ? error.message : 'unknown activation error')
    .replace(/gh[opusr]_[A-Za-z0-9_]+/g, '[REDACTED]').slice(0, 1000);
}

async function verifyCandidate(
  record: ActivationRecord,
  dependencies: ActivationDependencies,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  const loaded = await loadPackageSetFromPath(
    record.candidateSetPath,
    dependencies.coreDefinitions,
    dependencies.releaseRoot,
  );
  if (loaded.setDigest !== record.candidateSetDigest) throw new Error('active package-set digest mismatch');
  if (loaded.catalogDigest !== record.expectedCatalogDigest) throw new Error('active catalog digest mismatch');
  const operationNames = new Set(
    [...dependencies.coreDefinitions, ...loaded.definitions].map((item) => item.operation),
  );
  for (const operation of record.expectedCoreOperations) {
    if (!operationNames.has(operation)) throw new Error(`core operation disappeared: ${operation}`);
  }
  for (const operation of record.expectedSkillOperations) {
    if (!operationNames.has(operation)) throw new Error(`expected skill operation missing: ${operation}`);
  }
  for (const operation of record.removedSkillOperations) {
    if (operationNames.has(operation)) throw new Error(`removed skill operation remains: ${operation}`);
  }
  let smokeResult: unknown = null;
  if (record.smokeOperation !== null) {
    const handler = loaded.handlers.get(record.smokeOperation);
    if (handler === undefined) throw new Error(`smoke operation is not loaded: ${record.smokeOperation}`);
    const input = record.smokePayload ?? {};
    loaded.inputValidators.get(record.smokeOperation)?.(input);
    const source = loaded.skills.find((skill) =>
      skill.definitions.some((item) => item.operation === record.smokeOperation))?.source;
    if (source === undefined) throw new Error('smoke operation source is unavailable');
    smokeResult = await handler(input, {
      skillName: source.name,
      skillVersion: source.version,
      bundleDigest: source.bundleDigest,
      activeSetDigest: loaded.setDigest,
    });
    loaded.outputValidators.get(record.smokeOperation)?.(smokeResult);
    assertJsonSerializable(smokeResult, 'smoke result');
  }
  return {
    activeSetDigest: loaded.setDigest,
    catalogDigest: loaded.catalogDigest,
    coreOperationCount: dependencies.coreDefinitions.length,
    skillOperationCount: loaded.definitions.length,
    skills: loaded.skills.map((skill) => skill.source),
    durationMs: Date.now() - started,
    smokeResult,
  };
}

export async function activateRecord(
  recordPath: string,
  dependencies: ActivationDependencies,
): Promise<ActivationRecord> {
  await sleep(dependencies.delayMs ?? 0);
  const record = JSON.parse(readFileSync(recordPath, 'utf8')) as ActivationRecord;
  const timestamp = (): string => (dependencies.now?.() ?? new Date()).toISOString();
  let pointerMutationStarted = false;
  try {
    const observedCurrentPath = pointerTarget(dependencies.currentLink);
    const observedCurrentDigest = packageSetDigestFromPath(observedCurrentPath);
    const recordedPathDigest = packageSetDigestFromPath(record.priorActiveSetPath);
    if (
      observedCurrentDigest !== record.priorActiveSetDigest ||
      recordedPathDigest !== record.priorActiveSetDigest
    ) {
      throw new Error(
        `current pointer compare-and-swap mismatch: expected ${record.priorActiveSetDigest ?? 'none'}, ` +
        `observed ${observedCurrentDigest ?? 'none'}`,
      );
    }
    record.lifecycleState = 'ACTIVATING';
    record.timestamps.pointerMutationAt = timestamp();
    atomicWrite(recordPath, record);
    const pointerStarted = Date.now();
    pointerMutationStarted = true;
    replacePointer(dependencies.previousLink, record.priorActiveSetPath);
    replacePointer(dependencies.currentLink, record.candidateSetPath);
    record.timingsMs.pointerActivation = Date.now() - pointerStarted;
    record.restartStatus = 'starting';
    atomicWrite(recordPath, record);
    record.timingsMs.sezRestart = dependencies.restart();
    record.restartStatus = 'completed';
    record.lifecycleState = 'VERIFYING';
    record.timestamps.verifyingAt = timestamp();
    atomicWrite(recordPath, record);
    record.healthReadback = await dependencies.healthReadback();
    if (pointerTarget(dependencies.currentLink) !== record.candidateSetPath) {
      throw new Error('active package-set pointer changed during activation');
    }
    const readback = await verifyCandidate(record, dependencies);
    record.describeReadback = readback;
    record.smokeResult = readback.smokeResult;
    record.timingsMs.healthCatalogReadback =
      Number((record.healthReadback as { durationMs?: number }).durationMs ?? 0) +
      Number(readback.durationMs ?? 0);
    record.lifecycleState = record.action === 'rollback' ? 'ROLLED_BACK' : 'ACTIVE';
    record.finalState = record.lifecycleState;
    record.rollbackStatus = record.action === 'rollback' ? 'completed' : 'not_required';
    record.timestamps.completedAt = timestamp();
    atomicWrite(recordPath, record);
    return record;
  } catch (error) {
    record.redactedError = redactActivationError(error);
    if (!pointerMutationStarted) {
      record.lifecycleState = 'FAILED';
      record.finalState = 'FAILED';
      record.rollbackStatus = 'not_required';
      record.timestamps.failedAt = timestamp();
      atomicWrite(recordPath, record);
      return record;
    }
    record.lifecycleState = 'ROLLING_BACK';
    record.rollbackStatus = 'running';
    record.timestamps.rollingBackAt = timestamp();
    atomicWrite(recordPath, record);
    const rollbackStarted = Date.now();
    try {
      replacePointer(dependencies.currentLink, record.priorActiveSetPath);
      replacePointer(dependencies.previousLink, record.priorPreviousSetPath);
      dependencies.restart();
      if (record.priorActiveSetPath !== null) {
        const prior = await loadPackageSetFromPath(
          record.priorActiveSetPath,
          dependencies.coreDefinitions,
          dependencies.releaseRoot,
        );
        if (
          pointerTarget(dependencies.currentLink) !== record.priorActiveSetPath ||
          prior.setDigest === null
        ) throw new Error('prior package-set readback failed');
      }
      await dependencies.healthReadback();
      record.timingsMs.rollback = Date.now() - rollbackStarted;
      record.lifecycleState = 'ROLLED_BACK';
      record.finalState = 'ROLLED_BACK';
      record.rollbackStatus = 'completed';
      record.timestamps.rolledBackAt = timestamp();
      atomicWrite(recordPath, record);
      return record;
    } catch (rollbackError) {
      record.timingsMs.rollback = Date.now() - rollbackStarted;
      record.lifecycleState = 'RECOVERY_REQUIRED';
      record.finalState = 'RECOVERY_REQUIRED';
      record.rollbackStatus = 'failed';
      record.redactedError = `${record.redactedError}; rollback: ${redactActivationError(rollbackError)}`.slice(0, 1000);
      record.timestamps.recoveryRequiredAt = timestamp();
      atomicWrite(recordPath, record);
      return record;
    }
  }
}

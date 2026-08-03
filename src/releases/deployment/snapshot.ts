// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Signed, content-addressed private recovery snapshots for fixed host targets. */

import { type KeyObject } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalJson, sha256Hex } from '../../protocol/canonical/canonical.js';
import { signEd25519, verifyEd25519 } from '../../protocol/signatures/signing.js';
import { DeploymentError } from './types.js';

const DIGEST = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 20_000;

export const SNAPSHOT_TARGETS = Object.freeze([
  '/opt/se-z/current',
  '/opt/se-z/previous',
  '/opt/se-z/gateway/current',
  '/opt/se-z/gateway/previous',
  '/etc/systemd/system/se-z.service',
  '/etc/systemd/system/se-z.socket',
  '/etc/systemd/system/se-z-gateway.service',
  '/etc/tmpfiles.d/se-z.conf',
  '/etc/tmpfiles.d/se-z-gateway.conf',
  '/etc/se-z',
  '/etc/se-z-gateway',
  '/var/lib/se-z/deployment-state.sqlite',
  '/var/lib/se-z/deployment-state.sqlite-wal',
  '/var/lib/se-z/deployment-state.sqlite-shm',
  '/var/lib/se-z-gateway',
  '/etc/caddy/Caddyfile',
  '/etc/caddy/sites-enabled/se-z-gateway.Caddyfile',
] as const);

export const SEZ_RESTORE_TARGETS: readonly string[] = Object.freeze([
  '/etc/systemd/system/se-z.service',
  '/etc/systemd/system/se-z.socket',
  '/etc/tmpfiles.d/se-z.conf',
  '/etc/se-z',
  '/var/lib/se-z/deployment-state.sqlite',
  '/var/lib/se-z/deployment-state.sqlite-wal',
  '/var/lib/se-z/deployment-state.sqlite-shm',
]);

export const GATEWAY_RESTORE_TARGETS: readonly string[] = Object.freeze([
  '/etc/systemd/system/se-z-gateway.service',
  '/etc/tmpfiles.d/se-z-gateway.conf',
  '/etc/se-z-gateway',
  '/var/lib/se-z-gateway',
]);

export const CADDY_RESTORE_TARGETS: readonly string[] = Object.freeze([
  '/etc/caddy/Caddyfile',
  '/etc/caddy/sites-enabled/se-z-gateway.Caddyfile',
]);

const POINTER_TARGETS = new Set<string>(SNAPSHOT_TARGETS.slice(0, 4));

export type SnapshotEntryKind = 'absent' | 'directory' | 'file' | 'symlink';

export interface SnapshotEntry {
  path: string;
  kind: SnapshotEntryKind;
  mode?: string;
  uid?: number;
  gid?: number;
  size?: number;
  digest?: string;
  payloadReference?: string;
  linkTarget?: string;
  aclDigest?: string;
  aclPayloadReference?: string;
  xattrDigest?: string;
  xattrPayloadReference?: string;
}

export interface SnapshotObservations {
  machineIdentityDigest: string;
  releaseInventoryDigest: string;
  serviceInventoryDigest: string;
  processInventoryDigest: string;
  listenerInventoryDigest: string;
  permissionInventoryDigest: string;
  knownGoodHealthDigest: string;
  publicMetadataDigest: string;
  keyFingerprintInventoryDigest: string;
}

export interface HostSnapshotPayload {
  recordVersion: '2.0.0';
  recordType: 'se-z-private-recovery-snapshot';
  deploymentId: string;
  generation: number;
  machineId: string;
  capturedAt: string;
  targets: readonly string[];
  entries: SnapshotEntry[];
  observations: SnapshotObservations;
  totalPayloadBytes: number;
  signingKeyId: string;
  signatureAlgorithm: 'ed25519';
}

export interface SignedHostSnapshot extends HostSnapshotPayload {
  snapshotDigest: string;
  signature: string;
}

export interface ExtendedMetadata {
  acl: Buffer;
  xattrs: Buffer;
}

export interface ExtendedMetadataProvider {
  capture(path: string): ExtendedMetadata;
  restore(path: string, metadata: ExtendedMetadata): void;
}

/** Production provider: missing ACL/xattr tooling is a hard preflight failure. */
export class PosixExtendedMetadataProvider implements ExtendedMetadataProvider {
  capture(path: string): ExtendedMetadata {
    try {
      return {
        acl: execFileSync('getfacl', ['--absolute-names', '--omit-header', path], {
          maxBuffer: 4 * 1024 * 1024,
        }),
        xattrs: execFileSync('getfattr', ['--absolute-names', '--dump', path], {
          maxBuffer: 4 * 1024 * 1024,
        }),
      };
    } catch (error) {
      throw new DeploymentError(
        'deployment_invalid',
        'Exact ACL/xattr snapshot tooling is unavailable or failed',
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  restore(path: string, metadata: ExtendedMetadata): void {
    try {
      execFileSync('setfacl', ['--set-file=-', path], { input: metadata.acl });
      if (metadata.xattrs.length > 0) {
        execFileSync('setfattr', ['--restore=-'], { input: metadata.xattrs });
      }
    } catch (error) {
      throw new DeploymentError(
        'deployment_integrity_failed',
        'Exact ACL/xattr restoration failed',
        { path, cause: error instanceof Error ? error.message : String(error) },
      );
    }
  }
}

/** Explicitly fixture-only provider; production code never selects it by default. */
export const FIXTURE_EMPTY_EXTENDED_METADATA: ExtendedMetadataProvider = Object.freeze({
  capture: (_path: string) => ({
    acl: Buffer.from('fixture:no-acl\n'),
    xattrs: Buffer.from('fixture:no-xattrs\n'),
  }),
  restore: (_path: string, _metadata: ExtendedMetadata) => undefined,
});

export function mapHostPath(hostRoot: string, logicalPath: string): string {
  if (!logicalPath.startsWith('/') || logicalPath.includes('..')) {
    throw new DeploymentError('deployment_invalid', `Invalid fixed host path ${logicalPath}`);
  }
  const root = resolve(hostRoot);
  const mapped = root === '/' ? logicalPath : join(root, logicalPath.slice(1));
  if (root !== '/' && mapped !== root && !mapped.startsWith(`${root}/`)) {
    throw new DeploymentError('deployment_invalid', `Host path escaped fixture root: ${logicalPath}`);
  }
  return mapped;
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

function payloadDigest(reference: string): string {
  const match = /^recovery:sha256:([a-f0-9]{64})$/u.exec(reference);
  if (!match) throw new DeploymentError('deployment_integrity_failed', 'Invalid recovery reference');
  return match[1]!;
}

function validateObservationDigests(observations: SnapshotObservations): void {
  for (const [label, value] of Object.entries(observations)) {
    if (!DIGEST.test(value)) {
      throw new DeploymentError('deployment_invalid', `${label} must be a SHA-256`);
    }
  }
}

export interface SnapshotManagerOptions {
  hostRoot: string;
  recoveryRoot: string;
  machineId: string;
  snapshotPrivateKey?: KeyObject;
  snapshotPublicKey: KeyObject;
  signingKeyId: string;
  extendedMetadata?: ExtendedMetadataProvider;
  maxEntries?: number;
  maxPayloadBytes?: number;
}

export class SnapshotManager {
  private readonly metadata: ExtendedMetadataProvider;
  private readonly maxEntries: number;
  private readonly maxPayloadBytes: number;

  constructor(private readonly options: SnapshotManagerOptions) {
    this.metadata = options.extendedMetadata ?? new PosixExtendedMetadataProvider();
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_BYTES;
    mkdirSync(options.recoveryRoot, { recursive: true, mode: 0o700 });
  }

  capture(input: {
    deploymentId: string;
    generation: number;
    capturedAt: string;
    observations: SnapshotObservations;
  }): SignedHostSnapshot {
    if (!this.options.snapshotPrivateKey) {
      throw new DeploymentError('deployment_invalid', 'Snapshot signing key is unavailable');
    }
    if (!IDENTIFIER.test(input.deploymentId) || basename(input.deploymentId) !== input.deploymentId) {
      throw new DeploymentError('deployment_invalid', 'Invalid snapshot deployment ID');
    }
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
      throw new DeploymentError('deployment_invalid', 'Invalid snapshot generation');
    }
    const capturedAt = new Date(input.capturedAt);
    if (!Number.isFinite(capturedAt.valueOf()) || capturedAt.toISOString() !== input.capturedAt) {
      throw new DeploymentError('deployment_invalid', 'Snapshot timestamp is not canonical');
    }
    validateObservationDigests(input.observations);
    const payloads = new Map<string, Buffer>();
    const entries: SnapshotEntry[] = [];
    for (const target of SNAPSHOT_TARGETS) {
      this.capturePath(target, target, entries, payloads);
    }
    if (entries.length > this.maxEntries) {
      throw new DeploymentError('deployment_invalid', 'Snapshot entry count exceeds bound');
    }
    const totalPayloadBytes = [...payloads.values()].reduce((sum, value) => sum + value.length, 0);
    if (totalPayloadBytes > this.maxPayloadBytes) {
      throw new DeploymentError('deployment_invalid', 'Snapshot payload exceeds capacity bound');
    }
    const payload: HostSnapshotPayload = {
      recordVersion: '2.0.0',
      recordType: 'se-z-private-recovery-snapshot',
      deploymentId: input.deploymentId,
      generation: input.generation,
      machineId: this.options.machineId,
      capturedAt: input.capturedAt,
      targets: SNAPSHOT_TARGETS,
      entries,
      observations: input.observations,
      totalPayloadBytes,
      signingKeyId: this.options.signingKeyId,
      signatureAlgorithm: 'ed25519',
    };
    const snapshotDigest = sha256Hex(canonicalJson(payload));
    const snapshot: SignedHostSnapshot = {
      ...payload,
      snapshotDigest,
      signature: signEd25519(
        canonicalJson({ snapshotDigest, snapshot: payload }),
        this.options.snapshotPrivateKey,
      ),
    };
    this.persist(snapshot, payloads);
    return snapshot;
  }

  load(snapshotDigest: string): SignedHostSnapshot {
    if (!DIGEST.test(snapshotDigest)) {
      throw new DeploymentError('deployment_invalid', 'Invalid snapshot digest');
    }
    const path = join(this.options.recoveryRoot, snapshotDigest, 'private-recovery.json');
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as SignedHostSnapshot;
    const { snapshotDigest: storedDigest, signature, ...payload } = snapshot;
    if (
      storedDigest !== snapshotDigest ||
      sha256Hex(canonicalJson(payload)) !== snapshotDigest ||
      snapshot.machineId !== this.options.machineId ||
      snapshot.recordVersion !== '2.0.0' ||
      snapshot.recordType !== 'se-z-private-recovery-snapshot' ||
      snapshot.signatureAlgorithm !== 'ed25519' ||
      !verifyEd25519(
        canonicalJson({ snapshotDigest, snapshot: payload }),
        signature,
        this.options.snapshotPublicKey,
      )
    ) {
      throw new DeploymentError('deployment_integrity_failed', 'Private recovery snapshot is invalid');
    }
    if (canonicalJson(snapshot.targets) !== canonicalJson(SNAPSHOT_TARGETS)) {
      throw new DeploymentError('deployment_integrity_failed', 'Snapshot target inventory is not exact');
    }
    return snapshot;
  }

  restoreNonPointerTargets(
    snapshotDigest: string,
    selectedTargets: readonly string[] = SNAPSHOT_TARGETS.filter((target) => !POINTER_TARGETS.has(target)),
  ): { restoredEntryCount: number; readbackDigest: string } {
    const snapshot = this.load(snapshotDigest);
    const selected = new Set(selectedTargets);
    for (const target of selected) {
      if (!SNAPSHOT_TARGETS.includes(target as (typeof SNAPSHOT_TARGETS)[number]) || POINTER_TARGETS.has(target)) {
        throw new DeploymentError('deployment_invalid', `Restore target is not fixed: ${target}`);
      }
    }
    const entriesByTarget = new Map<string, SnapshotEntry[]>();
    for (const target of SNAPSHOT_TARGETS) entriesByTarget.set(target, []);
    for (const entry of snapshot.entries) {
      const target = SNAPSHOT_TARGETS.find(
        (candidate) => entry.path === candidate || entry.path.startsWith(`${candidate}/`),
      );
      if (!target) throw new DeploymentError('deployment_integrity_failed', 'Snapshot contains undeclared path');
      entriesByTarget.get(target)!.push(entry);
    }
    let restoredEntryCount = 0;
    for (const target of SNAPSHOT_TARGETS) {
      if (!selected.has(target)) continue;
      const entries = entriesByTarget.get(target)!;
      this.restoreTarget(target, entries, snapshotDigest);
      restoredEntryCount += entries.length;
    }
    const readback = this.inventoryCurrentNonPointers(selectedTargets);
    const expected = snapshot.entries.filter((entry) =>
      selectedTargets.some((target) => entry.path === target || entry.path.startsWith(`${target}/`)),
    );
    if (canonicalJson(readback) !== canonicalJson(expected)) {
      throw new DeploymentError('deployment_integrity_failed', 'Restored host snapshot readback differs');
    }
    return { restoredEntryCount, readbackDigest: sha256Hex(canonicalJson(readback)) };
  }

  private capturePath(
    logicalPath: string,
    targetRoot: string,
    entries: SnapshotEntry[],
    payloads: Map<string, Buffer>,
  ): void {
    const physical = mapHostPath(this.options.hostRoot, logicalPath);
    if (!existsSync(physical) && !this.isDanglingSymlink(physical)) {
      entries.push({ path: logicalPath, kind: 'absent' });
      return;
    }
    const stat = lstatSync(physical);
    if (stat.isSymbolicLink()) {
      entries.push({
        path: logicalPath,
        kind: 'symlink',
        mode: formatMode(stat.mode),
        uid: stat.uid,
        gid: stat.gid,
        linkTarget: readlinkSync(physical),
      });
      return;
    }
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new DeploymentError('deployment_invalid', `Snapshot special file rejected: ${logicalPath}`);
    }
    const extended = this.metadata.capture(physical);
    const aclReference = this.addPayload(payloads, extended.acl);
    const xattrReference = this.addPayload(payloads, extended.xattrs);
    const common = {
      mode: formatMode(stat.mode),
      uid: stat.uid,
      gid: stat.gid,
      aclDigest: sha256Hex(extended.acl),
      aclPayloadReference: aclReference,
      xattrDigest: sha256Hex(extended.xattrs),
      xattrPayloadReference: xattrReference,
    };
    if (stat.isFile()) {
      if (stat.size > MAX_ENTRY_BYTES) {
        throw new DeploymentError('deployment_invalid', `Snapshot file exceeds bound: ${logicalPath}`);
      }
      const bytes = readFileSync(physical);
      entries.push({
        path: logicalPath,
        kind: 'file',
        ...common,
        size: bytes.length,
        digest: sha256Hex(bytes),
        payloadReference: this.addPayload(payloads, bytes),
      });
      return;
    }
    entries.push({ path: logicalPath, kind: 'directory', ...common, size: 0 });
    for (const name of readdirSync(physical).sort()) {
      const childLogical = `${logicalPath}/${name}`;
      if (!childLogical.startsWith(`${targetRoot}/`)) {
        throw new DeploymentError('deployment_integrity_failed', 'Snapshot recursion escaped target');
      }
      this.capturePath(childLogical, targetRoot, entries, payloads);
      if (entries.length > this.maxEntries) {
        throw new DeploymentError('deployment_invalid', 'Snapshot entry count exceeds bound');
      }
    }
  }

  private persist(snapshot: SignedHostSnapshot, payloads: Map<string, Buffer>): void {
    const temporary = mkdtempSync(join(this.options.recoveryRoot, '.snapshot-building-'));
    try {
      const payloadRoot = join(temporary, 'payload');
      mkdirSync(payloadRoot, { mode: 0o700 });
      for (const [digest, bytes] of payloads) {
        const path = join(payloadRoot, `${digest}.blob`);
        writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      writeFileSync(
        join(temporary, 'private-recovery.json'),
        `${canonicalJson(snapshot)}\n`,
        { mode: 0o600, flag: 'wx' },
      );
      const redacted = {
        recordVersion: snapshot.recordVersion,
        recordType: 'se-z-redacted-snapshot-evidence',
        deploymentId: snapshot.deploymentId,
        generation: snapshot.generation,
        machineId: snapshot.machineId,
        capturedAt: snapshot.capturedAt,
        snapshotDigest: snapshot.snapshotDigest,
        observations: snapshot.observations,
        entries: snapshot.entries.map((entry) => ({
          path: entry.path,
          kind: entry.kind,
          mode: entry.mode,
          uid: entry.uid,
          gid: entry.gid,
          size: entry.size,
          digest: entry.digest,
          aclDigest: entry.aclDigest,
          xattrDigest: entry.xattrDigest,
        })),
        privatePayloadReference: `recovery:sha256:${snapshot.snapshotDigest}`,
      };
      writeFileSync(
        join(temporary, 'redacted-evidence.json'),
        `${canonicalJson(redacted)}\n`,
        { mode: 0o600, flag: 'wx' },
      );
      fsyncDirectory(payloadRoot);
      fsyncDirectory(temporary);
      const target = join(this.options.recoveryRoot, snapshot.snapshotDigest);
      if (existsSync(target)) throw new DeploymentError('deployment_conflict', 'Snapshot already exists');
      renameSync(temporary, target);
      fsyncDirectory(this.options.recoveryRoot);
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  private restoreTarget(target: string, entries: SnapshotEntry[], snapshotDigest: string): void {
    if (entries.length === 0 || entries[0]!.path !== target) {
      throw new DeploymentError('deployment_integrity_failed', `Snapshot target root missing: ${target}`);
    }
    const physicalRoot = mapHostPath(this.options.hostRoot, target);
    rmSync(physicalRoot, { recursive: true, force: true });
    const rootEntry = entries[0]!;
    if (rootEntry.kind === 'absent') return;
    const directories: SnapshotEntry[] = [];
    for (const entry of entries) {
      const physical = mapHostPath(this.options.hostRoot, entry.path);
      if (entry.kind === 'directory') {
        mkdirSync(physical, { recursive: true, mode: 0o700 });
        directories.push(entry);
      } else if (entry.kind === 'file') {
        mkdirSync(dirname(physical), { recursive: true, mode: 0o700 });
        const bytes = this.readPayload(snapshotDigest, entry.payloadReference, entry.digest);
        this.writeAtomicFile(physical, bytes, entry.mode!);
        this.restoreMetadata(physical, entry, snapshotDigest);
      } else if (entry.kind === 'symlink') {
        mkdirSync(dirname(physical), { recursive: true, mode: 0o700 });
        symlinkSync(entry.linkTarget!, physical);
        lchownSync(physical, entry.uid!, entry.gid!);
      }
    }
    directories.sort((left, right) => right.path.split('/').length - left.path.split('/').length);
    for (const entry of directories) {
      const physical = mapHostPath(this.options.hostRoot, entry.path);
      chmodSync(physical, Number.parseInt(entry.mode!, 8));
      chownSync(physical, entry.uid!, entry.gid!);
      this.restoreMetadata(physical, entry, snapshotDigest);
      fsyncDirectory(physical);
    }
  }

  private restoreMetadata(path: string, entry: SnapshotEntry, snapshotDigest: string): void {
    if (!entry.aclPayloadReference || !entry.xattrPayloadReference) {
      throw new DeploymentError('deployment_integrity_failed', `Extended metadata missing: ${entry.path}`);
    }
    const acl = this.readPayload(snapshotDigest, entry.aclPayloadReference, entry.aclDigest);
    const xattrs = this.readPayload(snapshotDigest, entry.xattrPayloadReference, entry.xattrDigest);
    chmodSync(path, Number.parseInt(entry.mode!, 8));
    chownSync(path, entry.uid!, entry.gid!);
    this.metadata.restore(path, { acl, xattrs });
  }

  private readPayload(
    snapshotDigest: string,
    reference: string | undefined,
    expectedDigest: string | undefined,
  ): Buffer {
    if (!reference || !expectedDigest || !DIGEST.test(expectedDigest)) {
      throw new DeploymentError('deployment_integrity_failed', 'Snapshot payload declaration is invalid');
    }
    const digest = payloadDigest(reference);
    if (digest !== expectedDigest) {
      throw new DeploymentError('deployment_integrity_failed', 'Snapshot payload reference mismatch');
    }
    const path = join(this.options.recoveryRoot, snapshotDigest, 'payload', `${digest}.blob`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ENTRY_BYTES) {
      throw new DeploymentError('deployment_integrity_failed', 'Unsafe snapshot payload');
    }
    const bytes = readFileSync(path);
    if (sha256Hex(bytes) !== digest) {
      throw new DeploymentError('deployment_integrity_failed', 'Snapshot payload digest mismatch');
    }
    return bytes;
  }

  private writeAtomicFile(path: string, bytes: Buffer, mode: string): void {
    const temporary = `${path}.restore-${process.pid}`;
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      Number.parseInt(mode, 8),
    );
    try {
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
  }

  private inventoryCurrentNonPointers(selectedTargets: readonly string[]): SnapshotEntry[] {
    const payloads = new Map<string, Buffer>();
    const entries: SnapshotEntry[] = [];
    for (const target of selectedTargets) this.capturePath(target, target, entries, payloads);
    return entries;
  }

  private addPayload(payloads: Map<string, Buffer>, bytes: Buffer): string {
    const digest = sha256Hex(bytes);
    if (!payloads.has(digest)) payloads.set(digest, bytes);
    return `recovery:sha256:${digest}`;
  }

  private isDanglingSymlink(path: string): boolean {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  }
}

// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Sez-owned, non-networked, fixed-function rollback controller and guard. */

import { type KeyObject } from 'node:crypto';
import { canonicalJson, sha256Hex } from '../../protocol/canonical/canonical.js';
import {
  assertMarkerMatchesGuard,
  buildSignedControllerEvidence,
  verifySignedControllerEvidence,
  verifySignedGuardRecord,
  verifySignedSuccessMarker,
} from './contract.js';
import { ControllerStore, type ControllerStoreOptions } from './storage.js';
import {
  CONTROLLER_RECORD_VERSION,
  ControllerError,
  type ControllerDisposition,
  type ControllerStatus,
  type FixedGuardHostAdapter,
  type SignedControllerEvidence,
  type SignedDeploymentGuardRecord,
  type SignedSuccessMarker,
} from './types.js';

export interface FixedDeploymentControllerOptions extends ControllerStoreOptions {
  machineId: string;
  sezAuthorityPublicKey: KeyObject;
  controllerEvidencePrivateKey: KeyObject;
  controllerEvidencePublicKey: KeyObject;
  controllerSigningKeyId: string;
  host: FixedGuardHostAdapter;
  now?: () => Date;
}

function pointersDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export class FixedDeploymentController {
  private readonly store: ControllerStore;
  private readonly now: () => Date;

  constructor(private readonly options: FixedDeploymentControllerOptions) {
    this.store = new ControllerStore(options);
    this.now = options.now ?? (() => new Date());
  }

  arm(input: unknown): ControllerStatus {
    return this.store.withGlobalLock(() => {
      const record = this.verifyGuard(input);
      const deadline = new Date(record.deadline);
      if (deadline.valueOf() <= this.now().valueOf()) {
        throw new ControllerError('controller_deadline_invalid', 'Guard deadline must be in the future');
      }
      const active = this.store.activeGuardIds();
      if (active.some((deploymentId) => deploymentId !== record.deploymentId)) {
        throw new ControllerError(
          'controller_active_guard_conflict',
          'A different deployment guard is already active',
          { activeDeploymentIds: active },
        );
      }
      if (active.includes(record.deploymentId)) {
        const existing = this.loadGuard(record.deploymentId);
        if (existing.recordDigest !== record.recordDigest) {
          throw new ControllerError(
            'controller_generation_conflict',
            'Deployment guard retry changed the signed intent',
          );
        }
        return this.status(existing, 'armed');
      }
      const latest = this.store.latestGeneration();
      if (latest > record.generation || (latest === record.generation && !active.includes(record.deploymentId))) {
        throw new ControllerError(
          'controller_generation_conflict',
          'Guard generation is stale or already belongs to another deployment',
          { latest, requested: record.generation },
        );
      }
      const actualPointers = this.options.host.readPointers(record);
      if (canonicalJson(actualPointers) !== canonicalJson(record.expectedPointers)) {
        throw new ControllerError(
          'controller_pointer_mismatch',
          'Host pointers differ from the signed pre-mutation expectation',
          {
            expectedDigest: pointersDigest(record.expectedPointers),
            actualDigest: pointersDigest(actualPointers),
          },
        );
      }
      this.store.writeGuard(record);
      const evidence = this.evidence(record, 'armed', {
        guardRecordDigest: record.recordDigest,
        pointerDigest: pointersDigest(actualPointers),
      });
      this.store.writeEvidence(evidence);
      return this.status(record, 'armed', evidence);
    });
  }

  commitSuccess(input: unknown): ControllerStatus {
    return this.store.withGlobalLock(() => {
      const marker = verifySignedSuccessMarker(input, this.options.sezAuthorityPublicKey);
      const guard = this.loadGuard(marker.deploymentId);
      assertMarkerMatchesGuard(marker, guard);
      this.assertMachine(marker.machineId);
      if (new Date(marker.acceptedAt).valueOf() > this.now().valueOf()) {
        throw new ControllerError('controller_marker_mismatch', 'Success marker is from the future');
      }
      this.store.writeSuccessMarker(marker);
      const evidence = this.evidence(guard, 'success_marker_valid', {
        successMarkerDigest: marker.recordDigest,
      });
      this.store.writeEvidence(evidence);
      return this.status(guard, 'success_marker_valid', evidence);
    });
  }

  disarm(deploymentId: string): ControllerStatus {
    return this.store.withGlobalLock(() => {
      const guard = this.loadGuard(deploymentId);
      const terminal = this.readVerifiedTerminal(deploymentId);
      if (terminal) {
        if (terminal.disposition === 'disarmed') {
          return this.status(guard, 'disarmed', terminal);
        }
        throw new ControllerError(
          'controller_marker_mismatch',
          'A rolled-back guard cannot be disarmed as successful',
        );
      }
      const marker = this.loadValidMarker(guard);
      if (!marker) {
        throw new ControllerError(
          'controller_marker_mismatch',
          'Exact valid success marker is required before disarm',
        );
      }
      const evidence = this.evidence(guard, 'disarmed', {
        successMarkerDigest: marker.recordDigest,
        guardRecordDigest: guard.recordDigest,
      });
      this.store.writeEvidence(evidence);
      return this.status(guard, 'disarmed', evidence);
    });
  }

  evaluate(deploymentId: string): ControllerStatus {
    return this.store.withGlobalLock(() => {
      const guard = this.loadGuard(deploymentId);
      const latest = this.store.latestGeneration();
      if (guard.generation < latest) {
        const evidence = this.evidence(guard, 'stale_generation', { latestGeneration: latest });
        this.store.writeEvidence(evidence);
        return this.status(guard, 'stale_generation', evidence);
      }

      const terminal = this.readVerifiedTerminal(deploymentId);
      if (terminal) return this.status(guard, terminal.disposition, terminal);

      const marker = this.loadValidMarker(guard);
      if (marker) {
        const evidence = this.evidence(guard, 'success_marker_valid', {
          successMarkerDigest: marker.recordDigest,
        });
        this.store.writeEvidence(evidence);
        return this.status(guard, 'success_marker_valid', evidence);
      }

      if (this.now().valueOf() < new Date(guard.deadline).valueOf()) {
        const evidence = this.evidence(guard, 'pending', {
          deadline: guard.deadline,
          markerPresent: this.store.readSuccessMarker(deploymentId) !== undefined,
        });
        this.store.writeEvidence(evidence);
        return this.status(guard, 'pending', evidence);
      }

      const rollback = this.options.host.restoreSnapshot(guard);
      const disposition: ControllerDisposition = rollback.completed ? 'rolled_back' : 'rollback_failed';
      const evidence = this.evidence(guard, disposition, rollback.details);
      this.store.writeEvidence(evidence);
      return this.status(guard, disposition, evidence);
    });
  }

  read(deploymentId: string): ControllerStatus {
    const guard = this.loadGuard(deploymentId);
    const terminal = this.readVerifiedTerminal(deploymentId);
    if (terminal) return this.status(guard, terminal.disposition, terminal);
    if (this.loadValidMarker(guard)) return this.status(guard, 'success_marker_valid');
    return this.status(guard, 'armed');
  }

  manualRecover(input: {
    deploymentId: string;
    snapshotDigest: string;
    reason: string;
  }): ControllerStatus {
    return this.store.withGlobalLock(() => {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9 .,._:-]{7,511}$/u.test(input.reason) ||
        /[;&|`$<>\\]/u.test(input.reason)
      ) {
        throw new ControllerError('controller_invalid_record', 'Manual recovery reason is invalid');
      }
      const guard = this.loadGuard(input.deploymentId);
      if (guard.snapshotDigest !== input.snapshotDigest) {
        throw new ControllerError('controller_marker_mismatch', 'Manual recovery snapshot fence failed');
      }
      const terminal = this.readVerifiedTerminal(input.deploymentId);
      if (!terminal || terminal.disposition !== 'rollback_failed') {
        throw new ControllerError(
          'controller_rollback_failed',
          'Manual recovery is allowed only after a recorded rollback failure',
        );
      }
      const result = this.options.host.restoreSnapshot(guard);
      const disposition: ControllerDisposition = result.completed ? 'rolled_back' : 'rollback_failed';
      const evidence = this.evidence(guard, disposition, {
        ...result.details,
        breakGlass: true,
        reasonDigest: sha256Hex(input.reason),
        priorFailureEvidenceDigest: terminal.recordDigest,
      });
      this.store.writeManualRecoveryEvidence(evidence);
      return this.status(guard, disposition, evidence);
    });
  }

  private loadGuard(deploymentId: string): SignedDeploymentGuardRecord {
    return this.verifyGuard(this.store.readGuard(deploymentId));
  }

  private verifyGuard(input: unknown): SignedDeploymentGuardRecord {
    const record = verifySignedGuardRecord(input, this.options.sezAuthorityPublicKey);
    this.assertMachine(record.machineId);
    return record;
  }

  private assertMachine(machineId: string): void {
    if (machineId !== this.options.machineId) {
      throw new ControllerError(
        'controller_machine_mismatch',
        'Signed controller record targets another machine',
      );
    }
  }

  private loadValidMarker(guard: SignedDeploymentGuardRecord): SignedSuccessMarker | undefined {
    const raw = this.store.readSuccessMarker(guard.deploymentId);
    if (!raw) return undefined;
    try {
      const marker = verifySignedSuccessMarker(raw, this.options.sezAuthorityPublicKey);
      assertMarkerMatchesGuard(marker, guard);
      this.assertMachine(marker.machineId);
      return marker;
    } catch {
      return undefined;
    }
  }

  private readVerifiedTerminal(deploymentId: string): SignedControllerEvidence | undefined {
    const raw = this.store.readTerminalEvidence(deploymentId);
    if (!raw) return undefined;
    const evidence = verifySignedControllerEvidence(raw, this.options.controllerEvidencePublicKey);
    this.assertMachine(evidence.machineId);
    return evidence;
  }

  private evidence(
    guard: SignedDeploymentGuardRecord,
    disposition: ControllerDisposition,
    details: Record<string, unknown>,
  ): SignedControllerEvidence {
    return buildSignedControllerEvidence(
      {
        recordVersion: CONTROLLER_RECORD_VERSION,
        recordType: 'se-z-controller-evidence',
        deploymentId: guard.deploymentId,
        generation: guard.generation,
        machineId: guard.machineId,
        planDigest: guard.planDigest,
        snapshotDigest: guard.snapshotDigest,
        candidateManifestDigests: guard.candidateManifestDigests,
        candidatePointerTargets: guard.candidatePointerTargets,
        disposition,
        detailsDigest: sha256Hex(canonicalJson(details)),
        occurredAt: this.now().toISOString(),
        signingKeyId: this.options.controllerSigningKeyId,
        signatureAlgorithm: 'ed25519',
      },
      this.options.controllerEvidencePrivateKey,
    );
  }

  private status(
    guard: SignedDeploymentGuardRecord,
    disposition: ControllerDisposition,
    evidence?: SignedControllerEvidence,
  ): ControllerStatus {
    return {
      deploymentId: guard.deploymentId,
      generation: guard.generation,
      disposition,
      guardRecordDigest: guard.recordDigest,
      ...(evidence ? { evidence } : {}),
    };
  }
}

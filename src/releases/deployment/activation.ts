// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Guard-gated gateway-first atomic product pointer activation. */

import { existsSync, lstatSync } from 'node:fs';
import { canonicalJson, sha256Hex } from '../../protocol/canonical/canonical.js';
import type {
  ControllerStatus,
  ExpectedProductPointers,
  SignedDeploymentGuardRecord,
} from '../../selfhost/controller/types.js';
import { atomicSwapSymlinks, readSymlinkTarget } from '../../selfhost/install/symlinks.js';
import { mapHostPath } from './snapshot.js';
import { DeploymentError, type DeploymentProduct } from './types.js';

export interface ActivationResult {
  product: DeploymentProduct;
  previousTarget: string;
  currentTarget: string;
  pointerReadbackDigest: string;
}

function assertGuardReadback(
  guard: SignedDeploymentGuardRecord,
  status: ControllerStatus,
): void {
  if (
    status.deploymentId !== guard.deploymentId ||
    status.generation !== guard.generation ||
    status.guardRecordDigest !== guard.recordDigest ||
    !['armed', 'pending'].includes(status.disposition)
  ) {
    throw new DeploymentError(
      'deployment_transition_forbidden',
      'Exact armed guard readback is required before pointer activation',
    );
  }
}

function activate(
  hostRoot: string,
  product: DeploymentProduct,
  pointers: ExpectedProductPointers,
  candidateTarget: string,
): ActivationResult {
  if (!pointers.current.target) {
    throw new DeploymentError('deployment_invalid', 'Known-good current target is required');
  }
  const candidatePath = mapHostPath(hostRoot, candidateTarget);
  if (!existsSync(candidatePath)) {
    throw new DeploymentError('deployment_not_found', 'Inactive candidate target is missing');
  }
  const stat = lstatSync(candidatePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new DeploymentError('deployment_integrity_failed', 'Inactive candidate is not a real directory');
  }
  const currentPath = mapHostPath(hostRoot, pointers.current.link);
  const previousPath = mapHostPath(hostRoot, pointers.previous.link);
  const result = atomicSwapSymlinks(currentPath, previousPath, candidateTarget, {
    expectedCurrent: pointers.current.target,
    expectedPrevious: pointers.previous.target,
  });
  const readback = {
    current: readSymlinkTarget(currentPath),
    previous: readSymlinkTarget(previousPath),
  };
  if (readback.current !== candidateTarget || readback.previous !== result.previous) {
    throw new DeploymentError('deployment_integrity_failed', 'Activation pointer readback failed');
  }
  return {
    product,
    previousTarget: result.previous!,
    currentTarget: candidateTarget,
    pointerReadbackDigest: sha256Hex(canonicalJson(readback)),
  };
}

export function activateGatewayCandidate(input: {
  hostRoot: string;
  guard: SignedDeploymentGuardRecord;
  guardStatus: ControllerStatus;
}): ActivationResult {
  assertGuardReadback(input.guard, input.guardStatus);
  return activate(
    input.hostRoot,
    'se-z-gateway',
    input.guard.expectedPointers.gateway,
    input.guard.candidatePointerTargets.gateway,
  );
}

export function activateSezCandidate(input: {
  hostRoot: string;
  guard: SignedDeploymentGuardRecord;
  guardStatus: ControllerStatus;
  gatewayAcceptedLegacy: boolean;
}): ActivationResult {
  assertGuardReadback(input.guard, input.guardStatus);
  if (!input.gatewayAcceptedLegacy) {
    throw new DeploymentError(
      'deployment_transition_forbidden',
      'Sez activation requires gateway legacy acceptance evidence',
    );
  }
  return activate(
    input.hostRoot,
    'se-z',
    input.guard.expectedPointers.sez,
    input.guard.candidatePointerTargets.sez,
  );
}

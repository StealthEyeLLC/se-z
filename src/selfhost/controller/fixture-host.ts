// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Production-shaped host adapter constrained to an isolated /tmp fixture root. */

import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJson, sha256Hex } from '../../protocol/canonical/canonical.js';
import { ControllerError } from './types.js';
import type {
  ExpectedPointers,
  FixedGuardHostAdapter,
  GuardRollbackResult,
  SignedDeploymentGuardRecord,
} from './types.js';

interface FixtureState {
  pointers: ExpectedPointers;
  restoreAttempts: number;
  failRestore: boolean;
}

interface FixtureEnvelope {
  fixture: 'se-z-nonproduction-v2';
  payload: FixtureState;
  digest: string;
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export class FixtureGuardHost implements FixedGuardHostAdapter {
  private readonly statePath: string;

  constructor(
    fixtureRoot: string,
    initialPointers?: ExpectedPointers,
  ) {
    const root = resolve(fixtureRoot);
    const allowed = `${resolve(tmpdir())}/`;
    if (!root.startsWith(allowed) || root === resolve(tmpdir())) {
      throw new ControllerError(
        'controller_invalid_record',
        'Fixture host must be an isolated child of the operating-system temp directory',
      );
    }
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ControllerError('controller_integrity_failed', 'Fixture root is not a real directory');
    }
    writeFileSync(join(root, '.se-z-nonproduction-fixture'), 'nonproduction-only\n', {
      mode: 0o600,
      flag: existsSync(join(root, '.se-z-nonproduction-fixture')) ? 'r+' : 'wx',
    });
    this.statePath = join(root, 'host-state.json');
    if (!existsSync(this.statePath)) {
      if (!initialPointers) {
        throw new ControllerError('controller_invalid_record', 'Initial fixture pointers are required');
      }
      this.writeState({ pointers: initialPointers, restoreAttempts: 0, failRestore: false });
    }
  }

  readPointers(_record: SignedDeploymentGuardRecord): ExpectedPointers {
    return this.readState().pointers;
  }

  restoreSnapshot(record: SignedDeploymentGuardRecord): GuardRollbackResult {
    const state = this.readState();
    const next: FixtureState = {
      ...state,
      restoreAttempts: state.restoreAttempts + 1,
      pointers: state.failRestore ? state.pointers : record.expectedPointers,
    };
    this.writeState(next);
    return state.failRestore
      ? {
          completed: false,
          details: {
            fixture: true,
            reason: 'injected_restore_failure',
            restoreAttempts: next.restoreAttempts,
          },
        }
      : {
          completed: true,
          details: {
            fixture: true,
            pointerDigest: sha256Hex(canonicalJson(next.pointers)),
            restoreAttempts: next.restoreAttempts,
          },
        };
  }

  setPointersForTest(pointers: ExpectedPointers): void {
    this.writeState({ ...this.readState(), pointers });
  }

  setRestoreFailureForTest(failRestore: boolean): void {
    this.writeState({ ...this.readState(), failRestore });
  }

  readFixtureStateForTest(): FixtureState {
    return this.readState();
  }

  private readState(): FixtureState {
    const stat = lstatSync(this.statePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
      throw new ControllerError('controller_integrity_failed', 'Unsafe fixture state record');
    }
    const envelope = JSON.parse(readFileSync(this.statePath, 'utf8')) as FixtureEnvelope;
    if (
      envelope.fixture !== 'se-z-nonproduction-v2' ||
      envelope.digest !== sha256Hex(canonicalJson(envelope.payload))
    ) {
      throw new ControllerError('controller_integrity_failed', 'Fixture state digest mismatch');
    }
    return envelope.payload;
  }

  private writeState(payload: FixtureState): void {
    const envelope: FixtureEnvelope = {
      fixture: 'se-z-nonproduction-v2',
      payload,
      digest: sha256Hex(canonicalJson(payload)),
    };
    const temporary = `${this.statePath}.next-${process.pid}`;
    writeFileSync(temporary, `${canonicalJson(envelope)}\n`, { mode: 0o600, flag: 'wx' });
    const fd = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.statePath);
    fsyncDirectory(dirname(this.statePath));
  }
}

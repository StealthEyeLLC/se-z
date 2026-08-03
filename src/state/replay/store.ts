// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Replay protection and strict semantic idempotency store. */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { RuntimeConfig } from '../../supervisor/configuration/config.js';

interface NonceEntry {
  nonce: string;
  seenAt: number;
}

interface IdempotencyEntry {
  requestHash: string;
  requestId?: string;
  fingerprint?: string;
  status?: 'pending' | 'completed';
  response?: unknown;
  storedAt: number;
}

interface StoreData {
  version?: number;
  nonces: NonceEntry[];
  idempotency: IdempotencyEntry[];
}

export type SemanticIdempotencyResult =
  | { state: 'miss' }
  | { state: 'pending' }
  | { state: 'conflict'; existingFingerprint: string }
  | { state: 'replay'; response: unknown };

export class ReplayStore {
  private data: StoreData;
  private readonly storePath: string;
  private dirty = false;

  constructor(private readonly config: RuntimeConfig) {
    this.storePath = join(config.stateRoot, 'replay-store.json');
    this.data = this.load();
  }

  private load(): StoreData {
    try {
      if (existsSync(this.storePath)) {
        const parsed = JSON.parse(readFileSync(this.storePath, 'utf8')) as Partial<StoreData>;
        return {
          version: 2,
          nonces: Array.isArray(parsed.nonces) ? parsed.nonces : [],
          idempotency: Array.isArray(parsed.idempotency) ? parsed.idempotency : [],
        };
      }
    } catch {
      // A corrupt store is fail-safe for availability only. Authentication,
      // signatures, timestamps, target host, and peer credentials still apply.
    }
    return { version: 2, nonces: [], idempotency: [] };
  }

  persist(): void {
    if (!this.dirty) return;
    mkdirSync(this.config.stateRoot, { recursive: true, mode: 0o750 });
    const temporary = `${this.storePath}.tmp-${process.pid}`;
    try {
      writeFileSync(temporary, JSON.stringify({ ...this.data, version: 2 }), { mode: 0o600 });
      const fileFd = openSync(temporary, 'r');
      try {
        fsyncSync(fileFd);
      } finally {
        closeSync(fileFd);
      }
      renameSync(temporary, this.storePath);
      const directoryFd = openSync(dirname(this.storePath), 'r');
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
      this.dirty = false;
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  private prune(): void {
    const now = Date.now();
    const beforeNonces = this.data.nonces.length;
    const beforeIdempotency = this.data.idempotency.length;
    this.data.nonces = this.data.nonces.filter(
      (n) => now - n.seenAt < this.config.nonceRetentionMs,
    );
    this.data.idempotency = this.data.idempotency.filter(
      (e) => now - e.storedAt < this.config.idempotencyRetentionMs,
    );
    if (
      beforeNonces !== this.data.nonces.length ||
      beforeIdempotency !== this.data.idempotency.length
    ) {
      this.dirty = true;
    }
  }

  hasNonce(nonce: string): boolean {
    this.prune();
    return this.data.nonces.some((n) => n.nonce === nonce);
  }

  tryCommitNonce(nonce: string): boolean {
    this.prune();
    if (this.data.nonces.some((n) => n.nonce === nonce)) {
      return false;
    }
    this.data.nonces.push({ nonce, seenAt: Date.now() });
    this.dirty = true;
    return true;
  }

  /** @deprecated use tryCommitNonce after verification */
  checkAndRecordNonce(nonce: string): boolean {
    return this.tryCommitNonce(nonce);
  }

  getIdempotentResponse(hash: string): unknown | undefined {
    this.prune();
    const entry = this.data.idempotency.find(
      (candidate) =>
        candidate.requestHash === hash &&
        (candidate.status === undefined || candidate.status === 'completed'),
    );
    return entry?.response;
  }

  checkSemantic(requestId: string, fingerprint: string): SemanticIdempotencyResult {
    this.prune();
    const entry = this.data.idempotency.find((candidate) => candidate.requestId === requestId);
    if (!entry) return { state: 'miss' };
    if (!entry.fingerprint) {
      return { state: 'conflict', existingFingerprint: 'legacy_unknown' };
    }
    if (entry.fingerprint !== fingerprint) {
      return { state: 'conflict', existingFingerprint: entry.fingerprint };
    }
    if (entry.status === 'pending') return { state: 'pending' };
    if (entry.response !== undefined) return { state: 'replay', response: entry.response };
    return { state: 'pending' };
  }

  reserveSemantic(requestId: string, fingerprint: string, requestHash: string): void {
    const current = this.checkSemantic(requestId, fingerprint);
    if (current.state !== 'miss') {
      throw new Error(`Cannot reserve idempotency request in state ${current.state}`);
    }
    this.data.idempotency.push({
      requestId,
      fingerprint,
      requestHash,
      status: 'pending',
      storedAt: Date.now(),
    });
    this.dirty = true;
  }

  storeIdempotentResponse(
    hash: string,
    response: unknown,
    requestId?: string,
    fingerprint?: string,
  ): void {
    this.prune();
    const existing = requestId
      ? this.data.idempotency.findIndex((entry) => entry.requestId === requestId)
      : this.data.idempotency.findIndex((entry) => entry.requestHash === hash);
    const entry: IdempotencyEntry = {
      requestHash: hash,
      ...(requestId ? { requestId } : {}),
      ...(fingerprint ? { fingerprint } : {}),
      status: 'completed',
      response,
      storedAt: Date.now(),
    };
    if (existing >= 0) {
      this.data.idempotency[existing] = entry;
    } else {
      this.data.idempotency.push(entry);
    }
    this.dirty = true;
  }
}

// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/idempotency.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRuntimeConfig } from '../../../../src/supervisor/configuration/config.js';
import { semanticRequestFingerprint } from '../../../../src/protocol/canonical/canonical.js';
import { ReplayStore } from '../../../../src/state/replay/store.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeStore(): { store: ReplayStore; stateRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'se-z-idempotency-'));
  roots.push(root);
  const stateRoot = join(root, 'state');
  const config = loadRuntimeConfig({
    stateRoot,
    configRoot: join(root, 'config'),
    nonceRetentionMs: 60_000,
    idempotencyRetentionMs: 60_000,
  });
  return { store: new ReplayStore(config), stateRoot };
}

describe('semantic request fingerprint', () => {
  const base = {
    protocolVersion: '1.0.0',
    operation: 'sez.file.write',
    principal: { subject: 'stealtheye-owner', authorityClass: 'unrestricted-owner' },
    targetHost: 'vps-c9f04f5e',
    payload: { path: '/tmp/a', data: 'alpha', encoding: 'utf8' },
    binaryLength: 0,
  };

  it('is stable across caller retry metadata', () => {
    assert.equal(semanticRequestFingerprint(base), semanticRequestFingerprint({ ...base }));
  });

  it('changes when the logical payload changes', () => {
    assert.notEqual(
      semanticRequestFingerprint(base),
      semanticRequestFingerprint({ ...base, payload: { ...base.payload, data: 'beta' } }),
    );
  });
});

describe('strict semantic idempotency', () => {
  it('reserves, reports pending, completes, and replays', () => {
    const { store } = makeStore();
    assert.deepEqual(store.checkSemantic('request-1', 'fingerprint-a'), { state: 'miss' });
    store.reserveSemantic('request-1', 'fingerprint-a', 'hash-a');
    assert.deepEqual(store.checkSemantic('request-1', 'fingerprint-a'), { state: 'pending' });
    const response = { requestId: 'request-1', result: { ok: true } };
    store.storeIdempotentResponse('hash-a', response, 'request-1', 'fingerprint-a');
    assert.deepEqual(store.checkSemantic('request-1', 'fingerprint-a'), {
      state: 'replay',
      response,
    });
    assert.deepEqual(store.getIdempotentResponse('hash-a'), response);
  });

  it('rejects one request ID reused for another logical payload', () => {
    const { store } = makeStore();
    store.reserveSemantic('request-2', 'fingerprint-a', 'hash-a');
    assert.deepEqual(store.checkSemantic('request-2', 'fingerprint-b'), {
      state: 'conflict',
      existingFingerprint: 'fingerprint-a',
    });
  });

  it('persists semantic reservations and responses atomically', () => {
    const { store, stateRoot } = makeStore();
    store.reserveSemantic('request-3', 'fingerprint-a', 'hash-a');
    store.persist();
    const path = join(stateRoot, 'replay-store.json');
    assert.equal(existsSync(path), true);
    const pending = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(pending.version, 2);
    assert.equal(pending.idempotency[0].status, 'pending');

    const response = { requestId: 'request-3', result: 'done' };
    store.storeIdempotentResponse('hash-b', response, 'request-3', 'fingerprint-a');
    store.persist();
    const completed = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(completed.idempotency[0].status, 'completed');
    assert.deepEqual(completed.idempotency[0].response, response);
    assert.equal(existsSync(`${path}.tmp-${process.pid}`), false);
  });

  it('preserves legacy exact-hash entries during migration', () => {
    const { store } = makeStore();
    const response = { legacy: true };
    store.storeIdempotentResponse('legacy-hash', response);
    assert.deepEqual(store.getIdempotentResponse('legacy-hash'), response);
  });
});

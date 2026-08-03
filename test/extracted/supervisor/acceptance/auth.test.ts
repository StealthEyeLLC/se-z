// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:acceptance/auth.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestServer, stopTestServer, type TestServerContext } from '../unit/helpers/server.js';
import { createTestClient, type SezTestClient } from '../unit/helpers/client.js';
import { buildOwnerPrincipal } from '../../../../src/supervisor/dispatch/auth/principal.js';
import { ReplayStore } from '../../../../src/state/replay/store.js';
import { loadRuntimeConfig } from '../../../../src/supervisor/configuration/config.js';

describe('acceptance: auth adversarial', () => {
  let ctx: TestServerContext;
  let client: SezTestClient;

  before(async () => {
    ctx = await startTestServer();
    client = createTestClient(ctx);
  });

  after(async () => {
    await stopTestServer(ctx);
  });

  it('rejects invalid subject', async () => {
    await client.expectError('sez.health', {}, 'invalid_subject', {
      principal: buildOwnerPrincipal({ subject: 'wrong-subject' }),
    });
  });

  it('rejects invalid issuer', async () => {
    await client.expectError('sez.health', {}, 'invalid_issuer', {
      principal: buildOwnerPrincipal({ issuer: 'https://evil.example' }),
    });
  });

  it('rejects non-null workspace authority', async () => {
    await client.expectError('sez.health', {}, 'invalid_workspace_authority', {
      principal: { ...buildOwnerPrincipal(), workspaceAuthority: 'workspace' as never },
    });
  });

  it('rejects expired timestamp', async () => {
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await client.expectError('sez.health', {}, 'request_expired', { timestamp: old });
  });

  it('rejects replayed nonce after successful request', async () => {
    const nonce = randomUUID();
    await client.request('sez.health', {}, { nonce });
    await client.expectError('sez.health', {}, 'replay_detected', { nonce });
  });

  it('rejects missing owner principal fingerprint', async () => {
    await client.expectError('sez.health', {}, 'invalid_principal_fingerprint', {
      principal: buildOwnerPrincipal({ principalFingerprint: 'deadbeef' }),
    });
  });

  it('returns cached idempotent response for exact retry', async () => {
    const requestId = randomUUID();
    const nonce = randomUUID();
    const timestamp = new Date().toISOString();
    const first = await client.request('sez.health', {}, { requestId, nonce, timestamp });
    const second = await client.request('sez.health', {}, { requestId, nonce, timestamp });
    assert.equal(first.requestId, second.requestId);
    assert.deepEqual(first.result, second.result);
  });
});

describe('acceptance: replay store ordering', () => {
  it('stores idempotent responses after authenticated execution', () => {
    const store = new ReplayStore(loadRuntimeConfig({ stateRoot: '/tmp/bq-replay-order', expectedMachineIdSha256: 'test' }));
    const hash = 'semantic-hash-1';
    store.storeIdempotentResponse(hash, { ok: true });
    assert.equal(store.getIdempotentResponse(hash)?.ok, true);
    assert.ok(store.tryCommitNonce('fresh-nonce'));
    assert.ok(!store.tryCommitNonce('fresh-nonce'));
  });
});

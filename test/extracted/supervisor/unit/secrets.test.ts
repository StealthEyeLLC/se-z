// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/secrets.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MapSecretProvider,
  resolveEnvironment,
  toPersistedSecretReference,
} from '../../../../src/supervisor/configuration/credentials/provider.js';
import { redactSecrets } from '../../../../src/protocol/canonical/canonical.js';

const CANARY = 'se-z-canary-secret-value-7f3a9c2d';

describe('secret references', () => {
  it('resolves references and persists redacted metadata only', async () => {
    const provider = new MapSecretProvider(new Map([['github:test_canary', CANARY]]));
    const resolved = await resolveEnvironment(
      [{ name: 'GH_TOKEN', secretReference: 'github:test_canary' }],
      provider,
    );
    assert.equal(resolved.env.GH_TOKEN, CANARY);
    assert.deepEqual(resolved.persisted, [
      toPersistedSecretReference('GH_TOKEN', 'github:test_canary'),
    ]);
    assert.ok(!JSON.stringify(resolved.persisted).includes(CANARY));
  });

  it('rejects secret-like literal environment names while allowing ordinary literals', async () => {
    const provider = new MapSecretProvider(new Map());
    await assert.rejects(
      resolveEnvironment([{ name: 'GH_TOKEN', value: 'literal-secret' }], provider),
      /must use secretReference/u,
    );
    const ordinary = await resolveEnvironment([{ name: 'NODE_ENV', value: 'test' }], provider);
    assert.deepEqual(ordinary, {
      env: { NODE_ENV: 'test' },
      persisted: [{ name: 'NODE_ENV', value: 'test' }],
    });
  });

  it('redacts secret-like fields', () => {
    const redacted = redactSecrets({
      environment: [{ name: 'GH_TOKEN', secretReference: 'github:test', redacted: true }],
      token: CANARY,
    });
    const serialized = JSON.stringify(redacted);
    assert.ok(!serialized.includes(CANARY));
    assert.match(serialized, /REDACTED/);
  });
});

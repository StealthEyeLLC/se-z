// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/deployment-schemas.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEPLOYMENT_STATES } from '../../../../src/releases/deployment/types.js';

const schemaRoot = join(import.meta.dirname, '..', '..', '..', '..', 'test', 'extracted', 'supervisor', 'fixtures', 'source-adapted', 'schemas', 'deployment-v2');

function load(name: string): Record<string, any> {
  return JSON.parse(readFileSync(join(schemaRoot, name), 'utf8')) as Record<string, any>;
}

describe('deployment v2 schemas', () => {
  it('publishes a strict, uniquely identified schema set', () => {
    const files = readdirSync(schemaRoot).filter((name) => name.endsWith('.schema.json')).sort();
    assert.deepEqual(files, [
      'compatibility-declaration.schema.json',
      'deployment-evidence.schema.json',
      'deployment-request.schema.json',
      'deployment-state.schema.json',
      'release-manifest.schema.json',
      'rollback-snapshot.schema.json',
      'success-marker.schema.json',
    ]);
    const schemas = files.map(load);
    assert.equal(new Set(schemas.map((schema) => schema.$id)).size, schemas.length);
    for (const schema of schemas) {
      assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
      assert.equal(schema.type, 'object');
      assert.equal(schema.additionalProperties, false);
      assert.equal(schema.properties.schemaVersion.const, '2.0.0');
    }
  });

  it('keeps executable and schema state inventories byte-for-byte aligned', () => {
    const schema = load('deployment-state.schema.json');
    assert.deepEqual(schema.$defs.state.enum, DEPLOYMENT_STATES);
  });

  it('binds immutable release identity, reproducibility, native layout, and exclusions', () => {
    const schema = load('release-manifest.schema.json');
    for (const required of [
      'recordVersion',
      'commit',
      'tree',
      'sourceDateEpoch',
      'lockfileDigest',
      'nodeVersion',
      'buildCommandDigest',
      'environmentIdentity',
      'archive',
      'files',
      'sbom',
      'reproducibility',
      'manifestDigest',
      'compatibilityDigest',
      'stateMigration',
      'rollback',
      'peerCompatibility',
      'signatureAlgorithm',
      'signingKeyId',
      'signature',
    ]) assert.ok(schema.required.includes(required), required);
    assert.equal(schema.properties.nodeVersion.const, '24.18.0');
    assert.equal(schema.properties.signatureAlgorithm.const, 'ed25519');
    assert.deepEqual(schema.properties.releaseVersion.not.enum, ['0.2.1', '0.2.2']);
    assert.equal(schema.properties.archive.properties.strictProfile.const, 'se-z-bounded-link-free-v2');
    assert.equal(schema.properties.nativeAddon.properties.path.const, 'lib/build/Release/peer_cred.node');
    assert.equal(schema.properties.reproducibility.properties.byteIdentical.const, true);
  });

  it('binds coordinated order, legacy compatibility, rollback, and terminal success', () => {
    const compatibility = load('compatibility-declaration.schema.json');
    assert.equal(compatibility.properties.activationOrder.prefixItems[0].const, 'se-z-gateway');
    assert.equal(compatibility.properties.activationOrder.prefixItems[1].const, 'se-z');
    assert.equal(compatibility.properties.legacyWindow.properties.sezRelease.const, '0.1.3');
    assert.equal(compatibility.properties.legacyWindow.properties.operationCount.const, 26);

    const marker = load('success-marker.schema.json');
    for (const binding of [
      'deploymentId',
      'generation',
      'machineId',
      'planDigest',
      'snapshotDigest',
      'sezManifestDigest',
      'gatewayManifestDigest',
      'compatibilityDigest',
      'evidenceIndexDigest',
      'guardRecordDigest',
      'deadline',
      'markerDigest',
      'signingKeyId',
      'signature',
    ]) assert.ok(marker.required.includes(binding), binding);
  });

  it('keeps private recovery material reference-only in redacted records', () => {
    const snapshotText = readFileSync(join(schemaRoot, 'rollback-snapshot.schema.json'), 'utf8');
    const snapshot = JSON.parse(snapshotText) as Record<string, any>;
    assert.deepEqual(
      snapshot.properties.privateRecoveryPayload.required,
      ['artifactReference', 'digest', 'rootOnly'],
    );
    assert.equal(snapshot.properties.privateRecoveryPayload.properties.rootOnly.const, true);
    assert.doesNotMatch(snapshotText, /privateKey|clientSecret|refreshToken|bearerToken/u);
    const evidence = load('deployment-evidence.schema.json');
    assert.equal(evidence.$defs.entry.properties.redacted.const, true);
  });
});

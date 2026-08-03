// New se-z Phase 1 differential parity test. Source identities are pinned in vendor/baby-provenance/source-identities.json.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { identityNormalize, SOURCE_SUPERVISOR_ROOT, sourceSupervisor, target } from '../helpers/index.js';

const proofSkillRoot = join(SOURCE_SUPERVISOR_ROOT, 'examples/skills/proof-echo');

async function loaders() {
  return {
    source: await sourceSupervisor('src/skills/loader.ts'),
    target: await target('src/skills/loader.ts'),
  };
}

test('skill manifest validation and exported mechanics remain mechanically equivalent', async () => {
  const { source, target: targetLoader } = await loaders();
  const sourceManifest = JSON.parse(readFileSync(join(proofSkillRoot, 'skill.json'), 'utf8'));
  const targetManifest = identityNormalize(sourceManifest);
  assert.deepEqual(identityNormalize(source.validateSkillManifest(sourceManifest)), targetLoader.validateSkillManifest(targetManifest));
  assert.deepEqual(
    Object.keys(source).filter((key) => typeof source[key] === 'function').sort(),
    Object.keys(targetLoader).filter((key) => typeof targetLoader[key] === 'function').sort(),
  );
  assert.equal(source.normalizeRelativePath('nested\\handler.mjs'), 'nested/handler.mjs');
  assert.equal(targetLoader.normalizeRelativePath('nested\\handler.mjs'), 'nested/handler.mjs');
  for (const loader of [source, targetLoader]) {
    assert.throws(() => loader.normalizeRelativePath('../escape'), /invalid|relative|normalized/iu);
    assert.throws(() => loader.validateSkillManifest({ ...targetManifest, unexpected: true }), /unknown|unexpected|property/iu);
  }
});

test('bundle identity is deterministic, byte-sensitive, verifiable, and catalog-neutral when no set is active', async () => {
  const { source, target: targetLoader } = await loaders();
  const roots = [mkdtempSync(join(tmpdir(), 'sez-parity-source-skill-')), mkdtempSync(join(tmpdir(), 'sez-parity-target-skill-'))];
  try {
    const sourceManifest = JSON.parse(readFileSync(join(proofSkillRoot, 'skill.json'), 'utf8'));
    const targetManifest = identityNormalize(sourceManifest);
    const handler = readFileSync(join(proofSkillRoot, 'index.mjs'), 'utf8');
    for (const [index, manifest] of [sourceManifest, targetManifest].entries()) {
      mkdirSync(roots[index], { recursive: true });
      writeFileSync(join(roots[index], 'skill.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      writeFileSync(join(roots[index], 'index.mjs'), handler);
    }
    const sourceDescription = source.describeBundleDirectory(roots[0]);
    const targetDescription = targetLoader.describeBundleDirectory(roots[1]);
    assert.deepEqual(
      sourceDescription.map((entry: any) => ({ path: entry.path, mode: entry.mode })),
      targetDescription.map((entry: any) => ({ path: entry.path, mode: entry.mode })),
    );
    const sourceDigest = source.bundleDigest(sourceDescription);
    const targetDigest = targetLoader.bundleDigest(targetDescription);
    assert.match(sourceDigest, /^[a-f0-9]{64}$/u);
    assert.match(targetDigest, /^[a-f0-9]{64}$/u);
    assert.equal(source.bundleDigest(source.describeBundleDirectory(roots[0])), sourceDigest);
    assert.equal(targetLoader.bundleDigest(targetLoader.describeBundleDirectory(roots[1])), targetDigest);
    assert.deepEqual(source.verifyBundleDirectory(roots[0], sourceDigest), sourceDescription);
    assert.deepEqual(targetLoader.verifyBundleDirectory(roots[1], targetDigest), targetDescription);
    writeFileSync(join(roots[0], 'index.mjs'), `${handler}\n// byte change\n`);
    writeFileSync(join(roots[1], 'index.mjs'), `${handler}\n// byte change\n`);
    assert.notEqual(source.bundleDigest(source.describeBundleDirectory(roots[0])), sourceDigest);
    assert.notEqual(targetLoader.bundleDigest(targetLoader.describeBundleDirectory(roots[1])), targetDigest);

    const sourceDefinitions = (await sourceSupervisor('src/operations/definitions.ts')).OPERATION_DEFINITIONS;
    const targetDefinitions = (await target('src/operations/definitions.ts')).OPERATION_DEFINITIONS;
    const sourceInactive = await source.loadPackageSetFromPath(null, sourceDefinitions, roots[0]);
    const targetInactive = await targetLoader.loadPackageSetFromPath(null, targetDefinitions, roots[1]);
    assert.equal(sourceInactive.setDigest, null);
    assert.equal(targetInactive.setDigest, null);
    assert.equal(sourceInactive.definitions.length, 0);
    assert.equal(targetInactive.definitions.length, 0);
    assert.equal(sourceInactive.catalogDigest, source.catalogDigest(sourceDefinitions));
    assert.equal(targetInactive.catalogDigest, targetLoader.catalogDigest(targetDefinitions));
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

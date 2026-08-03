import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateEd25519PemPair } from '../../src/kernel/crypto.mjs';
import { MAX_FRAME_SIZE } from '../../src/kernel/util.mjs';

export async function tempDirectory(prefix = 'se-z-test-') { return await fsp.mkdtemp(path.join(os.tmpdir(), prefix)); }
export async function writeKeyPair(directory, name) {
  const pair = generateEd25519PemPair();
  const privatePath = path.join(directory, `${name}.private.pem`);
  const publicPath = path.join(directory, `${name}.public.pem`);
  await fsp.writeFile(privatePath, pair.privateKeyPem, { mode: 0o600 });
  await fsp.writeFile(publicPath, pair.publicKeyPem, { mode: 0o644 });
  return { ...pair, privatePath, publicPath, privateKey: crypto.createPrivateKey(pair.privateKeyPem), publicKey: crypto.createPublicKey(pair.publicKeyPem) };
}
export async function makeGeneration(directory, value = 1) {
  const file = path.join(directory, 'authority-generation.json');
  await fsp.writeFile(file, `${JSON.stringify({ schemaVersion: 1, authorityGeneration: value, owner: 'se-z-recovery', initializedAt: '2026-08-03T00:00:00.000Z', bootstrapRole: 'test-only' })}\n`);
  return file;
}
export function testConfig(root, keys, overrides = {}) {
  const stateRoot = path.join(root, 'state');
  const runtimeRoot = path.join(root, 'run');
  return {
    stateRoot, runtimeRoot, localSocket: path.join(runtimeRoot, 'local.sock'), gatewaySocket: path.join(runtimeRoot, 'gateway.sock'),
    localOperatorGroup: 'root', gatewayUid: 65534, gatewayGid: 65534,
    gatewayExecutable: process.execPath, gatewayId: 'se-z-gateway',
    gatewayVerificationKeys: [{ id: 'gateway-test-v1', path: keys.gateway.publicPath, gatewayId: 'se-z-gateway' }],
    receiptSigningCredential: keys.receipt.privatePath,
    receiptVerificationKeys: [{ id: 'receipt-test-v1', path: keys.receipt.publicPath }],
    authorityGenerationPath: keys.generationPath, maximumFrameSize: MAX_FRAME_SIZE, inlineOutputLimit: 4096,
    streamPageLimit: 1024 * 1024, requestMaximumAgeMs: 5 * 60 * 1000, requestFutureSkewMs: 30_000,
    replayRetentionMs: 60_000, jobReconciliation: 'systemd-or-process-truth', artifactRoot: path.join(stateRoot, 'artifacts'),
    ptyRoot: path.join(stateRoot, 'ptys'), serverId: 'se-z-test-supervisor', releaseIdentity: { product: 'se-z', releaseMilestone: '0.1A', sourceCommit: 'test', sourceTree: 'test' },
    buildIdentity: { sourceCommit: 'test', sourceTree: 'test' }, nativeAddonPath: overrides.nativeAddonPath ?? '/tmp/nonexistent-peercred.node',
    jobRunnerPath: overrides.jobRunnerPath ?? path.resolve('src/kernel/job-runner.mjs'), nodePath: process.execPath, jobUnitPrefix: 'se-z-test-job',
    testMode: true, directBind: true, faultInjection: {}, ...overrides,
  };
}
export async function testKeys(root) {
  const gateway = await writeKeyPair(root, 'gateway');
  const receipt = await writeKeyPair(root, 'receipt');
  const generationPath = await makeGeneration(root);
  return { gateway, receipt, generationPath };
}

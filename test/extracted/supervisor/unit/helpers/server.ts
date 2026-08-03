// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/helpers/server.ts; exact lineage in vendor/baby-provenance/file-map.json.
/** Shared test server lifecycle. */

import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hostname } from 'node:os';
import { loadRuntimeConfig, publicKeyFingerprint } from '../../../../../src/supervisor/configuration/config.js';
import { SezServer } from '../../../../../src/supervisor/server/server.js';
import { generateEd25519KeyPair } from '../../../../../src/protocol/signatures/signing.js';
import { GATEWAY_AUTHORITY_KEY_ID, SUPERVISOR_RECEIPT_KEY_ID } from '../../../../../src/supervisor/configuration/config.js';
import { setupTestEnv } from './client.js';

export interface TestServerContext {
  dir: string;
  socketPath: string;
  configRoot: string;
  stateRoot: string;
  server: SezServer;
  gatewayPrivateKeyPath: string;
  ownerPrincipalFingerprint: string;
}

export async function startTestServer(
  overrides: Parameters<typeof loadRuntimeConfig>[0] = {},
): Promise<TestServerContext> {
  setupTestEnv();
  const dir = mkdtempSync(join(tmpdir(), 'se-z-test-'));
  const socketPath = join(dir, 'test.sock');
  const configRoot = join(dir, 'config');
  const stateRoot = join(dir, 'state');

  const gatewayPrivateKeyPath = join(configRoot, 'gateway-authority-private.pem');
  const gatewayPublicKeyPath = join(configRoot, 'gateway-authority-public.pem');
  generateEd25519KeyPair({
    publicKeyPath: gatewayPublicKeyPath,
    privateKeyPath: gatewayPrivateKeyPath,
    keyId: GATEWAY_AUTHORITY_KEY_ID,
  });

  generateEd25519KeyPair({
    publicKeyPath: join(configRoot, 'supervisor-receipt-public.pem'),
    privateKeyPath: join(configRoot, 'supervisor-receipt-private.pem'),
    keyId: SUPERVISOR_RECEIPT_KEY_ID,
  });

  const ownerPrincipalFingerprint = publicKeyFingerprint(gatewayPublicKeyPath);

  const config = loadRuntimeConfig({
    socketPath,
    stateRoot,
    configRoot,
    expectedMachineIdSha256: 'test',
    expectedHostname: hostname(),
    ownerPrincipalFingerprint,
    skipPeerCredCheck: true,
    ...overrides,
  });

  const server = new SezServer(config);
  await server.start();

  return {
    dir,
    socketPath,
    configRoot,
    stateRoot,
    server,
    gatewayPrivateKeyPath,
    ownerPrincipalFingerprint,
  };
}

export async function stopTestServer(ctx: TestServerContext): Promise<void> {
  await ctx.server.stop();
  rmSync(ctx.dir, { recursive: true, force: true });
}

/** Restart server reusing persisted state (socket, config, state roots). */
export async function restartTestServer(ctx: TestServerContext): Promise<void> {
  await ctx.server.stop();

  const config = loadRuntimeConfig({
    socketPath: ctx.socketPath,
    stateRoot: ctx.stateRoot,
    configRoot: ctx.configRoot,
    expectedMachineIdSha256: 'test',
    expectedHostname: hostname(),
    ownerPrincipalFingerprint: ctx.ownerPrincipalFingerprint,
    skipPeerCredCheck: true,
  });

  const server = new SezServer(config);
  await server.start();
  ctx.server = server;
}

export function installGatewayPublicKey(ctx: TestServerContext, pemPath: string): void {
  copyFileSync(pemPath, join(ctx.configRoot, 'gateway-authority-public.pem'));
}

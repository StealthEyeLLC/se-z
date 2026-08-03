#!/usr/bin/env node
// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** se-z verifier — checks installation health. */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { DEFAULTS, getMachineIdSha256 } from '../configuration/config.js';

interface CheckResult {
  name: string;
  passed: boolean;
  message: string;
}

function check(name: string, passed: boolean, message: string): CheckResult {
  return { name, passed, message };
}

async function verifySocket(socketPath: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(check('socket', false, 'Socket connection timeout'));
    }, 5000);

    socket.on('connect', () => {
      clearTimeout(timeout);
      socket.end();
      resolve(check('socket', true, `Socket reachable at ${socketPath}`));
    });

    socket.on('error', (err) => {
      clearTimeout(timeout);
      resolve(check('socket', false, `Socket error: ${err.message}`));
    });
  });
}

async function main(): Promise<void> {
  const results: CheckResult[] = [];

  const configRoot = process.env.SEZ_CONFIG_ROOT ?? DEFAULTS.configRoot;
  const configPath = join(configRoot, 'runtime.json');
  results.push(
    check(
      'config',
      existsSync(configPath),
      existsSync(configPath) ? 'Runtime config present' : 'Runtime config missing',
    ),
  );

  const pubKey = join(configRoot, 'gateway-authority-public.pem');
  const receiptPub = join(configRoot, 'supervisor-receipt-public.pem');
  const receiptPriv = join(configRoot, 'supervisor-receipt-private.pem');
  results.push(
    check(
      'gateway-authority-public',
      existsSync(pubKey),
      existsSync(pubKey) ? 'Gateway public key present' : 'Gateway public key missing',
    ),
  );
  results.push(
    check(
      'supervisor-receipt-public',
      existsSync(receiptPub),
      existsSync(receiptPub) ? 'Supervisor receipt public key present' : 'Supervisor receipt public key missing',
    ),
  );
  results.push(
    check(
      'supervisor-receipt-private',
      existsSync(receiptPriv),
      existsSync(receiptPriv) ? 'Supervisor receipt private key present' : 'Supervisor receipt private key missing',
    ),
  );

  const currentLink = process.env.SEZ_CURRENT_LINK ?? DEFAULTS.currentLink;
  const stateRoot = process.env.SEZ_STATE_ROOT ?? DEFAULTS.stateRoot;
  const socketPath = process.env.SEZ_SOCKET_PATH ?? DEFAULTS.socketPath;

  results.push(
    check(
      'current-release',
      existsSync(currentLink),
      existsSync(currentLink) ? `Current link: ${currentLink}` : 'Current release link missing',
    ),
  );

  results.push(
    check(
      'state-root',
      existsSync(stateRoot),
      existsSync(stateRoot) ? `State root: ${stateRoot}` : 'State root missing',
    ),
  );

  if (existsSync(socketPath)) {
    results.push(await verifySocket(socketPath));
  } else if (process.env.SEZ_SKIP_MACHINE_ID_CHECK === '1') {
    results.push(check('socket', true, 'Socket check skipped (test install mode)'));
  } else {
    results.push(check('socket', false, `Socket not found: ${socketPath}`));
  }

  if (process.env.SEZ_SKIP_MACHINE_ID_CHECK === '1') {
    results.push(check('machine-id', true, 'Machine identity check skipped (test mode)'));
  } else {
    const hash = getMachineIdSha256();
    const expected =
      process.env.SEZ_EXPECTED_MACHINE_ID_SHA256 ?? DEFAULTS.expectedMachineIdSha256;
    const match = hash !== '' && hash === expected;
    results.push(
      check(
        'machine-id',
        match,
        match ? 'Machine identity matches' : `Machine identity mismatch: ${hash || 'unavailable'}`,
      ),
    );
  }

  const allPassed = results.every((r) => r.passed);
  console.log(JSON.stringify({ passed: allPassed, checks: results }, null, 2));
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('Verify failed:', err.message);
  process.exit(1);
});

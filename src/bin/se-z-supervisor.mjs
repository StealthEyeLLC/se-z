#!/usr/bin/env node
import { loadConfig } from '../kernel/config.mjs';
import { AuthorityGenerationProvider } from '../kernel/identity.mjs';
import { KernelState } from '../kernel/state.mjs';
import { KernelOperations } from '../kernel/operations.mjs';
import { SezKernelServer } from '../kernel/server.mjs';
import { sanitizeDiagnostic } from '../kernel/util.mjs';

let server;
async function main() {
  const config = await loadConfig(process.env.SEZ_CONFIG);
  const authority = new AuthorityGenerationProvider(config.authorityGenerationPath);
  const state = new KernelState(config);
  const operations = new KernelOperations(config, state, authority);
  server = new SezKernelServer(config, operations, authority);
  await server.start();
  process.stdout.write(`${JSON.stringify({ component: 'se-z-supervisor', status: 'ready', localSocket: config.localSocket, gatewaySocket: config.gatewaySocket, pid: process.pid })}\n`);
}

async function shutdown(signal) {
  process.stdout.write(`${JSON.stringify({ component: 'se-z-supervisor', status: 'stopping', signal })}\n`);
  await server?.stop().catch(() => {});
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ component: 'se-z-supervisor', status: 'fatal', code: error.code ?? 'internal_error', message: sanitizeDiagnostic(error.message), details: sanitizeDiagnostic(error.details) })}\n`);
  process.exitCode = 1;
});

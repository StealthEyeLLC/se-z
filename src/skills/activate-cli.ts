// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
import { spawnSync } from 'node:child_process';
import { OPERATION_DEFINITIONS } from '../operations/definitions.js';
import { activateRecord, redactActivationError } from './activation.js';
import { SKILL_CURRENT_LINK, SKILL_PREVIOUS_LINK, SKILL_RELEASE_ROOT } from './loader.js';

function restartSez(): number {
  const started = Date.now();
  const result = spawnSync('/usr/bin/systemctl', ['restart', 'se-z.service'], {
    encoding: 'utf8', timeout: 45_000,
  });
  if (result.status !== 0) throw new Error(`se-z.service restart failed: ${result.stderr.trim()}`);
  const active = spawnSync('/usr/bin/systemctl', ['is-active', '--quiet', 'se-z.service'], {
    timeout: 10_000,
  });
  if (active.status !== 0) throw new Error('se-z.service is not active after restart');
  return Date.now() - started;
}

async function httpReadback(): Promise<Record<string, unknown>> {
  const started = Date.now();
  const authorization = await fetch(
    'https://se-z.stealtheye.io/.well-known/oauth-authorization-server',
    { signal: AbortSignal.timeout(10_000) },
  );
  const resource = await fetch(
    'https://se-z.stealtheye.io/.well-known/oauth-protected-resource',
    { signal: AbortSignal.timeout(10_000) },
  );
  const mcp = await fetch('https://se-z.stealtheye.io/mcp', {
    method: 'GET', signal: AbortSignal.timeout(10_000),
  });
  if (authorization.status !== 200 || resource.status !== 200 || mcp.status !== 405) {
    throw new Error(
      `HTTP readback failed: oauth=${authorization.status}, resource=${resource.status}, mcp=${mcp.status}`,
    );
  }
  return {
    oauthAuthorizationServer: 200,
    oauthProtectedResource: 200,
    mcpGet: 405,
    durationMs: Date.now() - started,
  };
}

const recordPath = process.argv[2];
if (recordPath === undefined || !recordPath.startsWith('/var/lib/se-z/skill-deployments/')) {
  throw new Error('canonical deployment record path is required');
}

activateRecord(recordPath, {
  currentLink: SKILL_CURRENT_LINK,
  previousLink: SKILL_PREVIOUS_LINK,
  releaseRoot: SKILL_RELEASE_ROOT,
  coreDefinitions: OPERATION_DEFINITIONS,
  restart: restartSez,
  healthReadback: httpReadback,
  delayMs: 1200,
}).then((record) => {
  if (record.finalState === 'RECOVERY_REQUIRED') process.exitCode = 2;
}).catch((error: unknown) => {
  process.stderr.write(`${redactActivationError(error)}\n`);
  process.exit(1);
});

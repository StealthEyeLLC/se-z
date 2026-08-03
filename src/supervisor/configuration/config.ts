// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** se-z configuration constants and runtime config loader. */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

export const PROTOCOL_VERSION = '1.0.0';
export const CONTRACT_VERSION = '1.2.0';
export const PRODUCT_NAME = 'se-z';
export const FRAME_MAGIC = 'SEZ1';

export const GATEWAY_AUTHORITY_KEY_ID = 'gateway-authority-v1';
export const SUPERVISOR_RECEIPT_KEY_ID = 'supervisor-receipt-v1';

export const DEFAULTS = {
  repository: 'StealthEyeLLC/se-z',
  defaultBranch: 'main',
  workBranch: 'cursor/se-z-core-e857',
  gitRemote: 'https://github.com/StealthEyeLLC/se-z.git',
  vpsHost: '51.81.86.225',
  vpsPort: 22,
  vpsUser: 'ubuntu',
  expectedHostname: 'vps-c9f04f5e',
  expectedMachineIdSha256:
    'cd189817b39fea60d338b73878240a6fe7db71374c7a0f35ad60f8eb641e8817',
  nodePath: '/opt/node-v24.18.0-linux-x64/bin/node',
  serviceName: 'se-z.service',
  socketPath: '/run/se-z/gateway.sock',
  socketGroup: 'se-z',
  socketMode: 0o660,
  gatewayUser: 'se-z-gateway',
  gatewayUid: 997,
  releaseRoot: '/opt/se-z/releases',
  currentLink: '/opt/se-z/current',
  previousLink: '/opt/se-z/previous',
  stateRoot: '/var/lib/se-z',
  configRoot: '/etc/se-z',
  gatewayId: 'stealtheye-sez-gateway',
  supervisorId: 'se-z-supervisor',
  expectedSubject: 'stealtheye-owner',
  authorityClass: 'unrestricted-owner',
  oauthIssuer: 'https://se-z.stealtheye.io',
  oauthResource: 'https://se-z.stealtheye.io/mcp',
  oauthJwksUri: 'https://se-z.stealtheye.io/oauth/jwks.json',
  maxFrameSize: 16 * 1024 * 1024,
  maxOutputBytes: 64 * 1024 * 1024,
  maxJobQueue: 256,
  maxRetentionJobs: 1024,
  requestMaxAgeMs: 5 * 60 * 1000,
  nonceRetentionMs: 24 * 60 * 60 * 1000,
  idempotencyRetentionMs: 24 * 60 * 60 * 1000,
  streamChunkSize: 64 * 1024,
  maxArchiveBytes: 512 * 1024 * 1024,
  maxArchiveFileBytes: 256 * 1024 * 1024,
} as const;

export interface RuntimeConfig {
  socketPath: string;
  socketGroup: string;
  socketMode: number;
  stateRoot: string;
  configRoot: string;
  gatewayId: string;
  supervisorId: string;
  expectedSubject: string;
  authorityClass: string;
  expectedHostname: string;
  expectedMachineIdSha256: string;
  oauthIssuer: string;
  oauthResource: string;
  oauthJwksUri: string;
  gatewayAuthorityPublicKeyPath: string;
  gatewayAuthorityPrivateKeyPath: string;
  gatewayAuthorityKeyId: string;
  supervisorReceiptPrivateKeyPath: string;
  supervisorReceiptPublicKeyPath: string;
  supervisorReceiptKeyId: string;
  ownerPrincipalFingerprint: string;
  previousGatewayAuthorityPublicKeyPath?: string;
  gatewayUid: number;
  skipPeerCredCheck: boolean;
  maxFrameSize: number;
  maxOutputBytes: number;
  maxJobQueue: number;
  maxRetentionJobs: number;
  requestMaxAgeMs: number;
  nonceRetentionMs: number;
  idempotencyRetentionMs: number;
}

export function loadRuntimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  const env = process.env;
  const configRoot = overrides.configRoot ?? env.SEZ_CONFIG_ROOT ?? DEFAULTS.configRoot;
  const stateRoot = overrides.stateRoot ?? env.SEZ_STATE_ROOT ?? DEFAULTS.stateRoot;

  const base: RuntimeConfig = {
    socketPath: env.SEZ_SOCKET_PATH ?? DEFAULTS.socketPath,
    socketGroup: env.SEZ_SOCKET_GROUP ?? DEFAULTS.socketGroup,
    socketMode: env.SEZ_SOCKET_MODE
      ? parseInt(env.SEZ_SOCKET_MODE, 8)
      : DEFAULTS.socketMode,
    stateRoot,
    configRoot,
    gatewayId: env.SEZ_GATEWAY_ID ?? DEFAULTS.gatewayId,
    supervisorId: env.SEZ_SUPERVISOR_ID ?? DEFAULTS.supervisorId,
    expectedSubject: env.SEZ_EXPECTED_SUBJECT ?? DEFAULTS.expectedSubject,
    authorityClass: DEFAULTS.authorityClass,
    expectedHostname: env.SEZ_EXPECTED_HOSTNAME ?? DEFAULTS.expectedHostname,
    expectedMachineIdSha256:
      env.SEZ_EXPECTED_MACHINE_ID_SHA256 ?? DEFAULTS.expectedMachineIdSha256,
    oauthIssuer: env.SEZ_OAUTH_ISSUER ?? DEFAULTS.oauthIssuer,
    oauthResource: env.SEZ_OAUTH_RESOURCE ?? DEFAULTS.oauthResource,
    oauthJwksUri: env.SEZ_OAUTH_JWKS_URI ?? DEFAULTS.oauthJwksUri,
    gatewayAuthorityPublicKeyPath: `${configRoot}/gateway-authority-public.pem`,
    gatewayAuthorityPrivateKeyPath: `${configRoot}/gateway-authority-private.pem`,
    gatewayAuthorityKeyId: GATEWAY_AUTHORITY_KEY_ID,
    supervisorReceiptPrivateKeyPath: `${configRoot}/supervisor-receipt-private.pem`,
    supervisorReceiptPublicKeyPath: `${configRoot}/supervisor-receipt-public.pem`,
    supervisorReceiptKeyId: SUPERVISOR_RECEIPT_KEY_ID,
    ownerPrincipalFingerprint: env.SEZ_OWNER_PRINCIPAL_FINGERPRINT ?? '',
    previousGatewayAuthorityPublicKeyPath: undefined,
    gatewayUid: env.SEZ_GATEWAY_UID
      ? parseInt(env.SEZ_GATEWAY_UID, 10)
      : DEFAULTS.gatewayUid,
    skipPeerCredCheck:
      overrides.skipPeerCredCheck ??
      (env.SEZ_SKIP_PEER_CRED === '1' || env.SEZ_TEST_MODE === '1'),
    maxFrameSize: DEFAULTS.maxFrameSize,
    maxOutputBytes: DEFAULTS.maxOutputBytes,
    maxJobQueue: DEFAULTS.maxJobQueue,
    maxRetentionJobs: DEFAULTS.maxRetentionJobs,
    requestMaxAgeMs: DEFAULTS.requestMaxAgeMs,
    nonceRetentionMs: DEFAULTS.nonceRetentionMs,
    idempotencyRetentionMs: DEFAULTS.idempotencyRetentionMs,
  };

  return { ...base, ...overrides, configRoot, stateRoot };
}

export function normalizeMachineId(raw: Buffer | string): string {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  return text.replace(/[\r\n]/g, '');
}

export function machineIdSha256(raw: Buffer | string): string {
  const normalized = normalizeMachineId(raw);
  if (!normalized) return '';
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function getMachineIdSha256(): string {
  try {
    return machineIdSha256(readFileSync('/etc/machine-id'));
  } catch {
    return '';
  }
}

export function getHostname(): string {
  return hostname();
}

export function publicKeyFingerprint(pemPath: string): string {
  const pem = readFileSync(pemPath);
  return createHash('sha256').update(pem).digest('hex');
}

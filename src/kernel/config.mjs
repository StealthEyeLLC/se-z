import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  MAX_FRAME_SIZE,
  DEFAULT_INLINE_LIMIT,
  DEFAULT_STREAM_PAGE_LIMIT,
  KERNEL_VERSION,
  RELEASE_MILESTONE,
  STATE_SCHEMA_VERSION,
  SezError,
  assertExactKeys,
  readMachineIdHash,
} from './util.mjs';

const CONFIG_KEYS = [
  'stateRoot', 'runtimeRoot', 'localSocket', 'gatewaySocket', 'localOperatorGroup',
  'gatewayUid', 'gatewayGid', 'gatewayExecutable', 'gatewayId', 'gatewayVerificationKeys',
  'receiptSigningCredential', 'receiptVerificationKeys', 'authorityGenerationPath',
  'maximumFrameSize', 'inlineOutputLimit', 'streamPageLimit', 'requestMaximumAgeMs',
  'requestFutureSkewMs', 'replayRetentionMs', 'jobReconciliation', 'artifactRoot',
  'ptyRoot', 'serverId', 'releaseIdentity', 'buildIdentity', 'nativeAddonPath',
  'jobRunnerPath', 'nodePath', 'jobUnitPrefix', 'testMode', 'directBind', 'faultInjection',
];

function requireAbsolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new SezError('invalid_request', `${name} must be an absolute path`);
  return path.normalize(value);
}

function requireString(value, name, minimum = 1) {
  if (typeof value !== 'string' || value.length < minimum) throw new SezError('invalid_request', `${name} must be a nonempty string`);
  return value;
}

function requireInteger(value, name, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new SezError('invalid_request', `${name} must be an integer in range`);
  return value;
}

function validateKeyArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) throw new SezError('invalid_request', `${name} must be a nonempty array`);
  const ids = new Set();
  return value.map((entry) => {
    assertExactKeys(entry, ['id', 'path'], ['gatewayId'], `${name} entry`);
    const id = requireString(entry.id, `${name}.id`);
    if (ids.has(id)) throw new SezError('invalid_request', `Duplicate ${name} key ID: ${id}`);
    ids.add(id);
    return {
      id,
      path: requireAbsolute(entry.path, `${name}.path`),
      ...(entry.gatewayId === undefined ? {} : { gatewayId: requireString(entry.gatewayId, `${name}.gatewayId`) }),
    };
  });
}

export function resolveCredentialPath(config) {
  if (path.isAbsolute(config.receiptSigningCredential)) return config.receiptSigningCredential;
  const directory = process.env.CREDENTIALS_DIRECTORY;
  if (!directory) throw new SezError('internal_error', 'CREDENTIALS_DIRECTORY is required for the configured receipt signing credential');
  return path.join(directory, config.receiptSigningCredential);
}

export async function loadConfig(configPath = process.env.SEZ_CONFIG ?? '/etc/se-z/config.json') {
  let raw;
  try {
    raw = JSON.parse(await fsp.readFile(configPath, 'utf8'));
  } catch (error) {
    throw new SezError('invalid_request', `Unable to load strict se-z configuration: ${error.message}`, { configPath });
  }
  return await validateConfig(raw, configPath);
}

export async function validateConfig(raw, configPath = '<memory>') {
  assertExactKeys(raw, CONFIG_KEYS, [], 'configuration');
  const stateRoot = requireAbsolute(raw.stateRoot, 'stateRoot');
  const runtimeRoot = requireAbsolute(raw.runtimeRoot, 'runtimeRoot');
  const config = {
    configPath,
    stateRoot,
    runtimeRoot,
    localSocket: requireAbsolute(raw.localSocket, 'localSocket'),
    gatewaySocket: requireAbsolute(raw.gatewaySocket, 'gatewaySocket'),
    localOperatorGroup: requireString(raw.localOperatorGroup, 'localOperatorGroup'),
    gatewayUid: requireInteger(raw.gatewayUid, 'gatewayUid', 1),
    gatewayGid: requireInteger(raw.gatewayGid, 'gatewayGid', 1),
    gatewayExecutable: requireAbsolute(raw.gatewayExecutable, 'gatewayExecutable'),
    gatewayId: requireString(raw.gatewayId, 'gatewayId'),
    gatewayVerificationKeys: validateKeyArray(raw.gatewayVerificationKeys, 'gatewayVerificationKeys'),
    receiptSigningCredential: requireString(raw.receiptSigningCredential, 'receiptSigningCredential'),
    receiptVerificationKeys: validateKeyArray(raw.receiptVerificationKeys, 'receiptVerificationKeys'),
    authorityGenerationPath: requireAbsolute(raw.authorityGenerationPath, 'authorityGenerationPath'),
    maximumFrameSize: requireInteger(raw.maximumFrameSize, 'maximumFrameSize', 1024, MAX_FRAME_SIZE),
    inlineOutputLimit: requireInteger(raw.inlineOutputLimit, 'inlineOutputLimit', 0, 256 * 1024),
    streamPageLimit: requireInteger(raw.streamPageLimit, 'streamPageLimit', 1, 4 * 1024 * 1024),
    requestMaximumAgeMs: requireInteger(raw.requestMaximumAgeMs, 'requestMaximumAgeMs', 1, 24 * 60 * 60 * 1000),
    requestFutureSkewMs: requireInteger(raw.requestFutureSkewMs, 'requestFutureSkewMs', 0, 60 * 60 * 1000),
    replayRetentionMs: requireInteger(raw.replayRetentionMs, 'replayRetentionMs', 1000, 30 * 24 * 60 * 60 * 1000),
    jobReconciliation: requireString(raw.jobReconciliation, 'jobReconciliation'),
    artifactRoot: requireAbsolute(raw.artifactRoot, 'artifactRoot'),
    ptyRoot: requireAbsolute(raw.ptyRoot, 'ptyRoot'),
    serverId: requireString(raw.serverId, 'serverId'),
    releaseIdentity: raw.releaseIdentity,
    buildIdentity: raw.buildIdentity,
    nativeAddonPath: requireAbsolute(raw.nativeAddonPath, 'nativeAddonPath'),
    jobRunnerPath: requireAbsolute(raw.jobRunnerPath, 'jobRunnerPath'),
    nodePath: requireAbsolute(raw.nodePath, 'nodePath'),
    jobUnitPrefix: requireString(raw.jobUnitPrefix, 'jobUnitPrefix'),
    testMode: Boolean(raw.testMode),
    directBind: Boolean(raw.directBind),
    faultInjection: raw.faultInjection ?? {},
  };
  if (config.localSocket === config.gatewaySocket) throw new SezError('invalid_request', 'Local and gateway sockets must be distinct');
  if (!config.artifactRoot.startsWith(`${stateRoot}/`) && config.artifactRoot !== stateRoot) throw new SezError('invalid_request', 'artifactRoot must be within stateRoot');
  if (!config.ptyRoot.startsWith(`${stateRoot}/`) && config.ptyRoot !== stateRoot) throw new SezError('invalid_request', 'ptyRoot must be within stateRoot');
  if (config.maximumFrameSize !== MAX_FRAME_SIZE && !config.testMode) throw new SezError('invalid_request', `Production maximumFrameSize must be exactly ${MAX_FRAME_SIZE}`);
  if (config.jobReconciliation !== 'systemd-or-process-truth') throw new SezError('invalid_request', 'Unsupported jobReconciliation contract');
  if (!raw.releaseIdentity || typeof raw.releaseIdentity !== 'object' || Array.isArray(raw.releaseIdentity)) throw new SezError('invalid_request', 'releaseIdentity must be an object');
  if (!raw.buildIdentity || typeof raw.buildIdentity !== 'object' || Array.isArray(raw.buildIdentity)) throw new SezError('invalid_request', 'buildIdentity must be an object');
  if (!config.testMode && Object.keys(config.faultInjection).length !== 0) throw new SezError('invalid_request', 'faultInjection is forbidden outside explicit test mode');
  if (!fs.existsSync(config.nodePath)) throw new SezError('invalid_request', 'Configured Node executable does not exist', { nodePath: config.nodePath });
  if (!fs.existsSync(config.jobRunnerPath)) throw new SezError('invalid_request', 'Configured job runner does not exist', { jobRunnerPath: config.jobRunnerPath });
  if (!fs.existsSync(config.nativeAddonPath)) throw new SezError('invalid_request', 'Configured native peer credential addon does not exist', { nativeAddonPath: config.nativeAddonPath });
  config.hostIdentity = {
    hostname: os.hostname(),
    machineIdSha256: await readMachineIdHash().catch(() => 'unknown'),
  };
  config.kernelIdentity = {
    product: 'se-z',
    kernelVersion: KERNEL_VERSION,
    releaseMilestone: RELEASE_MILESTONE,
    stateSchemaVersion: STATE_SCHEMA_VERSION,
  };
  return Object.freeze(config);
}

export function defaultConfig(overrides = {}) {
  const stateRoot = overrides.stateRoot ?? '/var/lib/se-z';
  return {
    stateRoot,
    runtimeRoot: '/run/se-z',
    localSocket: '/run/se-z/local.sock',
    gatewaySocket: '/run/se-z/gateway.sock',
    localOperatorGroup: 'se-z',
    gatewayUid: 991,
    gatewayGid: 991,
    gatewayExecutable: '/usr/bin/node',
    gatewayId: 'se-z-gateway',
    gatewayVerificationKeys: [{ id: 'gateway-v1', path: '/etc/se-z/gateway-v1.pub.pem', gatewayId: 'se-z-gateway' }],
    receiptSigningCredential: 'receipt-key.pem',
    receiptVerificationKeys: [{ id: 'receipt-v1', path: '/etc/se-z/receipt-v1.pub.pem' }],
    authorityGenerationPath: '/var/lib/se-z-recovery/authority-generation.json',
    maximumFrameSize: MAX_FRAME_SIZE,
    inlineOutputLimit: DEFAULT_INLINE_LIMIT,
    streamPageLimit: DEFAULT_STREAM_PAGE_LIMIT,
    requestMaximumAgeMs: 5 * 60 * 1000,
    requestFutureSkewMs: 30 * 1000,
    replayRetentionMs: 24 * 60 * 60 * 1000,
    jobReconciliation: 'systemd-or-process-truth',
    artifactRoot: path.join(stateRoot, 'artifacts'),
    ptyRoot: path.join(stateRoot, 'ptys'),
    serverId: 'se-z-supervisor',
    releaseIdentity: { product: 'se-z', version: KERNEL_VERSION, releaseMilestone: RELEASE_MILESTONE },
    buildIdentity: { sourceCommit: 'unknown', sourceTree: 'unknown' },
    nativeAddonPath: '/opt/se-z/current/libexec/native/peer_cred.node',
    jobRunnerPath: '/opt/se-z/current/libexec/kernel/job-runner.mjs',
    nodePath: '/usr/bin/node',
    jobUnitPrefix: 'se-z-job',
    testMode: false,
    directBind: false,
    faultInjection: {},
    ...overrides,
  };
}

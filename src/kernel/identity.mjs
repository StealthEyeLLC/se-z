import { createRequire } from 'node:module';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SezError, readJsonStrict, readProcStartTime, sha256Hex } from './util.mjs';
import { verifyDigestHex, requestDigest } from './crypto.mjs';

const require = createRequire(import.meta.url);
let nativeAddon;
let nativeAddonIdentity;

export async function loadPeerCredentialAddon(addonPath) {
  if (nativeAddon) return nativeAddon;
  try {
    nativeAddon = require(addonPath);
    const stat = await fsp.stat(addonPath);
    nativeAddonIdentity = {
      path: addonPath,
      size: stat.size,
      sha256: sha256Hex(await fsp.readFile(addonPath)),
      api: 'getPeerCred(fd)->{ok,pid,uid,gid}',
    };
    return nativeAddon;
  } catch (error) {
    throw new SezError('internal_error', `Native SO_PEERCRED addon unavailable: ${error.message}`);
  }
}

export function getNativeAddonIdentity() {
  return nativeAddonIdentity ?? null;
}

function socketFd(socket) {
  const fd = socket?._handle?.fd;
  if (!Number.isInteger(fd) || fd < 0) throw new SezError('unauthorized_peer', 'Unable to obtain accepted Unix socket descriptor');
  return fd;
}

export async function getPeerCredential(socket, addonPath) {
  const addon = await loadPeerCredentialAddon(addonPath);
  const result = addon.getPeerCred(socketFd(socket));
  if (!result?.ok || !Number.isInteger(result.pid) || !Number.isInteger(result.uid) || !Number.isInteger(result.gid)) {
    throw new SezError('unauthorized_peer', 'SO_PEERCRED did not return a complete peer identity');
  }
  const startTimeBefore = await readProcStartTime(result.pid).catch(() => null);
  if (startTimeBefore === null) throw new SezError('unauthorized_peer', 'Peer process disappeared before identity validation');
  const executable = await fsp.readlink(`/proc/${result.pid}/exe`).catch(() => null);
  const status = await fsp.readFile(`/proc/${result.pid}/status`, 'utf8').catch(() => null);
  const cgroup = await fsp.readFile(`/proc/${result.pid}/cgroup`, 'utf8').catch(() => null);
  const startTimeAfter = await readProcStartTime(result.pid).catch(() => null);
  if (startTimeAfter === null || startTimeBefore !== startTimeAfter) {
    throw new SezError('unauthorized_peer', 'Peer PID changed during identity validation');
  }
  const groupsLine = status?.split('\n').find((line) => line.startsWith('Groups:')) ?? '';
  const supplementaryGroups = groupsLine.slice('Groups:'.length).trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
  return {
    pid: result.pid,
    uid: result.uid,
    gid: result.gid,
    startTime: startTimeBefore,
    executable,
    supplementaryGroups,
    cgroup: cgroup?.trim() ?? null,
  };
}

export function resolveGroupGid(groupName) {
  try {
    const output = execFileSync('/usr/bin/getent', ['group', groupName], { encoding: 'utf8' }).trim();
    const fields = output.split(':');
    const gid = Number(fields[2]);
    if (!Number.isInteger(gid)) throw new Error('invalid gid');
    return gid;
  } catch {
    throw new SezError('internal_error', `Configured local operator group does not exist: ${groupName}`);
  }
}

export async function authorizePeer({ socketClass, request, peer, config, gatewayKeys }) {
  if (socketClass === 'local') {
    if (request.peerClass !== 'local-peer') throw new SezError('peer_class_mismatch', 'Local socket accepts only local-peer envelopes');
    const operatorGid = resolveGroupGid(config.localOperatorGroup);
    const groupAuthorized = peer.gid === operatorGid || peer.supplementaryGroups.includes(operatorGid);
    if (peer.uid !== 0 && !groupAuthorized) throw new SezError('unauthorized_peer', 'Peer is neither UID 0 nor a genuine member of the local operator group', { pid: peer.pid, uid: peer.uid, gid: peer.gid });
    return { peerClass: 'local-peer', peer, authoritySource: peer.uid === 0 ? 'uid-0' : 'linux-group' };
  }
  if (socketClass !== 'gateway') throw new SezError('peer_class_mismatch', 'Unknown accepted socket class');
  if (request.peerClass !== 'gateway-signed') throw new SezError('peer_class_mismatch', 'Gateway socket accepts only gateway-signed envelopes');
  if (peer.uid !== config.gatewayUid || peer.gid !== config.gatewayGid) {
    throw new SezError('unauthorized_peer', 'Gateway peer UID/GID mismatch', { pid: peer.pid, uid: peer.uid, gid: peer.gid });
  }
  if (path.resolve(peer.executable ?? '') !== path.resolve(config.gatewayExecutable)) {
    throw new SezError('unauthorized_peer', 'Gateway peer executable identity mismatch', { pid: peer.pid, executable: peer.executable });
  }
  if (request.gatewayId !== config.gatewayId) throw new SezError('unknown_gateway', 'Unknown gateway ID');
  const keyDefinition = config.gatewayVerificationKeys.find((entry) => entry.id === request.gatewayKeyId && (entry.gatewayId ?? config.gatewayId) === request.gatewayId);
  if (!keyDefinition) throw new SezError('unknown_key', 'Gateway key ID is not accepted');
  const key = gatewayKeys.get(request.gatewayKeyId);
  if (!key) throw new SezError('unknown_key', 'Gateway verification key is unavailable');
  const digest = requestDigest(request);
  if (!verifyDigestHex(digest, request.signature, key)) throw new SezError('invalid_signature', 'Gateway signature does not verify');
  return { peerClass: 'gateway-signed', peer, gatewayId: request.gatewayId, gatewayKeyId: request.gatewayKeyId, authoritySource: 'peer-and-ed25519' };
}

export class AuthorityGenerationProvider {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async read() {
    const record = await readJsonStrict(this.filePath, 'authority generation');
    const allowed = new Set(['schemaVersion', 'authorityGeneration', 'owner', 'initializedAt', 'bootstrapRole']);
    for (const key of Object.keys(record)) if (!allowed.has(key)) throw new SezError('state_corrupt', `Unknown authority generation field: ${key}`, { path: this.filePath });
    if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.authorityGeneration) || record.authorityGeneration < 1 || record.owner !== 'se-z-recovery') {
      throw new SezError('state_corrupt', 'Authority generation record is invalid', { path: this.filePath });
    }
    return record.authorityGeneration;
  }

  async assertCurrent(requested) {
    const current = await this.read();
    if (requested < current) throw new SezError('stale_generation', 'Request authority generation is stale', { requested, current });
    if (requested > current) throw new SezError('future_generation', 'Request authority generation is from the future', { requested, current });
    return current;
  }
}

// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Unix socket peer credential lookup via Node-API native SO_PEERCRED. */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Socket } from 'node:net';

const require = createRequire(import.meta.url);

interface PeerCredNative {
  getPeerCred(fd: number): { ok: boolean; uid?: number; gid?: number; pid?: number };
}

let native: PeerCredNative | undefined;

function loadNative(): PeerCredNative {
  if (native) return native;
  const candidates = [
    new URL('../../native/peercred/build/Release/peer_cred.node', import.meta.url),
    new URL('../../native/peercred/build/Debug/peer_cred.node', import.meta.url),
    new URL('../../../../src/native/peercred/build/Release/peer_cred.node', import.meta.url),
    new URL('../../../../src/native/peercred/build/Debug/peer_cred.node', import.meta.url),
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      native = require(fileURLToPath(candidate)) as PeerCredNative;
      return native;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('se-z peer credential addon is unavailable');
}

function getSocketFd(socket: Socket): number | undefined {
  const handle = (socket as unknown as { _handle?: { fd?: number } })._handle;
  if (handle && typeof handle.fd === 'number') {
    return handle.fd;
  }
  return undefined;
}

export function getSocketPeerCred(
  socket: Socket,
): { uid: number; gid: number; pid: number } | undefined {
  const fd = getSocketFd(socket);
  if (fd === undefined) return undefined;
  try {
    const cred = loadNative().getPeerCred(fd);
    if (!cred.ok || cred.uid === undefined || cred.gid === undefined || cred.pid === undefined) {
      return undefined;
    }
    return { uid: cred.uid, gid: cred.gid, pid: cred.pid };
  } catch {
    return undefined;
  }
}

export function getSocketPeerUid(socket: Socket): number | undefined {
  return getSocketPeerCred(socket)?.uid;
}

export function getSocketPeerGid(socket: Socket): number | undefined {
  return getSocketPeerCred(socket)?.gid;
}

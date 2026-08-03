import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FrameDecoder, encodeFrame, decodeFrameJson, validateHello, validateRequest, makeTransportError, makeWelcome, makeHelloAccepted } from './protocol.mjs';
import { SezError, normalizeError, sanitizeDiagnostic } from './util.mjs';
import { getPeerCredential, authorizePeer, loadPeerCredentialAddon } from './identity.mjs';
import { loadPublicKeys } from './crypto.mjs';

function socketActivationDescriptors() {
  const pid = Number(process.env.LISTEN_PID ?? 0);
  const count = Number(process.env.LISTEN_FDS ?? 0);
  if (pid !== process.pid || !Number.isInteger(count) || count < 1) return new Map();
  const names = String(process.env.LISTEN_FDNAMES ?? '').split(':');
  const map = new Map();
  for (let index = 0; index < count; index += 1) map.set(names[index] || `fd${index + 3}`, index + 3);
  delete process.env.LISTEN_PID;
  delete process.env.LISTEN_FDS;
  delete process.env.LISTEN_FDNAMES;
  return map;
}

async function writeFrame(socket, value, maxFrameSize) {
  const frame = encodeFrame(value, maxFrameSize);
  if (!socket.write(frame)) await new Promise((resolve) => socket.once('drain', resolve));
}

export class SezKernelServer {
  constructor(config, operations, authorityProvider) {
    this.config = config;
    this.operations = operations;
    this.authorityProvider = authorityProvider;
    this.servers = new Map();
    this.socketStatus = { local: false, gateway: false };
  }

  async start() {
    await loadPeerCredentialAddon(this.config.nativeAddonPath);
    this.gatewayKeys = await loadPublicKeys(this.config.gatewayVerificationKeys);
    await this.operations.initialize();
    this.operations.setSocketStatusProvider(() => ({ ...this.socketStatus }));
    const descriptors = socketActivationDescriptors();
    if (descriptors.size > 0) {
      const localFd = descriptors.get('local') ?? descriptors.get('se-z-local');
      const gatewayFd = descriptors.get('gateway') ?? descriptors.get('se-z-gateway');
      if (!localFd || !gatewayFd) throw new SezError('internal_error', 'Both named local and gateway systemd sockets are required', { names: [...descriptors.keys()] });
      await this.listenFd('local', localFd);
      await this.listenFd('gateway', gatewayFd);
    } else {
      if (!this.config.directBind) throw new SezError('internal_error', 'Direct bind is disabled; use both systemd socket units');
      await this.listenPath('local', this.config.localSocket, 0o660, this.resolveGroup(this.config.localOperatorGroup));
      await this.listenPath('gateway', this.config.gatewaySocket, 0o660, this.config.gatewayGid);
    }
    return this;
  }

  resolveGroup(name) {
    const row = execFileSync('/usr/bin/getent', ['group', name], { encoding: 'utf8' }).trim().split(':');
    const gid = Number(row[2]);
    if (!Number.isInteger(gid)) throw new SezError('internal_error', `Unable to resolve socket group: ${name}`);
    return gid;
  }

  async listenFd(socketClass, fd) {
    const server = net.createServer((socket) => this.handleConnection(socketClass, socket));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ fd }, () => { server.off('error', reject); resolve(); });
    });
    this.servers.set(socketClass, server);
    this.socketStatus[socketClass] = true;
  }

  async listenPath(socketClass, socketPath, mode, gid) {
    await fsp.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o750 });
    await fsp.unlink(socketPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    const server = net.createServer((socket) => this.handleConnection(socketClass, socket));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); resolve(); });
    });
    await fsp.chown(socketPath, 0, gid);
    await fsp.chmod(socketPath, mode);
    this.servers.set(socketClass, server);
    this.socketStatus[socketClass] = true;
  }

  async stop() {
    const tasks = [];
    for (const [socketClass, server] of this.servers) {
      tasks.push(new Promise((resolve) => server.close(() => resolve())));
      this.socketStatus[socketClass] = false;
    }
    await Promise.all(tasks);
    if (this.config.directBind) {
      await fsp.unlink(this.config.localSocket).catch(() => {});
      await fsp.unlink(this.config.gatewaySocket).catch(() => {});
    }
  }

  handleConnection(socketClass, socket) {
    socket.setNoDelay(true);
    const decoder = new FrameDecoder(this.config.maximumFrameSize);
    const expectedPeerClass = socketClass === 'local' ? 'local-peer' : 'gateway-signed';
    let helloAccepted = false;
    let peerPromise = getPeerCredential(socket, this.config.nativeAddonPath);
    let chain = Promise.resolve();
    let destroyed = false;

    const failTransport = async (error) => {
      if (destroyed) return;
      destroyed = true;
      try { await writeFrame(socket, makeTransportError(normalizeError(error, 'invalid_frame')), this.config.maximumFrameSize); } catch {}
      socket.end();
    };

    (async () => {
      try {
        const generation = await this.authorityProvider.read();
        await writeFrame(socket, makeWelcome({
          serverId: this.config.serverId,
          authorityGeneration: generation,
          catalogDigest: this.operations.constructor.name ? (await this.operations.describe()).catalogDigest : null,
          hostIdentity: this.config.hostIdentity,
          releaseIdentity: this.config.releaseIdentity,
          maximumFrameSize: this.config.maximumFrameSize,
        }), this.config.maximumFrameSize);
      } catch (error) { await failTransport(error); }
    })();

    socket.on('data', (chunk) => {
      let frames;
      try { frames = decoder.feed(chunk); }
      catch (error) { void failTransport(error); return; }
      for (const payload of frames) {
        chain = chain.then(async () => {
          if (destroyed) return;
          let value;
          try { value = decodeFrameJson(payload); }
          catch (error) { await failTransport(error); return; }
          if (!helloAccepted) {
            try {
              validateHello(value, expectedPeerClass);
              await peerPromise;
              helloAccepted = true;
              await writeFrame(socket, makeHelloAccepted(expectedPeerClass), this.config.maximumFrameSize);
            } catch (error) { await failTransport(error); }
            return;
          }
          await this.handleRequest(socketClass, socket, value, await peerPromise).catch(async (error) => {
            await failTransport(error);
          });
        });
      }
    });
    socket.on('end', () => {
      try { decoder.finish(); }
      catch (error) { console.error(JSON.stringify({ component: 'se-z-supervisor', event: 'truncated-frame', code: error.code, message: error.message })); }
    });
    socket.on('error', (error) => {
      console.error(JSON.stringify({ component: 'se-z-supervisor', event: 'socket-error', socketClass, message: sanitizeDiagnostic(error.message) }));
    });
  }

  async handleRequest(socketClass, socket, value, peer) {
    let request;
    try {
      request = validateRequest(value, this.operations.activeOperations());
      await authorizePeer({ socketClass, request, peer, config: this.config, gatewayKeys: this.gatewayKeys });
      const reservation = await this.operations.reserve(request);
      const response = await this.operations.dispatch(request, reservation, { socketClass, peer });
      await writeFrame(socket, response, this.config.maximumFrameSize);
    } catch (error) {
      const normalized = normalizeError(error, 'invalid_request');
      if (value && typeof value === 'object' && typeof value.requestId === 'string' && typeof value.operation === 'string') {
        try {
          const response = await this.operations.errorResponseForUnreserved(value, normalized);
          await writeFrame(socket, response, this.config.maximumFrameSize);
          return;
        } catch (receiptError) {
          console.error(JSON.stringify({ component: 'se-z-supervisor', event: 'error-response-failed', code: normalized.code, message: sanitizeDiagnostic(receiptError.message) }));
        }
      }
      throw normalized;
    }
  }
}


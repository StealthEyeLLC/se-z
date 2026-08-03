import net from 'node:net';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import {
  PROTOCOL,
  PROTOCOL_VERSION,
  SUBJECT,
  AUTHORITY_CLASS,
  MAX_FRAME_SIZE,
  SezError,
  randomId,
  randomNonce,
} from './util.mjs';
import { FrameDecoder, encodeFrame, decodeFrameJson } from './protocol.mjs';
import { requestDigest, signDigestHex } from './crypto.mjs';

class FramedConnection {
  constructor(socket, maxFrameSize) {
    this.socket = socket;
    this.decoder = new FrameDecoder(maxFrameSize);
    this.queue = [];
    this.waiters = [];
    this.error = null;
    socket.on('data', (chunk) => {
      try {
        for (const payload of this.decoder.feed(chunk)) this.push(decodeFrameJson(payload));
      } catch (error) { this.fail(error); }
    });
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new SezError('invalid_frame', 'SEZ1 connection closed')));
  }
  push(value) {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(value); else this.queue.push(value);
  }
  fail(error) {
    if (this.error) return;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
  async read() {
    if (this.queue.length) return this.queue.shift();
    if (this.error) throw this.error;
    return await new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  async write(value, maxFrameSize) {
    const frame = encodeFrame(value, maxFrameSize);
    if (!this.socket.write(frame)) await new Promise((resolve) => this.socket.once('drain', resolve));
  }
  close() { this.socket.end(); }
  destroy() { this.socket.destroy(); }
}

async function connectSocket(socketPath) {
  const socket = net.createConnection({ path: socketPath });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

export class SezClient {
  constructor(options = {}) {
    this.socketPath = options.socketPath ?? '/run/se-z/local.sock';
    this.peerClass = options.peerClass ?? 'local-peer';
    this.clientId = options.clientId ?? 'se-z-cli';
    this.maximumFrameSize = options.maximumFrameSize ?? MAX_FRAME_SIZE;
    this.gatewayId = options.gatewayId;
    this.gatewayKeyId = options.gatewayKeyId;
    this.gatewayPrivateKey = options.gatewayPrivateKey;
  }

  static async gateway(options) {
    const pem = await fsp.readFile(options.privateKeyPath, 'utf8');
    return new SezClient({ ...options, peerClass: 'gateway-signed', gatewayPrivateKey: crypto.createPrivateKey(pem) });
  }

  async open() {
    const socket = await connectSocket(this.socketPath);
    const connection = new FramedConnection(socket, this.maximumFrameSize);
    const welcome = await connection.read();
    if (welcome.type === 'transport-error') throw new SezError(welcome.code, welcome.message);
    if (welcome.type !== 'welcome' || welcome.protocol !== PROTOCOL || welcome.protocolVersion !== PROTOCOL_VERSION) throw new SezError('unsupported_protocol', 'Invalid SEZ1 welcome');
    await connection.write({ type: 'hello', protocol: PROTOCOL, protocolVersion: PROTOCOL_VERSION, clientId: this.clientId, peerClass: this.peerClass }, this.maximumFrameSize);
    const accepted = await connection.read();
    if (accepted.type === 'transport-error') throw new SezError(accepted.code, accepted.message);
    if (accepted.type !== 'hello-accepted' || accepted.peerClass !== this.peerClass) throw new SezError('handshake_required', 'SEZ1 hello was not accepted');
    return { connection, welcome };
  }

  buildRequest(operation, payload, options, welcome) {
    const request = {
      protocol: PROTOCOL,
      protocolVersion: PROTOCOL_VERSION,
      requestId: options.requestId ?? randomId(),
      operation,
      payload: payload ?? {},
      idempotencyKey: options.idempotencyKey ?? `se-z-${operation}-${randomId()}`,
      subject: SUBJECT,
      authorityClass: AUTHORITY_CLASS,
      authorityGeneration: options.authorityGeneration ?? welcome.authorityGeneration,
      issuedAt: options.issuedAt ?? new Date().toISOString(),
      nonce: options.nonce ?? randomNonce(),
      peerClass: this.peerClass,
    };
    if (this.peerClass === 'gateway-signed') {
      if (!this.gatewayId || !this.gatewayKeyId || !this.gatewayPrivateKey) throw new SezError('invalid_request', 'Gateway client requires gatewayId, gatewayKeyId, and private key');
      request.gatewayId = this.gatewayId;
      request.gatewayKeyId = this.gatewayKeyId;
      request.signature = signDigestHex(requestDigest(request), this.gatewayPrivateKey);
    }
    return request;
  }

  async call(operation, payload = {}, options = {}) {
    const { connection, welcome } = await this.open();
    const request = this.buildRequest(operation, payload, options, welcome);
    await connection.write(request, this.maximumFrameSize);
    if (options.disconnectAfterSend) {
      connection.destroy();
      return { welcome, request, response: null, disconnectedAfterSend: true };
    }
    const response = await connection.read();
    connection.close();
    if (response.type === 'transport-error') throw new SezError(response.code, response.message);
    return { welcome, request, response };
  }
}

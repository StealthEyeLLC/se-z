// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
import { createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import {
  buildSigningDocument,
  semanticRequestFingerprint,
  sha256Hex,
  verifyReceipt,
} from '../signing/canonical.js';
import { createFrameReader, decodeJson, encodeFrame, encodeJson, feedFrames, FrameType } from './protocol.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export class SezError extends Error {
  constructor(code, message, retryable = false, details = undefined) {
    super(message);
    this.name = 'SezError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export class SezClient {
  constructor(config) {
    this.config = config;
    this.privateKey = createPrivateKey(readFileSync(config.gatewayPrivateKeyPath, 'utf8'));
    this.receiptPublicKey = createPublicKey(readFileSync(config.receiptPublicKeyPath, 'utf8'));
  }

  async call(operation, payload, requestId = randomUUID()) {
    if (!/^sez\.[a-z0-9._-]{1,240}$/u.test(operation)) throw new SezError('invalid_operation', 'Operation is not a se-z operation');
    if (!UUID_PATTERN.test(requestId)) throw new SezError('invalid_request_id', 'requestId must be a canonical UUID');
    if (this.config.enforceGatewayUid && process.getuid && process.getuid() !== this.config.gatewayUid) {
      throw new SezError('invalid_gateway_uid', 'se-z gateway is not running as the configured gateway user');
    }
    const timestamp = new Date().toISOString();
    const principal = {
      subject: this.config.expectedSubject,
      authorityClass: 'unrestricted-owner',
      issuer: this.config.authorityIssuer,
      resource: this.config.authorityResource,
      audience: this.config.authorityResource,
      principalType: 'owner',
      workspaceAuthority: null,
      principalFingerprint: this.config.ownerPrincipalFingerprint,
    };
    const authorityForSigning = {
      algorithm: 'ed25519',
      gatewayId: this.config.gatewayId,
      keyId: this.config.gatewayKeyId,
      nonce: randomUUID(),
    };
    const requestCore = {
      protocolVersion: '1.0.0',
      requestId,
      operation,
      principal,
      authority: authorityForSigning,
      targetHost: this.config.targetHost,
      timestamp,
      payload,
      binaryLength: 0,
    };
    const signingDocument = buildSigningDocument(requestCore);
    const requestDigest = sha256Hex(signingDocument);
    const requestFingerprint = semanticRequestFingerprint(requestCore);
    const request = {
      ...requestCore,
      authority: {
        ...authorityForSigning,
        signature: sign(null, Buffer.from(signingDocument, 'utf8'), this.privateKey).toString('base64'),
      },
    };
    const response = await this.#exchange(request);
    if (response.requestId !== requestId || response.operation !== operation) throw new SezError('response_mismatch', 'se-z response correlation does not match');
    const receiptVerification = verifyReceipt(
      response.receipt,
      response.result,
      {
        requestId,
        operation,
        subject: this.config.expectedSubject,
        hostname: this.config.targetHost,
        machineIdSha256: this.config.expectedMachineIdSha256,
        receiptKeyId: this.config.receiptKeyId,
        requestDigest,
        requestFingerprint,
      },
      this.receiptPublicKey,
    );
    return Object.freeze({ ...response, evidence: receiptVerification });
  }

  async #exchange(request) {
    return await new Promise((resolve, reject) => {
      const socket = connect(this.config.socketPath);
      const reader = createFrameReader();
      let welcomed = false;
      let settled = false;
      const finish = (action) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        action();
      };
      const timer = setTimeout(() => finish(() => reject(new SezError('request_timeout', 'se-z request timed out', true))), this.config.requestTimeoutMs);
      timer.unref();
      socket.on('connect', () => {
        socket.write(encodeFrame(FrameType.Hello, encodeJson({ clientId: 'se-z-gateway', supportedFeatures: ['compression.none'], supportedAlgorithms: ['ed25519'] })));
      });
      socket.on('data', (chunk) => {
        try {
          for (const frame of feedFrames(reader, chunk, this.config.maxFrameSize)) {
            if (!welcomed) {
              if (frame.header.frameType !== FrameType.Welcome) throw new SezError('invalid_handshake', 'se-z did not return a welcome frame');
              const welcome = decodeJson(frame.payload);
              if (welcome.serverId !== 'se-z-supervisor') throw new SezError('wrong_supervisor', 'se-z supervisor identity does not match');
              if (welcome.hostname !== this.config.targetHost || welcome.machineIdSha256 !== this.config.expectedMachineIdSha256) throw new SezError('wrong_machine', 'se-z machine identity does not match');
              if (welcome.selectedAlgorithm !== 'ed25519') throw new SezError('wrong_algorithm', 'se-z did not negotiate Ed25519');
              welcomed = true;
              socket.write(encodeFrame(FrameType.Request, encodeJson(request), request.requestId));
              continue;
            }
            if (frame.header.frameType === FrameType.Response) {
              finish(() => resolve(decodeJson(frame.payload)));
              return;
            }
            if (frame.header.frameType === FrameType.Error) {
              const error = decodeJson(frame.payload);
              finish(() => reject(new SezError(error.code, error.message, error.retryable, error.details)));
              return;
            }
          }
        } catch (error) {
          finish(() => reject(error));
        }
      });
      socket.on('error', (error) => finish(() => reject(new SezError('socket_error', 'se-z socket is unavailable', true, { name: error.name }))));
      socket.on('close', () => {
        if (!settled) finish(() => reject(new SezError('connection_closed', 'se-z connection closed before a result', true)));
      });
    });
  }
}

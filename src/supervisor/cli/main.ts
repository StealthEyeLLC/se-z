#!/usr/bin/env node
// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** se-z CLI client for local administration and testing. */

import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import {
  FrameType,
  encodeFrame,
  encodeJsonPayload,
  decodeJsonPayload,
  feedFrames,
  createFrameReader,
  type HelloPayload,
  type RequestPayload,
  type ResponsePayload,
  type ErrorPayload,
} from '../../protocol/framing/frame.js';
import { buildSigningDocument } from '../../protocol/canonical/canonical.js';
import { signEd25519, loadPrivateKey } from '../../protocol/signatures/signing.js';
import { loadRuntimeConfig, PROTOCOL_VERSION, DEFAULTS, GATEWAY_AUTHORITY_KEY_ID } from '../configuration/config.js';

interface CliOptions {
  socketPath: string;
  operation: string;
  payload: string;
  keyPath?: string;
  gatewayId: string;
  subject: string;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  let socketPath: string = DEFAULTS.socketPath;
  let operation = 'sez.health';
  let payload = '{}';
  let keyPath: string | undefined;
  let gatewayId: string = DEFAULTS.gatewayId;
  let subject: string = DEFAULTS.expectedSubject;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--socket':
        socketPath = args[++i];
        break;
      case '--operation':
      case '-o':
        operation = args[++i];
        break;
      case '--payload':
      case '-p':
        payload = args[++i];
        break;
      case '--key':
        keyPath = args[++i];
        break;
      case '--gateway-id':
        gatewayId = args[++i];
        break;
      case '--subject':
        subject = args[++i];
        break;
      case '--help':
        console.log(`Usage: se-z [options]
  --socket <path>       Unix socket path
  -o, --operation <op>  Operation name (default: sez.health)
  -p, --payload <json>  Request payload JSON
  --key <path>          Signing private key path
  --gateway-id <id>     Gateway identity
  --subject <subject>   Principal subject`);
        process.exit(0);
    }
  }

  return { socketPath, operation, payload, keyPath, gatewayId, subject };
}

async function sendRequest(options: CliOptions): Promise<unknown> {
  const config = loadRuntimeConfig();
  const keyPath = options.keyPath ?? config.gatewayAuthorityPrivateKeyPath;

  if (!existsSync(keyPath)) {
    throw new Error(`Signing key not found: ${keyPath}`);
  }

  const privateKey = loadPrivateKey(keyPath);
  const requestId = randomUUID();
  const timestamp = new Date().toISOString();
  const payloadObj = JSON.parse(options.payload);

  const nonce = randomUUID();

  const principal = {
    subject: options.subject,
    authorityClass: DEFAULTS.authorityClass,
    issuer: DEFAULTS.oauthIssuer,
  };

  const authorityForSigning = {
    algorithm: 'ed25519' as const,
    gatewayId: options.gatewayId,
    keyId: GATEWAY_AUTHORITY_KEY_ID,
    nonce,
  };

  const signingDoc = buildSigningDocument({
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    operation: options.operation,
    principal,
    authority: authorityForSigning,
    targetHost: hostname(),
    timestamp,
    payload: payloadObj,
    binaryLength: 0,
  });

  const authority = {
    ...authorityForSigning,
    signature: signEd25519(signingDoc, privateKey),
    keyId: GATEWAY_AUTHORITY_KEY_ID,
  };

  const request: RequestPayload = {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    operation: options.operation,
    principal,
    authority,
    targetHost: hostname(),
    timestamp,
    payload: payloadObj,
    binaryLength: 0,
  };

  return new Promise((resolve, reject) => {
    const socket = connect(options.socketPath);
    const reader = createFrameReader();
    let handshaken = false;

    socket.on('connect', () => {
      const hello: HelloPayload = {
        clientId: 'se-z-cli',
        supportedFeatures: ['compression.none'],
        supportedAlgorithms: ['ed25519'],
      };
      socket.write(encodeFrame(FrameType.Hello, encodeJsonPayload(hello)));
    });

    socket.on('data', (chunk) => {
      const frames = feedFrames(reader, chunk, 16 * 1024 * 1024);
      for (const frame of frames) {
        if (!handshaken && frame.header.frameType === FrameType.Welcome) {
          handshaken = true;
          socket.write(encodeFrame(FrameType.Request, encodeJsonPayload(request), requestId));
          continue;
        }
        if (frame.header.frameType === FrameType.Response) {
          const response = decodeJsonPayload<ResponsePayload>(frame.payload);
          socket.end();
          resolve(response);
          return;
        }
        if (frame.header.frameType === FrameType.Error) {
          const error = decodeJsonPayload<ErrorPayload>(frame.payload);
          socket.end();
          reject(new Error(`${error.code}: ${error.message}`));
          return;
        }
      }
    });

    socket.on('error', reject);
    socket.setTimeout(60_000, () => {
      socket.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

async function main(): Promise<void> {
  const options = parseArgs();
  const result = await sendRequest(options);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/helpers/client.ts; exact lineage in vendor/baby-provenance/file-map.json.
/** Shared test client for se-z integration and acceptance tests. */

import { connect, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { existsSync } from 'node:fs';
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
} from '../../../../../src/protocol/framing/frame.js';
import { buildSigningDocument } from '../../../../../src/protocol/canonical/canonical.js';
import { signEd25519, loadPrivateKey } from '../../../../../src/protocol/signatures/signing.js';
import {
  loadRuntimeConfig,
  PROTOCOL_VERSION,
  DEFAULTS,
  GATEWAY_AUTHORITY_KEY_ID,
} from '../../../../../src/supervisor/configuration/config.js';
import { buildOwnerPrincipal } from '../../../../../src/supervisor/dispatch/auth/principal.js';
import type { RuntimeConfig } from '../../../../../src/supervisor/configuration/config.js';

export interface TestClientOptions {
  socketPath: string;
  configRoot: string;
  config?: Partial<RuntimeConfig>;
  gatewayPrivateKeyPath?: string;
  ownerPrincipalFingerprint?: string;
}

export class SezTestClient {
  private readonly gatewayPrivateKeyPath: string;
  private readonly config: RuntimeConfig;
  private readonly ownerPrincipalFingerprint: string;

  constructor(private readonly options: TestClientOptions) {
    this.config = loadRuntimeConfig({
      configRoot: options.configRoot,
      expectedMachineIdSha256: 'test',
      expectedHostname: hostname(),
      skipPeerCredCheck: true,
      ...options.config,
    });
    this.gatewayPrivateKeyPath =
      options.gatewayPrivateKeyPath ?? `${options.configRoot}/gateway-authority-private.pem`;
    this.ownerPrincipalFingerprint = options.ownerPrincipalFingerprint ?? '';
  }

  async request(
    operation: string,
    payload: unknown = {},
    overrides: {
      requestId?: string;
      nonce?: string;
      timestamp?: string;
      principal?: Record<string, unknown>;
      skipHandshake?: boolean;
    } = {},
  ): Promise<ResponsePayload> {
    if (!existsSync(this.gatewayPrivateKeyPath)) {
      throw new Error(`Gateway signing key not found: ${this.gatewayPrivateKeyPath}`);
    }
    const privateKey = loadPrivateKey(this.gatewayPrivateKeyPath);
    const requestId = overrides.requestId ?? randomUUID();
    const timestamp = overrides.timestamp ?? new Date().toISOString();
    const nonce = overrides.nonce ?? randomUUID();
    const principal =
      overrides.principal ??
      buildOwnerPrincipal({
        principalFingerprint: this.ownerPrincipalFingerprint || undefined,
      });

    const authorityForSigning = {
      algorithm: 'ed25519' as const,
      gatewayId: DEFAULTS.gatewayId,
      keyId: GATEWAY_AUTHORITY_KEY_ID,
      nonce,
    };

    const signingDoc = buildSigningDocument({
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      operation,
      principal: principal as Record<string, unknown>,
      authority: authorityForSigning,
      targetHost: hostname(),
      timestamp,
      payload,
      binaryLength: 0,
    });

    const authority = {
      ...authorityForSigning,
      signature: signEd25519(signingDoc, privateKey),
    };

    const request: RequestPayload = {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      operation,
      principal: principal as Record<string, unknown>,
      authority,
      targetHost: hostname(),
      timestamp,
      payload,
      binaryLength: 0,
    };

    return new Promise((resolve, reject) => {
      const socket = connect(this.options.socketPath);
      const reader = createFrameReader();
      let handshaken = overrides.skipHandshake ?? false;

      socket.on('connect', () => {
        if (!handshaken) {
          const hello: HelloPayload = {
            clientId: 'se-z-test',
            supportedFeatures: ['compression.none'],
            supportedAlgorithms: ['ed25519'],
          };
          socket.write(encodeFrame(FrameType.Hello, encodeJsonPayload(hello)));
        } else {
          socket.write(encodeFrame(FrameType.Request, encodeJsonPayload(request), requestId));
        }
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
            socket.end();
            resolve(decodeJsonPayload<ResponsePayload>(frame.payload));
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
      socket.setTimeout(30_000, () => {
        socket.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }

  async expectError(
    operation: string,
    payload: unknown,
    expectedCode: string,
    overrides: Parameters<SezTestClient['request']>[2] = {},
  ): Promise<ErrorPayload> {
    try {
      await this.request(operation, payload, overrides);
      throw new Error(`Expected error ${expectedCode} but request succeeded`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const [code] = message.split(':');
      if (code !== expectedCode) {
        throw new Error(`Expected ${expectedCode}, got ${message}`);
      }
      return { requestId: '', code, message: message.slice(code.length + 2), retryable: false };
    }
  }
}

export function createTestClient(ctx: {
  socketPath: string;
  configRoot: string;
  gatewayPrivateKeyPath: string;
  ownerPrincipalFingerprint: string;
}): SezTestClient {
  return new SezTestClient({
    socketPath: ctx.socketPath,
    configRoot: ctx.configRoot,
    gatewayPrivateKeyPath: ctx.gatewayPrivateKeyPath,
    ownerPrincipalFingerprint: ctx.ownerPrincipalFingerprint,
  });
}

export function setupTestEnv(): void {
  process.env.SEZ_TEST_MODE = '1';
  process.env.SEZ_ALLOW_DIRECT_BIND = '1';
}

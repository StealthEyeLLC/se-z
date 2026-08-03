// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Unix socket server and connection handler. */

import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RuntimeConfig } from '../configuration/config.js';
import { ReplayStore } from '../../state/replay/store.js';
import { StateStore } from '../../state/store/store.js';
import { Authenticator, AuthError, IdempotentReplay } from '../dispatch/auth/authenticator.js';
import { OperationRegistry } from '../../operations/registry.js';
import {
  FrameType,
  encodeFrame,
  encodeJsonPayload,
  decodeJsonPayload,
  feedFrames,
  createFrameReader,
  type HelloPayload,
  type WelcomePayload,
  type RequestPayload,
  type ErrorPayload,
  ProtocolError,
} from '../../protocol/framing/frame.js';
import { getHostname, getMachineIdSha256, PROTOCOL_VERSION } from '../configuration/config.js';
import { redactSecrets } from '../../protocol/canonical/canonical.js';
import { getSocketPeerUid } from '../peers/peer-cred.js';
import { getSystemdListenFd, isSocketActivated } from '../sockets/socket-activation.js';

export class SezServer {
  private server?: Server;
  private readonly replayStore: ReplayStore;
  private readonly stateStore: StateStore;
  private readonly authenticator: Authenticator;
  private readonly registry: OperationRegistry;
  private listenFd?: number;
  private usingSocketActivation = false;

  constructor(private readonly config: RuntimeConfig) {
    this.replayStore = new ReplayStore(config);
    this.stateStore = new StateStore(config);
    this.authenticator = new Authenticator(config, this.replayStore);
    this.registry = new OperationRegistry(config, this.stateStore, this.replayStore);
  }

  async start(): Promise<void> {
    await this.registry.initialize();
    const recovery = this.registry.recover();
    console.log(
      `[se-z] recovered ${recovery.jobs} jobs, ${recovery.detached} detached, ${recovery.ptySessions} pty sessions`,
    );

    this.listenFd = getSystemdListenFd();
    this.usingSocketActivation = this.listenFd !== undefined;

    this.server = createServer((socket) => this.handleConnection(socket));

    if (this.usingSocketActivation && this.listenFd !== undefined) {
      await new Promise<void>((resolve, reject) => {
        this.server!.listen({ fd: this.listenFd, path: this.config.socketPath }, () => {
          console.log(`[se-z] socket-activated on fd ${this.listenFd}`);
          resolve();
        });
        this.server!.on('error', reject);
      });
      return;
    }

    if (process.env.SEZ_ALLOW_DIRECT_BIND !== '1' && !process.env.SEZ_TEST_MODE) {
      throw new Error(
        'Direct socket bind disabled; use systemd socket activation or set SEZ_ALLOW_DIRECT_BIND=1',
      );
    }

    const socketDir = dirname(this.config.socketPath);
    mkdirSync(socketDir, { recursive: true, mode: 0o750 });
    if (existsSync(this.config.socketPath)) {
      unlinkSync(this.config.socketPath);
    }

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.socketPath, () => {
        console.log(`[se-z] listening on ${this.config.socketPath}`);
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    this.replayStore.persist();
    this.registry.close();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
    if (!this.usingSocketActivation && existsSync(this.config.socketPath)) {
      unlinkSync(this.config.socketPath);
    }
  }

  isSocketActivated(): boolean {
    return this.usingSocketActivation;
  }

  private handleConnection(socket: Socket): void {
    const reader = createFrameReader();
    let handshaken = false;
    let negotiatedAlgorithm: string | undefined;

    socket.on('data', async (chunk) => {
      try {
        const frames = feedFrames(reader, chunk, this.config.maxFrameSize);
        for (const frame of frames) {
          if (!handshaken) {
            if (frame.header.frameType !== FrameType.Hello) {
              this.sendError(socket, frame.header.requestId, 'handshake_required', 'Hello required');
              socket.destroy();
              return;
            }
            const hello = decodeJsonPayload<HelloPayload>(frame.payload);
            if (!hello.supportedAlgorithms.includes('ed25519')) {
              this.sendError(
                socket,
                frame.header.requestId,
                'unsupported_algorithm',
                'Ed25519 is required',
              );
              socket.destroy();
              return;
            }
            negotiatedAlgorithm = 'ed25519';
            const welcome: WelcomePayload = {
              serverId: this.config.supervisorId,
              protocolVersion: PROTOCOL_VERSION,
              selectedFeatures: ['compression.none'],
              selectedAlgorithm: negotiatedAlgorithm,
              machineIdSha256: getMachineIdSha256() || 'unknown',
              hostname: getHostname(),
            };
            socket.write(
              encodeFrame(FrameType.Welcome, encodeJsonPayload(welcome), frame.header.requestId),
            );
            handshaken = true;
            continue;
          }

          switch (frame.header.frameType) {
            case FrameType.Request:
              await this.handleRequest(socket, frame.payload, negotiatedAlgorithm);
              break;
            case FrameType.Ping:
              socket.write(encodeFrame(FrameType.Pong, Buffer.alloc(0), frame.header.requestId));
              break;
            case FrameType.Cancel:
              break;
            default:
              this.sendError(
                socket,
                frame.header.requestId,
                'unsupported_frame',
                `Unsupported frame type: ${frame.header.frameType}`,
              );
          }
        }
      } catch (err) {
        const code = err instanceof ProtocolError ? err.code : 'protocol_error';
        const message = err instanceof Error ? err.message : 'Unknown protocol error';
        this.sendError(socket, '00000000-0000-0000-0000-000000000000', code, message);
        socket.destroy();
      }
    });

    socket.on('error', (err: Error) => {
      console.error('[se-z] socket error:', redactSecrets(err.message));
    });
  }

  private async handleRequest(
    socket: Socket,
    payloadBuf: Buffer,
    negotiatedAlgorithm?: string,
  ): Promise<void> {
    let request: RequestPayload;
    try {
      request = decodeJsonPayload<RequestPayload>(payloadBuf);
    } catch {
      this.sendError(socket, '00000000-0000-0000-0000-000000000000', 'invalid_request', 'Invalid JSON request');
      return;
    }

    if (negotiatedAlgorithm !== 'ed25519') {
      this.sendError(socket, request.requestId, 'handshake_required', 'Ed25519 handshake required');
      return;
    }

    try {
      const peerUid = getSocketPeerUid(socket);
      const auth = this.authenticator.authenticate(request, peerUid);
      const { response } = await this.registry.dispatch(auth);
      socket.write(
        encodeFrame(FrameType.Response, encodeJsonPayload(response), request.requestId),
      );
    } catch (err: unknown) {
      if (err instanceof IdempotentReplay) {
        socket.write(
          encodeFrame(FrameType.Response, encodeJsonPayload(err.cachedResponse), request.requestId),
        );
        return;
      }
      if (err instanceof AuthError) {
        this.sendError(socket, request.requestId, err.code, err.message, err.retryable, err.details);
        return;
      }
      const message = err instanceof Error ? err.message : 'Operation failed';
      this.sendError(socket, request.requestId, 'operation_failed', message, true);
    }
  }

  private sendError(
    socket: Socket,
    requestId: string,
    code: string,
    message: string,
    retryable = false,
    details?: Record<string, unknown>,
  ): void {
    const error: ErrorPayload = { requestId, code, message, retryable, ...(details ? { details } : {}) };
    socket.write(encodeFrame(FrameType.Error, encodeJsonPayload(error), requestId));
  }
}

export { isSocketActivated };

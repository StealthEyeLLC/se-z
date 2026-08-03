// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Operation registry and dispatch. */

import type { RuntimeConfig } from '../supervisor/configuration/config.js';
import type { AuthenticatedRequest } from '../supervisor/dispatch/auth/authenticator.js';
import type { ReplayStore } from '../state/replay/store.js';
import type { StateStore } from '../state/store/store.js';
import { JobManager } from '../jobs/manager.js';
import { FileManager } from '../files/manager.js';
import { PtyManager } from '../pty/manager.js';
import { ArtifactManager } from '../artifacts/manager.js';
import { signReceipt, resultDigest, readReceiptReleaseIdentity } from '../protocol/receipts/receipt.js';
import { existsSync } from 'node:fs';
import { loadPrivateKey as loadPrivKey } from '../protocol/signatures/signing.js';
import { getHostname, getMachineIdSha256, PROTOCOL_VERSION } from '../supervisor/configuration/config.js';
import type { ResponsePayload } from '../protocol/framing/frame.js';
import { buildCapabilityDescription, OPERATION_DEFINITIONS } from './definitions.js';
import { normalizeOperationError, OperationError } from './errors.js';
import { StandaloneDeploymentService } from '../releases/deployment/service.js';
import { GitHubAppAuthority } from '../github/app-authority.js';
import { SkillDeploymentService } from '../skills/service.js';
import { catalogDigest, loadActivePackageSet } from '../skills/loader.js';
import { assertJsonSerializable } from '../skills/schema.js';
import type { LoadedPackageSet } from '../skills/types.js';

export interface OperationResult {
  response: ResponsePayload;
  cached?: boolean;
}

export class OperationRegistry {
  private readonly jobs: JobManager;
  private readonly files: FileManager;
  private readonly pty: PtyManager;
  private readonly artifacts: ArtifactManager;
  private privateKey?: ReturnType<typeof loadPrivKey>;
  private deployments?: StandaloneDeploymentService;
  private githubAuthority?: GitHubAppAuthority;
  private loadedSkills: LoadedPackageSet;
  private readonly skillService: SkillDeploymentService;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly store: StateStore,
    private readonly replayStore: ReplayStore,
  ) {
    this.jobs = new JobManager(config, store);
    this.files = new FileManager();
    this.pty = new PtyManager(store);
    this.artifacts = new ArtifactManager(store);
    this.loadedSkills = {
      setDigest: null,
      setPath: null,
      manifest: null,
      skills: [],
      definitions: [],
      handlers: new Map(),
      inputValidators: new Map(),
      outputValidators: new Map(),
      catalogDigest: catalogDigest(OPERATION_DEFINITIONS),
    };
    this.skillService = new SkillDeploymentService(config, OPERATION_DEFINITIONS, () => this.loadedSkills);

    if (existsSync(config.supervisorReceiptPrivateKeyPath)) {
      this.privateKey = loadPrivKey(config.supervisorReceiptPrivateKeyPath);
    }
  }

  async initialize(): Promise<void> {
    this.skillService.ensureInitialSet();
    this.loadedSkills = await loadActivePackageSet(OPERATION_DEFINITIONS);
  }

  recover(): { jobs: number; detached: number; ptySessions: number } {
    return {
      jobs: this.jobs.recoverRunningJobs(),
      detached: this.jobs.recoverDetachedJobs(),
      ptySessions: this.pty.recoverSessions(),
    };
  }

  close(): void {
    this.deployments?.close();
  }

  async dispatch(auth: AuthenticatedRequest): Promise<OperationResult> {
    const { payload, hash } = auth;
    const operation = payload.operation;
    const body = (payload.payload ?? {}) as Record<string, unknown>;
    let result: unknown;
    const startedAt = new Date().toISOString();

    try {
      result = await this.executeOperation(operation, payload.requestId, body);
    } catch (error) {
      result = normalizeOperationError(error, operation, payload.requestId);
    }

    const completedAt = new Date().toISOString();
    const response: ResponsePayload = {
      requestId: payload.requestId,
      operation,
      result,
    };

    if (this.privateKey) {
      response.receipt = signReceipt(
        {
          requestId: payload.requestId,
          operation,
          subject: auth.subject,
          authorityClass: auth.authorityClass,
          requestDigest: auth.hash,
          requestFingerprint: auth.fingerprint,
          resultDigest: resultDigest(result),
          timestamp: completedAt,
          startedAt,
          completedAt,
          release: readReceiptReleaseIdentity(),
          machineIdSha256: getMachineIdSha256() || 'unknown',
          hostname: getHostname(),
        },
        this.privateKey,
        this.config.supervisorReceiptKeyId,
      ) as unknown as Record<string, unknown>;
    }

    this.replayStore.storeIdempotentResponse(hash, response, payload.requestId, auth.fingerprint);
    this.replayStore.persist();
    this.store.pruneJobs(this.config.maxRetentionJobs);

    return { response };
  }

  private async executeOperation(
    operation: string,
    requestId: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    if (SkillDeploymentService.handles(operation)) {
      return this.skillService.execute(operation, requestId, body);
    }
    const skillHandler = this.loadedSkills.handlers.get(operation);
    if (skillHandler !== undefined) {
      this.loadedSkills.inputValidators.get(operation)?.(body);
      const skill = this.loadedSkills.skills.find((candidate) =>
        candidate.definitions.some((definition) => definition.operation === operation));
      if (skill === undefined) {
        throw new OperationError('operation_failed', `Loaded skill source missing for ${operation}`, false);
      }
      const result = await skillHandler(body, {
        skillName: skill.source.name,
        skillVersion: skill.source.version,
        bundleDigest: skill.source.bundleDigest,
        activeSetDigest: this.loadedSkills.setDigest,
      });
      this.loadedSkills.outputValidators.get(operation)?.(result);
      assertJsonSerializable(result, `${operation} result`);
      return result;
    }
    if (StandaloneDeploymentService.handles(operation)) {
      this.deployments ??= new StandaloneDeploymentService(this.config, {
        signingKey: this.privateKey,
        signingKeyId: this.config.supervisorReceiptKeyId,
        fixtureMode: process.env.SEZ_DEPLOYMENT_FIXTURE_MODE === '1',
      });
      return this.deployments.execute(operation, requestId, body);
    }
    switch (operation) {
      case 'sez.describe':
        return buildCapabilityDescription(this.config, this.loadedSkills);
      case 'sez.health':
        return this.health();
      case 'sez.github.app.verify':
        this.githubAuthority ??= new GitHubAppAuthority();
        return await this.githubAuthority.verify(body);
      case 'sez.github.app.proof':
        this.githubAuthority ??= new GitHubAppAuthority();
        return await this.githubAuthority.proof(body);
      case 'sez.exec':
        return await this.jobs.exec(requestId, body as never);
      case 'sez.shell':
        return await this.jobs.shell(requestId, body as never);
      case 'sez.job.get':
        return this.jobs.getJob(String(body.jobId));
      case 'sez.job.list':
        return this.jobs.listJobs(body as never);
      case 'sez.job.wait':
        return this.jobs.waitForJob(body as never);
      case 'sez.job.cancel':
        return this.jobs.cancelJob(body as never);
      case 'sez.job.stream.read':
        return this.jobs.readStream(body as never);
      case 'sez.file.stat':
        return this.files.stat(body as never);
      case 'sez.file.read':
        return this.files.read(body as never);
      case 'sez.file.write':
        return this.files.write(body as never);
      case 'sez.file.replace':
        return this.files.replace(body as never);
      case 'sez.file.patch':
        return this.files.patch(body as never);
      case 'sez.file.copy':
        return this.files.copy(body as never);
      case 'sez.file.move':
        return this.files.move(body as never);
      case 'sez.file.remove':
        return this.files.remove(body as never);
      case 'sez.file.list':
        return this.files.list(body as never);
      case 'sez.pty.create':
        return this.pty.create(requestId, body as never);
      case 'sez.pty.input':
        return this.pty.input(body as never);
      case 'sez.pty.resize':
        return this.pty.resize(body as never);
      case 'sez.pty.read':
        return this.pty.read(body as never);
      case 'sez.pty.close':
        return this.pty.close(body as never);
      case 'sez.artifact.create':
        return this.artifacts.createFromFile(body as never);
      case 'sez.artifact.begin':
        return this.artifacts.beginUpload(body as never);
      case 'sez.artifact.upload':
        return this.artifacts.uploadChunk(body as never);
      case 'sez.artifact.finalize':
        return this.artifacts.finalize(body as never);
      case 'sez.artifact.abort':
        return this.artifacts.abort(body as never);
      case 'sez.artifact.download':
        return this.artifacts.download(body as never);
      case 'sez.artifact.list':
        return this.artifacts.list();
      case 'sez.artifact.get':
        return this.artifacts.get(String(body.artifactId));
      default:
        throw new OperationError(
          'unknown_operation',
          `Unknown operation: ${operation}`,
          false,
          { operation },
        );
    }
  }

  private health(): Record<string, unknown> {
    return {
      status: 'healthy',
      product: 'se-z',
      protocolVersion: PROTOCOL_VERSION,
      supervisorId: this.config.supervisorId,
      hostname: getHostname(),
      machineIdSha256: getMachineIdSha256() || 'unknown',
      uptime: process.uptime(),
      jobs: this.store.listJobs().length,
      timestamp: new Date().toISOString(),
    };
  }
}

export const OPERATIONS = OPERATION_DEFINITIONS.map((definition) => definition.operation) as readonly string[];

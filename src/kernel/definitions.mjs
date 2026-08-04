import { catalogDigest as digestCatalog } from './crypto.mjs';

const objectSchema = (properties = {}, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const string = { type: 'string' };
const integer = { type: 'integer' };
const boolean = { type: 'boolean' };
const data = { type: 'string', description: 'Encoded bytes according to the adjacent encoding field.' };
const pathString = { type: 'string', pattern: '^/' };
const commonErrors = ['invalid_payload', 'unauthorized_peer', 'stale_generation', 'future_generation', 'idempotency_conflict', 'replay_detected', 'state_corrupt', 'disk_full', 'operation_failed', 'internal_error'];

function definition({ name, description, inputSchema = objectSchema(), outputSchema = objectSchema({}, []), mutating = false, durableJobBehavior = 'none', supportedTargets = ['host'], defaultTarget = 'host', defaultLane = 'fast', idempotencySemantics = mutating ? 'same semantic identity reuses the durable request; changed semantics conflict' : 'same semantic identity reuses the durable request response', requiredPeerAuthority = ['local-peer', 'gateway-signed'], streamBehavior = 'none', typedErrors = [], implementationStatus = 'active-tested-0.1A' }) {
  return {
    name,
    operationVersion: '1.0.0',
    description,
    inputSchema,
    outputSchema,
    mutating,
    durableJobBehavior,
    supportedTargets,
    defaultTarget,
    defaultLane,
    idempotencySemantics,
    requiredPeerAuthority,
    streamBehavior,
    typedErrors: [...new Set([...commonErrors, ...typedErrors])].sort(),
    implementationStatus,
  };
}

const execCommon = {
  cwd: pathString,
  environment: { type: 'object', additionalProperties: { type: 'string' } },
  stdin: objectSchema({ data, encoding: { enum: ['base64', 'utf8'] } }, ['data']),
  user: { oneOf: [string, integer] },
  group: { oneOf: [string, integer] },
  umask: { oneOf: [string, integer] },
  timeoutMs: integer,
  detached: boolean,
  target: { type: 'string' },
  lane: { const: 'fast' },
};

export const ACTIVE_OPERATION_DEFINITIONS = Object.freeze([
  definition({ name: 'sez.describe', description: 'Publish the complete active 0.1A operation catalog and interpretation limits.' }),
  definition({ name: 'sez.health', description: 'Report operational health after checking state, generation, keys, catalog, sockets, reconciliation, and stream storage.', typedErrors: ['repair_required'] }),
  definition({ name: 'sez.version', description: 'Return exact kernel, release, source, protocol, catalog, state-schema, and native-addon identities.' }),
  definition({ name: 'sez.doctor', description: 'Return non-mutating diagnostic detail without secret material.', typedErrors: ['repair_required'] }),
  definition({ name: 'sez.request.resume', description: 'Recover an original durable request by requestId or exact idempotency identity.', inputSchema: objectSchema({ requestId: string, operation: string, idempotencyKey: string, payload: { type: 'object' }, target: string }, []), typedErrors: ['not_found'] }),

  definition({ name: 'sez.exec', description: 'Execute exact argv on the host with no shell interpretation.', inputSchema: objectSchema({ argv: { type: 'array', minItems: 1, items: string }, ...execCommon }, ['argv']), mutating: true, durableJobBehavior: 'always creates a durable job before launch', streamBehavior: 'separate durable binary stdout/stderr; bounded inline descriptors; unlimited paged retrieval', typedErrors: ['target_not_supported', 'timeout', 'cancelled'] }),
  definition({ name: 'sez.shell', description: 'Execute arbitrary shell text using /bin/bash -lc by default or an explicit shell/argument vector.', inputSchema: objectSchema({ command: string, shell: pathString, shellArgs: { type: 'array', items: string }, ...execCommon }, ['command']), mutating: true, durableJobBehavior: 'always creates a durable job before launch', streamBehavior: 'separate durable binary stdout/stderr; bounded inline descriptors; unlimited paged retrieval', typedErrors: ['target_not_supported', 'timeout', 'cancelled'] }),
  definition({ name: 'sez.job.get', description: 'Read and reconcile one durable job.', inputSchema: objectSchema({ jobId: string }, ['jobId']), typedErrors: ['not_found', 'job_lost', 'job_ambiguous'] }),
  definition({ name: 'sez.job.list', description: 'List durable jobs ordered by durable local sequence.', inputSchema: objectSchema({ state: string, limit: integer }, []), typedErrors: ['state_corrupt'] }),
  definition({ name: 'sez.job.wait', description: 'Wait for a bounded duration and return actual current or terminal state without inventing completion.', inputSchema: objectSchema({ jobId: string, waitMs: integer, stdoutOffset: integer, stderrOffset: integer, streamLength: integer }, ['jobId']), streamBehavior: 'optional bounded stdout/stderr pages from exact offsets', typedErrors: ['not_found', 'job_lost', 'job_ambiguous'] }),
  definition({ name: 'sez.job.cancel', description: 'Cancel the exact durable process identity and report observed state.', inputSchema: objectSchema({ jobId: string, signal: { enum: ['SIGTERM', 'SIGINT', 'SIGHUP'] }, waitMs: integer }, ['jobId']), mutating: true, typedErrors: ['not_found', 'cancelled', 'job_ambiguous'] }),
  definition({ name: 'sez.job.stream.read', description: 'Read exact binary stdout/stderr pages from a stable stream handle or job identity.', inputSchema: objectSchema({ jobId: string, handle: string, stream: { enum: ['stdout', 'stderr'] }, offset: integer, length: integer }, []), streamBehavior: 'binary-safe base64 page with offsets, byte counts, page digest, committed/final digest', typedErrors: ['not_found', 'offset_out_of_range'] }),

  definition({ name: 'sez.file.stat', description: 'Return lstat by default or explicit followed stat metadata.', inputSchema: objectSchema({ path: pathString, followSymlinks: boolean }, ['path']), typedErrors: ['not_found'] }),
  definition({ name: 'sez.file.read', description: 'Read a bounded binary-safe page from any absolute host path.', inputSchema: objectSchema({ path: pathString, offset: integer, length: integer, encoding: { enum: ['base64', 'utf8', 'hex'] }, followSymlinks: boolean }, ['path']), streamBehavior: 'bounded page; repeated offsets deterministic', typedErrors: ['not_found', 'offset_out_of_range'] }),
  definition({ name: 'sez.file.write', description: 'Create/truncate/overwrite or write at an explicit offset with optional fsync.', inputSchema: objectSchema({ path: pathString, data, encoding: { enum: ['base64', 'utf8', 'hex'] }, offset: integer, create: boolean, truncate: boolean, mode: { oneOf: [string, integer] }, flush: boolean, followSymlinks: boolean }, ['path', 'data']), mutating: true, typedErrors: ['not_found', 'conflict'] }),
  definition({ name: 'sez.file.replace', description: 'Atomically replace a regular file on the same filesystem with fsync and optional compare-and-swap digest.', inputSchema: objectSchema({ path: pathString, data, encoding: { enum: ['base64', 'utf8', 'hex'] }, mode: { oneOf: [string, integer] }, uid: { oneOf: [string, integer] }, gid: { oneOf: [string, integer] }, preserveMetadata: boolean, expectedSha256: string, expectedAbsent: boolean }, ['path', 'data']), mutating: true, typedErrors: ['digest_mismatch', 'conflict'] }),
  definition({ name: 'sez.file.patch', description: 'Apply exact offset/remove/insert patches bound to the expected source SHA-256.', inputSchema: objectSchema({ path: pathString, expectedSha256: string, patches: { type: 'array', minItems: 1, items: objectSchema({ offset: integer, removeLength: integer, data, encoding: { enum: ['base64', 'utf8', 'hex'] } }, ['offset', 'removeLength', 'data']) }, mode: { oneOf: [string, integer] }, uid: { oneOf: [string, integer] }, gid: { oneOf: [string, integer] } }, ['path', 'expectedSha256', 'patches']), mutating: true, typedErrors: ['digest_mismatch', 'offset_out_of_range', 'conflict'] }),
  definition({ name: 'sez.file.copy', description: 'Copy a file, symlink, or explicitly recursive directory without a root allowlist.', inputSchema: objectSchema({ source: pathString, destination: pathString, overwrite: boolean, recursive: boolean, preserveTimestamps: boolean, dereference: boolean }, ['source', 'destination']), mutating: true, typedErrors: ['not_found', 'conflict'] }),
  definition({ name: 'sez.file.move', description: 'Rename atomically or explicitly perform copy-delete across filesystems.', inputSchema: objectSchema({ source: pathString, destination: pathString, overwrite: boolean, crossFilesystem: boolean }, ['source', 'destination']), mutating: true, typedErrors: ['not_found', 'conflict'] }),
  definition({ name: 'sez.file.remove', description: 'Remove a path; recursive removal requires recursive=true.', inputSchema: objectSchema({ path: pathString, recursive: boolean, force: boolean }, ['path']), mutating: true, typedErrors: ['not_found', 'conflict'] }),
  definition({ name: 'sez.file.list', description: 'List bounded directory pages with explicit symlink behavior.', inputSchema: objectSchema({ path: pathString, offset: integer, limit: integer, includeHidden: boolean, followSymlinks: boolean }, ['path']), typedErrors: ['not_found'] }),
  definition({ name: 'sez.file.mkdir', description: 'Create a directory with explicit recursive and mode behavior.', inputSchema: objectSchema({ path: pathString, recursive: boolean, mode: { oneOf: [string, integer] } }, ['path']), mutating: true, typedErrors: ['conflict'] }),
  definition({ name: 'sez.file.chmod', description: 'Change mode with explicit symlink-following behavior.', inputSchema: objectSchema({ path: pathString, mode: { oneOf: [string, integer] }, followSymlinks: boolean }, ['path', 'mode']), mutating: true, typedErrors: ['not_found', 'conflict'] }),
  definition({ name: 'sez.file.chown', description: 'Change UID/GID by numeric ID or system name with explicit symlink behavior.', inputSchema: objectSchema({ path: pathString, uid: { oneOf: [string, integer] }, gid: { oneOf: [string, integer] }, followSymlinks: boolean }, ['path']), mutating: true, typedErrors: ['not_found'] }),
  definition({ name: 'sez.file.link', description: 'Create a hard link.', inputSchema: objectSchema({ existingPath: pathString, newPath: pathString }, ['existingPath', 'newPath']), mutating: true, typedErrors: ['not_found', 'conflict'] }),
  definition({ name: 'sez.file.symlink', description: 'Create a symbolic link; the target may be relative or absolute and the link path is absolute.', inputSchema: objectSchema({ target: string, path: pathString, type: string }, ['target', 'path']), mutating: true, typedErrors: ['conflict'] }),
  definition({ name: 'sez.file.truncate', description: 'Truncate a regular file to an exact length with explicit symlink behavior.', inputSchema: objectSchema({ path: pathString, length: integer, followSymlinks: boolean }, ['path', 'length']), mutating: true, typedErrors: ['not_found', 'conflict'] }),

  definition({ name: 'sez.pty.create', description: 'Create a durable tmux-backed PTY session with stable ID and output offset store.', inputSchema: objectSchema({ shell: pathString, shellArgs: { type: 'array', items: string }, cwd: pathString, cols: integer, rows: integer, environment: { type: 'object', additionalProperties: { type: 'string' } } }, []), mutating: true, durableJobBehavior: 'persistent tmux process survives supervisor restart; after host reboot the session reconciles honestly', streamBehavior: 'binary-safe persistent PTY output pages', typedErrors: ['job_lost'] }),
  definition({ name: 'sez.pty.input', description: 'Deliver exact base64 or UTF-8 bytes to a persistent PTY.', inputSchema: objectSchema({ sessionId: string, data, encoding: { enum: ['base64', 'utf8'] } }, ['sessionId', 'data']), mutating: true, typedErrors: ['not_found', 'job_lost'] }),
  definition({ name: 'sez.pty.resize', description: 'Resize a persistent PTY window.', inputSchema: objectSchema({ sessionId: string, cols: integer, rows: integer }, ['sessionId', 'cols', 'rows']), mutating: true, typedErrors: ['not_found', 'job_lost'] }),
  definition({ name: 'sez.pty.read', description: 'Read deterministic PTY output from an exact byte offset.', inputSchema: objectSchema({ sessionId: string, offset: integer, length: integer }, ['sessionId']), streamBehavior: 'binary-safe base64 page with exact offsets and final digest', typedErrors: ['not_found', 'offset_out_of_range', 'job_lost'] }),
  definition({ name: 'sez.pty.close', description: 'Close a persistent PTY session and finalize its output digest.', inputSchema: objectSchema({ sessionId: string }, ['sessionId']), mutating: true, typedErrors: ['not_found'] }),

  definition({ name: 'sez.artifact.create', description: 'Create and atomically finalize an immutable artifact from an existing host file.', inputSchema: objectSchema({ sourcePath: pathString, name: string, mediaType: string, metadata: { type: 'object' } }, ['sourcePath']), mutating: true, streamBehavior: 'artifact data remains external and paged', typedErrors: ['not_found', 'digest_mismatch'] }),
  definition({ name: 'sez.artifact.begin', description: 'Begin a resumable artifact upload with declared size and SHA-256.', inputSchema: objectSchema({ name: string, mediaType: string, size: integer, sha256: string, metadata: { type: 'object' } }, ['size', 'sha256']), mutating: true, typedErrors: ['conflict'] }),
  definition({ name: 'sez.artifact.upload', description: 'Upload an exact-offset artifact chunk; exact duplicate retries are idempotent and conflicts fail.', inputSchema: objectSchema({ artifactId: string, offset: integer, data, encoding: { enum: ['base64', 'hex'] } }, ['artifactId', 'offset', 'data']), mutating: true, streamBehavior: 'bounded binary-safe chunk upload', typedErrors: ['not_found', 'offset_out_of_range', 'conflict'] }),
  definition({ name: 'sez.artifact.finalize', description: 'Verify size/digest and atomically finalize an immutable artifact.', inputSchema: objectSchema({ artifactId: string }, ['artifactId']), mutating: true, typedErrors: ['not_found', 'digest_mismatch', 'conflict'] }),
  definition({ name: 'sez.artifact.abort', description: 'Abort an interrupted artifact upload.', inputSchema: objectSchema({ artifactId: string }, ['artifactId']), mutating: true, typedErrors: ['not_found', 'conflict'] }),
  definition({ name: 'sez.artifact.download', description: 'Download a bounded exact artifact page with page and full digests.', inputSchema: objectSchema({ artifactId: string, offset: integer, length: integer }, ['artifactId']), streamBehavior: 'binary-safe base64 pages with deterministic offsets', typedErrors: ['not_found', 'offset_out_of_range', 'conflict'] }),
  definition({ name: 'sez.artifact.get', description: 'Read artifact metadata without raw data.', inputSchema: objectSchema({ artifactId: string }, ['artifactId']), typedErrors: ['not_found'] }),
  definition({ name: 'sez.artifact.list', description: 'List bounded artifact metadata pages.', inputSchema: objectSchema({ state: string, offset: integer, limit: integer }, []) }),
  definition({ name: 'sez.artifact.remove', description: 'Explicitly delete artifact data and retain a removed metadata tombstone.', inputSchema: objectSchema({ artifactId: string }, ['artifactId']), mutating: true, typedErrors: ['not_found'] }),
  definition({ name: 'sez.github.app.verify', description: 'Verify the configured GitHub App, installation, repository and ephemeral token authority.', inputSchema: objectSchema({ repository: string }, ['repository']), typedErrors: ['github_app_unavailable','github_installation_mismatch','github_permission_missing'] }),
  definition({ name: 'sez.github.api', description: 'Perform a generic GitHub REST request with internally injected ephemeral installation authority.', inputSchema: { type:'object', additionalProperties:true }, mutating: true, typedErrors: ['github_request_failed','github_write_ambiguous'] }),
  definition({ name: 'sez.github.git', description: 'Perform generic Git transport with an operation-owned HOME and protected credential helper.', inputSchema: { type:'object', additionalProperties:true }, mutating: true, typedErrors: ['github_request_failed','github_cleanup_failed'] }),
  definition({ name: 'sez.github.reconcile', description: 'Reconcile an uncertain GitHub write without repeating the mutation.', inputSchema: { type:'object', additionalProperties:true }, typedErrors: ['github_write_ambiguous','github_cleanup_failed'] }),
  definition({ name: 'sez.release.status', description: 'Read durable 0.1B release transaction, candidate, slot, fencing and repair state.', inputSchema: objectSchema({ deploymentId: string }, ['deploymentId']) }),
  definition({ name: 'sez.release.build', description: 'Build or resume an exact-source deterministic 0.1B candidate.', inputSchema: { type:'object', additionalProperties:true }, mutating: true, typedErrors: ['release_stage_failed'] }),
  definition({ name: 'sez.release.stage', description: 'Stage an inactive supervisor, gateway and isolated gateway state slot.', inputSchema: objectSchema({ deploymentId: string }, ['deploymentId']), mutating: true, typedErrors: ['release_stage_failed'] }),
  definition({ name: 'sez.release.verify', description: 'Verify candidate manifests, identities, schemas, services and signing paths.', inputSchema: { type:'object', additionalProperties:true }, typedErrors: ['release_verify_failed'] }),
  definition({ name: 'sez.release.activate', description: 'Activate through the required fencing authority; production fails closed without Recovery.', inputSchema: { type:'object', additionalProperties:true }, mutating: true, typedErrors: ['release_recovery_unavailable','release_activation_failed'] }),
  definition({ name: 'sez.release.rollback', description: 'Fence and roll an isolated candidate back while preserving monotonic OAuth security truth.', inputSchema: { type:'object', additionalProperties:true }, mutating: true, typedErrors: ['release_rollback_failed'] }),
  definition({ name: 'sez.release.repair', description: 'Repair interrupted or ambiguous release state by actual pointer, writer and slot readback.', inputSchema: objectSchema({ deploymentId: string }, ['deploymentId']), mutating: true, typedErrors: ['release_repair_required'] }),
]);

export const ACTIVE_OPERATION_NAMES = Object.freeze(ACTIVE_OPERATION_DEFINITIONS.map((entry) => entry.name));
export const ACTIVE_OPERATION_SET = new Set(ACTIVE_OPERATION_NAMES);
export const CATALOG_DIGEST = digestCatalog(ACTIVE_OPERATION_DEFINITIONS);

export const EXTRACTED_INACTIVE_FAMILIES = Object.freeze([
  'sez.skill.*', 'sez.selfhost.*',
]);
export const FUTURE_CANONICAL_FAMILIES = Object.freeze([
  'sez.machine.*', 'sez.recovery.*', 'sez.backup.*', 'sez.evidence.*',

]);

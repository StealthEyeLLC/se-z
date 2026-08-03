// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
export const CANONICAL_SEZ_ACTION_DESCRIPTION = 'Run one authorized se-z operation through the single authenticated se-z interface and return its durable result with verified signed evidence.';

const sourceCapabilities = [
  ['sez.describe', 'discovery', 'Describe installed capabilities, schemas, limits, release identity, and invocation rules.'],
  ['sez.health', 'health', 'Read runtime, host, protocol, supervisor, and release health.'],
  ['sez.exec', 'execution', 'Execute an exact executable and argument vector as a durable root job.'],
  ['sez.shell', 'execution', 'Execute a shell procedure as a durable root job.'],
  ['sez.job.get', 'jobs', 'Read one durable job.'],
  ['sez.job.list', 'jobs', 'List durable jobs.'],
  ['sez.job.wait', 'jobs', 'Wait for a durable job to reach a terminal state.'],
  ['sez.job.cancel', 'jobs', 'Persist cancellation intent for a running job.'],
  ['sez.job.stream.read', 'jobs', 'Read stdout or stderr from an exact durable offset.'],
  ['sez.file.stat', 'files', 'Read file metadata.'],
  ['sez.file.read', 'files', 'Read a binary-safe file page.'],
  ['sez.file.write', 'files', 'Write binary-safe file content with legacy overwrite semantics.'],
  ['sez.file.replace', 'files', 'Atomically replace a file beneath an explicit root with compare-and-swap preconditions.'],
  ['sez.file.patch', 'files', 'Patch file content at exact offsets.'],
  ['sez.file.copy', 'files', 'Copy a file or tree.'],
  ['sez.file.move', 'files', 'Move or rename a path.'],
  ['sez.file.remove', 'files', 'Remove a file or directory.'],
  ['sez.file.list', 'files', 'List directory entries.'],
  ['sez.pty.create', 'pty', 'Create a persistent interactive terminal.'],
  ['sez.pty.input', 'pty', 'Send input to a persistent terminal.'],
  ['sez.pty.resize', 'pty', 'Resize a persistent terminal.'],
  ['sez.pty.read', 'pty', 'Read persistent terminal output from an exact offset.'],
  ['sez.pty.close', 'pty', 'Close a persistent terminal.'],
  ['sez.artifact.create', 'artifacts', 'Create a finalized digest-addressed artifact from a host file.'],
  ['sez.artifact.begin', 'artifacts', 'Begin an explicit resumable artifact upload.'],
  ['sez.artifact.upload', 'artifacts', 'Upload one contiguous artifact chunk.'],
  ['sez.artifact.finalize', 'artifacts', 'Verify size and SHA-256 and finalize an immutable artifact.'],
  ['sez.artifact.abort', 'artifacts', 'Abort an incomplete artifact upload.'],
  ['sez.artifact.download', 'artifacts', 'Download a finalized artifact page resumably.'],
  ['sez.artifact.list', 'artifacts', 'List artifact records.'],
  ['sez.artifact.get', 'artifacts', 'Read artifact metadata.'],
  ['sez.release.status', 'release', 'Read durable standalone deployment state and evidence indexes.'],
  ['sez.release.build', 'release', 'Build exact Sez and gateway sources reproducibly.'],
  ['sez.release.stage', 'release', 'Verify compatibility and stage inactive candidates.'],
  ['sez.release.verify', 'release', 'Verify deployment identity, evidence, and terminal truth.'],
  ['sez.release.activate', 'release', 'Activate gateway first under the independent rollback guard.'],
  ['sez.release.rollback', 'release', 'Request and reconcile deterministic guarded rollback.'],
  ['sez.release.repair', 'release', 'Reconcile incomplete or ambiguous durable deployment state.'],
  ['sez.release.prune', 'release', 'Prune only unprotected inactive release data.'],
  ['sez.selfhost.source.get', 'selfhost', 'Read exact deployment-owned source identities.'],
  ['sez.selfhost.acceptance.run', 'selfhost', 'Run a fixed bounded acceptance profile.'],
  ['sez.selfhost.evidence.get', 'selfhost', 'Read bounded signed content-addressed evidence.'],
];

export const SEZ_CAPABILITIES = Object.freeze(
  sourceCapabilities.map(([operation, family, description]) => Object.freeze({ operation, family, description })),
);

export const LEGACY_SEZ_CAPABILITIES = Object.freeze(
  SEZ_CAPABILITIES.slice(0, 31).filter((capability) => ![
    'sez.describe',
    'sez.file.replace',
    'sez.artifact.begin',
    'sez.artifact.finalize',
    'sez.artifact.abort',
  ].includes(capability.operation)),
);

function runtimeCapabilities(runtime) {
  if (!runtime || !Array.isArray(runtime.operations)) return undefined;
  return Object.freeze(runtime.operations.map((definition) => Object.freeze({ ...definition })));
}

export function describeSez(runtime = undefined, connection = undefined) {
  const discovered = runtimeCapabilities(runtime);
  const fallback = discovered === undefined;
  return Object.freeze({
    product: 'se-z',
    publicTool: 'call_sez',
    actionDescription: CANONICAL_SEZ_ACTION_DESCRIPTION,
    discoveryOperation: 'sez.describe',
    discoverySource: fallback ? 'gateway_legacy_fallback' : 'signed_runtime',
    protocol: runtime?.protocolVersion ? `SEZ1/${runtime.protocolVersion}` : 'SEZ1/1.0.0',
    deployedVersion: runtime?.release?.version ?? '0.1.3',
    sourceCommit: runtime?.release?.commit ?? '6db0298758ef8080cd80adbce2b652333018e3f1',
    capabilities: discovered ?? LEGACY_SEZ_CAPABILITIES,
    runtime: runtime ?? null,
    connection: connection ?? null,
    skills: Object.freeze({
      available: false,
      reason: 'se-z exposes primitive recovery capabilities; Full Sez adds durable skills.',
    }),
    evidence: fallback
      ? Object.freeze(['legacy gateway catalog', 'signed runtime unknown-operation probe when available'])
      : Object.freeze(['signed runtime discovery response', 'verified receipt', 'installed release identity']),
    warning: fallback
      ? 'The installed se-z runtime does not expose sez.describe. Only the legacy fallback capabilities are advertised.'
      : undefined,
  });
}

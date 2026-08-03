#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { SOURCE_IDENTITIES, applyMechanicalIdentity } from './source-layout.mjs';
import { OPERATION_DEFINITIONS as targetDefinitions } from '../../src/operations/definitions.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type OperationDefinition = Record<string, unknown> & {
  operation: string;
  family: string;
  version: string;
  input: unknown;
  mutation: boolean;
  idempotency: string;
};

const root = process.cwd();
const identityRecord = JSON.parse(fs.readFileSync(path.join(root, 'vendor/baby-provenance/source-identities.json'), 'utf8'));
const sourceIdentityProof = JSON.parse(fs.readFileSync(path.join(root, 'evidence/phase1/source-identity-proof.json'), 'utf8'));
const outputJson = path.join(root, 'contracts/phase1-capability-map.json');
const outputMarkdown = path.join(root, 'docs/PHASE1_CAPABILITY_PARITY.md');

function stable(value: unknown): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]));
  }
  throw new TypeError(`Unsupported canonical value: ${typeof value}`);
}

function canonical(value: unknown): string {
  return JSON.stringify(stable(value));
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function sourceRoot(): string {
  const candidates = [
    process.env.SEZ_PHASE1_SUPERVISOR_SOURCE,
    path.join(root, '.phase1-sources/baby-quirt'),
    path.resolve(root, '../sources/baby-quirt'),
    path.resolve(root, '../baby-quirt'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'src/operations/definitions.ts'))) return candidate;
  }
  throw new Error('Exact pinned baby-quirt source is unavailable; run phase1:materialize-source first');
}

function normalizedSourceDefinition(definition: OperationDefinition): unknown {
  return JSON.parse(applyMechanicalIdentity(JSON.stringify(definition)));
}

const familyInfo: Record<string, {
  destination: string[];
  sourceTests: string[];
  targetTests: string[];
  parityTest: string;
  state: string;
  deltas: string[];
  notes: string;
}> = {
  discovery: {
    destination: ['src/operations/definitions.ts', 'src/operations/registry.ts', 'src/supervisor/server/server.ts'],
    sourceTests: ['test/operations-discovery.test.ts', 'integration/server.test.ts'],
    targetTests: ['test/extracted/supervisor/unit/operations-discovery.test.ts', 'test/extracted/supervisor/integration/server.test.ts'],
    parityTest: 'test/parity/catalog/catalog-parity.test.ts', state: 'MECHANICALLY_RENAMED',
    deltas: ['DELTA-PROTOCOL-001', 'DELTA-CATALOG-001'], notes: 'Extracted catalog mechanics; target canonical catalog remains specification-only until 0.1A integration.',
  },
  health: {
    destination: ['src/operations/definitions.ts', 'src/supervisor/server/server.ts'],
    sourceTests: ['integration/server.test.ts'], targetTests: ['test/extracted/supervisor/integration/server.test.ts'],
    parityTest: 'test/parity/catalog/catalog-parity.test.ts', state: 'MECHANICALLY_RENAMED', deltas: [], notes: 'Health mechanics are extracted; no production se-z listener is activated in Phase 1.',
  },
  github: {
    destination: ['src/github/app-authority.ts', 'src/operations/definitions.ts'],
    sourceTests: ['test/github-app-authority.test.ts'], targetTests: ['test/extracted/supervisor/unit/github-app-authority.test.ts'],
    parityTest: 'test/parity/github/github-parity.test.ts', state: 'MECHANICALLY_RENAMED', deltas: ['DELTA-GITHUB-001'], notes: 'The proven verification/proof operations are retained. Generic sez.github.api and sez.github.git remain 0.1A work.',
  },
  execution: {
    destination: ['src/jobs/manager.ts', 'src/execution/process/identity.ts'],
    sourceTests: ['test/jobs.test.ts', 'acceptance/jobs.test.ts', 'acceptance/process-identity.test.ts'],
    targetTests: ['test/extracted/supervisor/unit/jobs.test.ts', 'test/extracted/supervisor/acceptance/jobs.test.ts', 'test/extracted/supervisor/acceptance/process-identity.test.ts'],
    parityTest: 'test/parity/execution/execution-parity.test.ts', state: 'MECHANICALLY_RENAMED', deltas: ['DELTA-OUTPUT-001'], notes: 'Exact argv and shell mechanics are retained. Durable unlimited output is assigned to 0.1A.',
  },
  job: {
    destination: ['src/jobs/manager.ts', 'src/state/store/store.ts'],
    sourceTests: ['test/jobs.test.ts', 'test/idempotency.test.ts', 'acceptance/jobs.test.ts', 'acceptance/cancellation.test.ts', 'acceptance/restart.test.ts'],
    targetTests: ['test/extracted/supervisor/unit/jobs.test.ts', 'test/extracted/supervisor/unit/idempotency.test.ts', 'test/extracted/supervisor/acceptance/jobs.test.ts', 'test/extracted/supervisor/acceptance/cancellation.test.ts', 'test/extracted/supervisor/acceptance/restart.test.ts'],
    parityTest: 'test/parity/jobs/jobs-parity.test.ts', state: 'MECHANICALLY_RENAMED', deltas: ['DELTA-OUTPUT-001', 'DELTA-RESUME-001'], notes: 'Durable job mechanics are retained; deterministic server-side request resume remains 0.1A.',
  },
  file: {
    destination: ['src/files/manager.ts'], sourceTests: ['test/files.test.ts', 'acceptance/filesystem.test.ts'],
    targetTests: ['test/extracted/supervisor/unit/files.test.ts', 'test/extracted/supervisor/acceptance/filesystem.test.ts'],
    parityTest: 'test/parity/files/files-parity.test.ts', state: 'MECHANICALLY_RENAMED', deltas: [], notes: 'Raw file mechanics are retained with temporary-root parity coverage.',
  },
  pty: {
    destination: ['src/pty/manager.ts', 'src/state/store/store.ts'], sourceTests: ['acceptance/pty.test.ts', 'acceptance/restart.test.ts'],
    targetTests: ['test/extracted/supervisor/acceptance/pty.test.ts', 'test/extracted/supervisor/acceptance/restart.test.ts'],
    parityTest: 'test/parity/pty/pty-parity.test.ts', state: 'MECHANICALLY_RENAMED', deltas: ['DELTA-RESUME-001'], notes: 'PTY mechanics and restart discovery are retained; final deterministic request resume remains 0.1A.',
  },
  artifact: {
    destination: ['src/artifacts/manager.ts'], sourceTests: ['test/artifacts.test.ts'], targetTests: ['test/extracted/supervisor/unit/artifacts.test.ts'],
    parityTest: 'test/parity/artifacts/artifacts-parity.test.ts', state: 'MECHANICALLY_RENAMED', deltas: [], notes: 'Artifact upload, resume, digest, immutable finalize, download, list, and abort mechanics are retained.',
  },
  release: {
    destination: ['src/releases/', 'src/operations/definitions.ts'],
    sourceTests: ['test/deployment-state-machine-v2.test.ts', 'test/deployment-operations.test.ts', 'test/release-manifest-v2.test.ts', 'acceptance/release.test.ts'],
    targetTests: ['test/extracted/supervisor/unit/deployment-state-machine-v2.test.ts', 'test/extracted/supervisor/unit/deployment-operations.test.ts', 'test/extracted/supervisor/unit/release-manifest-v2.test.ts', 'test/extracted/supervisor/acceptance/release.test.ts'],
    parityTest: 'test/parity/releases/releases-parity.test.ts', state: 'EXTRACTED_NOT_INTEGRATED', deltas: ['DELTA-RECOVERY-001', 'DELTA-RELEASE-IDENTITY-001'], notes: 'Isolated release mechanics are retained. Final separately versioned recovery and activation transaction are 0.1C.',
  },
  selfhost: {
    destination: ['src/selfhost/', 'scripts/extracted/supervisor/'],
    sourceTests: ['test/controller-bootstrap.test.ts', 'test/controller-guard.test.ts', 'acceptance/self-hosting.test.ts', 'acceptance/self-hosting-full.test.ts'],
    targetTests: ['test/extracted/supervisor/unit/controller-bootstrap.test.ts', 'test/extracted/supervisor/unit/controller-guard.test.ts', 'test/extracted/supervisor/acceptance/self-hosting.test.ts', 'test/extracted/supervisor/acceptance/self-hosting-full.test.ts'],
    parityTest: 'test/parity/releases/releases-parity.test.ts', state: 'EXTRACTED_NOT_INTEGRATED', deltas: ['DELTA-RECOVERY-001', 'DELTA-TOOLCHAIN-001'], notes: 'Self-hosting mechanics are extracted and testable in fixtures, not activated in production.',
  },
  skill: {
    destination: ['src/skills/', 'src/operations/definitions.ts'], sourceTests: ['test/skill-loader.test.ts'], targetTests: ['test/extracted/supervisor/unit/skill-loader.test.ts'],
    parityTest: 'test/parity/skills/skills-parity.test.ts', state: 'EXTRACTED_NOT_INTEGRATED', deltas: ['DELTA-CATALOG-001'], notes: 'Immutable bundle/set mechanics are retained; no target skill set is activated in Phase 1.',
  },
};

const internalCapabilities = [
  ['protocol framing', 'protocol', 'src/protocol/frame.ts', 'src/protocol/framing/frame.ts', 'MECHANICALLY_RENAMED', ['DELTA-PROTOCOL-001']],
  ['canonical encoding', 'canonical encoding', 'src/crypto/canonical.ts', 'src/protocol/canonical/canonical.ts', 'MECHANICALLY_RENAMED', ['DELTA-AUTHORITY-001']],
  ['peer authorization', 'peer authorization', 'src/net/peer-cred.ts', 'src/supervisor/peers/peer-cred.ts', 'EXTRACTED_NOT_INTEGRATED', ['DELTA-PEERS-001']],
  ['native SO_PEERCRED addon', 'native addon', 'native/src/peer_cred.cc', 'src/native/peercred/src/peer_cred.cc', 'PRESERVED_DIRECTLY', []],
  ['request authentication', 'request authentication', 'src/auth/authenticator.ts', 'src/supervisor/dispatch/auth/authenticator.ts', 'EXTRACTED_NOT_INTEGRATED', ['DELTA-AUTHORITY-001']],
  ['request signatures and keys', 'signatures and keys', 'src/crypto/signing.ts', 'src/protocol/signatures/signing.ts', 'MECHANICALLY_RENAMED', ['DELTA-AUTHORITY-001']],
  ['signed receipts', 'receipts', 'src/receipts/', 'src/protocol/receipts/', 'MECHANICALLY_RENAMED', []],
  ['nonce replay', 'replay', 'src/state/replay-store.ts', 'src/state/replay/store.ts', 'MECHANICALLY_RENAMED', []],
  ['semantic idempotency', 'idempotency', 'src/jobs/manager.ts', 'src/jobs/manager.ts', 'MECHANICALLY_RENAMED', []],
  ['durable state store', 'state storage', 'src/state/store.ts', 'src/state/store/store.ts', 'MECHANICALLY_RENAMED', ['DELTA-STATE-OWNERSHIP-001']],
  ['exact argv and shell execution', 'raw execution', 'src/jobs/manager.ts', 'src/jobs/manager.ts', 'MECHANICALLY_RENAMED', ['DELTA-OUTPUT-001']],
  ['durable jobs', 'jobs', 'src/jobs/manager.ts', 'src/jobs/manager.ts', 'MECHANICALLY_RENAMED', ['DELTA-RESUME-001']],
  ['stdout and stderr streams', 'streams', 'src/jobs/manager.ts', 'src/jobs/manager.ts', 'MECHANICALLY_RENAMED', ['DELTA-OUTPUT-001']],
  ['raw files', 'files', 'src/files/manager.ts', 'src/files/manager.ts', 'MECHANICALLY_RENAMED', []],
  ['PTY sessions', 'PTY', 'src/pty/manager.ts', 'src/pty/manager.ts', 'MECHANICALLY_RENAMED', ['DELTA-RESUME-001']],
  ['artifacts', 'artifacts', 'src/artifacts/manager.ts', 'src/artifacts/manager.ts', 'MECHANICALLY_RENAMED', []],
  ['operation registry', 'operation registry', 'src/operations/registry.ts', 'src/operations/registry.ts', 'MECHANICALLY_RENAMED', ['DELTA-CATALOG-001']],
  ['dynamic catalog', 'catalog', 'src/operations/registry.ts', 'src/operations/registry.ts', 'EXTRACTED_NOT_INTEGRATED', ['DELTA-CATALOG-001']],
  ['immutable skills', 'skills', 'src/skills/', 'src/skills/', 'EXTRACTED_NOT_INTEGRATED', ['DELTA-CATALOG-001']],
  ['release lifecycle', 'release lifecycle', 'src/release/ and src/deployment/', 'src/releases/', 'EXTRACTED_NOT_INTEGRATED', ['DELTA-RECOVERY-001']],
  ['self-hosting', 'self-hosting', 'src/controller/ and src/install/', 'src/selfhost/', 'EXTRACTED_NOT_INTEGRATED', ['DELTA-RECOVERY-001']],
  ['recovery source mechanics', 'recovery source mechanics', 'src/deployment/ and src/cli/repair.ts', 'src/releases/ and src/supervisor/cli/repair.ts', 'DEFERRED_TO_0.1C', ['DELTA-RECOVERY-001']],
  ['GitHub App authority', 'GitHub authority', 'src/github/app-authority.ts', 'src/github/app-authority.ts', 'MECHANICALLY_RENAMED', ['DELTA-GITHUB-001']],
  ['MCP one-tool gateway', 'MCP gateway', 'baby-quirt-mcp/src/tool.js and src/server.js', 'src/gateway/mcp/', 'EXTRACTED_NOT_INTEGRATED', ['DELTA-TOOL-001', 'DELTA-TRANSPORT-001']],
  ['OAuth and token lifecycle', 'OAuth', 'baby-quirt-mcp/src/oauth-server.js', 'src/auth/oauth/', 'EXTRACTED_NOT_INTEGRATED', ['DELTA-SCOPE-001', 'DELTA-REFRESH-001', 'DELTA-OAUTH-STATE-001']],
  ['configuration', 'configuration', 'src/config.ts and gateway src/config.js', 'src/supervisor/configuration/ and src/gateway/configuration/', 'EXTRACTED_NOT_INTEGRATED', ['DELTA-PEERS-001']],
  ['CLI mechanics', 'CLI', 'src/cli/ and gateway bin/', 'src/supervisor/cli/ and src/gateway/cli/', 'EXTRACTED_NOT_INTEGRATED', []],
  ['packaging', 'packaging', 'scripts/ and release source', 'scripts/extracted/ and packaging/', 'EXTRACTED_NOT_INTEGRATED', ['DELTA-RELEASE-IDENTITY-001']],
  ['systemd assets', 'systemd', 'ops/systemd/', 'packaging/systemd/', 'EXTRACTED_NOT_INTEGRATED', ['DELTA-PEERS-001']],
  ['Caddy assets', 'Caddy', 'baby-quirt-mcp/ops/caddy/', 'packaging/caddy/', 'SUPERSEDED_BY_CANONICAL_TARGET', ['DELTA-TRANSPORT-001']],
  ['source broad secret redaction', 'raw output policy', 'src/crypto/canonical.ts and selected error paths', 'historical source tests and docs/PHASE1_CANONICAL_DELTA.md', 'INTENTIONALLY_NOT_CARRIED', ['DELTA-SECRET-001']],
  ['nspawn rehearsal and deployment mechanics', 'nspawn', 'src/rehearsal/ and deployment source', 'src/releases/rehearsal/ and isolated release fixtures', 'DEFERRED_TO_0.1C', ['DELTA-NSPAWN-001']],
  ['KVM lifecycle', 'KVM', 'not present in the installed source catalog', 'future bundled z integration', 'DEFERRED_TO_0.1C', ['DELTA-KVM-001']],
] as const;

const sourceDirectory = sourceRoot();
const sourceModule = await import(pathToFileURL(path.join(sourceDirectory, 'src/operations/definitions.ts')).href);
const sourceDefinitions = sourceModule.OPERATION_DEFINITIONS as OperationDefinition[];
const target = targetDefinitions as unknown as OperationDefinition[];
if (sourceDefinitions.length !== 48 || target.length !== 48) throw new Error(`Expected 48 core definitions, found source=${sourceDefinitions.length} target=${target.length}`);

const operations = sourceDefinitions.map((source, index) => {
  const targetDefinition = target[index];
  const expectedTargetOperation = source.operation.replace(/^baby\./u, 'sez.');
  if (targetDefinition.operation !== expectedTargetOperation) throw new Error(`Operation mapping mismatch at ${source.operation}: ${targetDefinition.operation}`);
  if (source.family !== targetDefinition.family || source.version !== targetDefinition.version) throw new Error(`Family/version mismatch for ${source.operation}`);
  const info = familyInfo[source.family];
  if (!info) throw new Error(`Unclassified operation family: ${source.family}`);
  const normalized = normalizedSourceDefinition(source);
  const definitionParity = canonical(normalized) === canonical(targetDefinition);
  return {
    sourceOperation: source.operation,
    sourceFamily: source.family,
    sourceVersion: source.version,
    sourceSchemaDigest: digest(source.input),
    sourceDefinitionDigest: digest(source),
    targetOperation: targetDefinition.operation,
    targetFamily: targetDefinition.family,
    targetSchemaDigest: digest(targetDefinition.input),
    targetDefinitionDigest: digest(targetDefinition),
    targetSchemaStatus: definitionParity ? 'SCHEMA_EQUIVALENT_AFTER_MECHANICAL_IDENTITY_NORMALIZATION' : 'EXPLICIT_CANONICAL_DIFFERENCE',
    destinationImplementation: info.destination,
    sourceTests: info.sourceTests,
    targetParityTests: [info.parityTest, ...info.targetTests],
    state: info.state,
    integratedOperation: false,
    productionSupportedOperation: false,
    canonicalDelta: info.deltas,
    notes: info.notes,
  };
});

const proofSkillManifest = JSON.parse(fs.readFileSync(path.join(sourceDirectory, 'examples/skills/proof-echo/skill.json'), 'utf8'));
const proofOperation = proofSkillManifest.operations[0];
operations.push({
  sourceOperation: proofOperation.operation,
  sourceFamily: 'skill',
  sourceVersion: proofOperation.version,
  sourceSchemaDigest: digest(proofOperation.input),
  sourceDefinitionDigest: digest(proofOperation),
  targetOperation: proofOperation.operation.replace(/^baby\./u, 'sez.'),
  targetFamily: 'skill',
  targetSchemaDigest: digest(JSON.parse(applyMechanicalIdentity(JSON.stringify(proofOperation.input)))),
  targetDefinitionDigest: null,
  targetSchemaStatus: 'EXTRACTED_SKILL_FIXTURE_NOT_ACTIVATED',
  destinationImplementation: ['src/skills/', 'test/parity/fixtures/skills/proof-echo/'],
  sourceTests: ['test/skill-loader.test.ts', 'examples/skills/proof-echo/skill.json'],
  targetParityTests: ['test/parity/skills/skills-parity.test.ts', 'test/extracted/supervisor/unit/skill-loader.test.ts'],
  state: 'EXTRACTED_NOT_INTEGRATED',
  integratedOperation: false,
  productionSupportedOperation: false,
  canonicalDelta: ['DELTA-CATALOG-001'],
  notes: 'The installed dynamic proof operation is represented and its source fixture is pinned; no se-z skill set is activated in Phase 1.',
});

const internals = internalCapabilities.map(([capability, family, sourcePath, destinationImplementation, state, canonicalDelta]) => ({
  capability, family, sourcePath, destinationImplementation, state, canonicalDelta,
  parityExpectation: state === 'SUPERSEDED_BY_CANONICAL_TARGET' || state === 'INTENTIONALLY_NOT_CARRIED' ? 'historical mechanics remain traceable; canonical target behavior is explicit' : 'mechanics traced and tested without production activation',
}));

const allowedCapabilityStates = new Set([
  'PRESERVED_DIRECTLY', 'MECHANICALLY_RENAMED', 'EXTRACTED_NOT_INTEGRATED',
  'SUPERSEDED_BY_CANONICAL_TARGET', 'DEFERRED_TO_0.1A', 'DEFERRED_TO_0.1B',
  'DEFERRED_TO_0.1C', 'INTENTIONALLY_NOT_CARRIED', 'BLOCKED',
]);
const deltaRegister = JSON.parse(fs.readFileSync(path.join(root, 'contracts/phase1-canonical-delta.json'), 'utf8'));
const registeredDeltaIds = new Set<string>(deltaRegister.entries.map((entry: { id: string }) => entry.id));
for (const item of [...operations, ...internals]) {
  if (!allowedCapabilityStates.has(item.state)) throw new Error(`Invalid capability state: ${item.state}`);
  for (const id of item.canonicalDelta) if (!registeredDeltaIds.has(id)) throw new Error(`Unknown canonical delta: ${id}`);
}
const stateCounts = [...operations, ...internals].reduce<Record<string, number>>((counts, item) => {
  counts[item.state] = (counts[item.state] ?? 0) + 1;
  return counts;
}, {});
const result = {
  schemaVersion: '1.0.0',
  generatedFromCapturedAt: identityRecord.capturedAt,
  sourceIdentity: {
    repository: SOURCE_IDENTITIES.supervisor.repository,
    commit: SOURCE_IDENTITIES.supervisor.commit,
    tree: SOURCE_IDENTITIES.supervisor.tree,
    version: SOURCE_IDENTITIES.supervisor.version,
    installedCatalogDigest: sourceIdentityProof.supervisor.signedRuntime.catalogDigest,
    installedSkillSetDigest: sourceIdentityProof.supervisor.signedRuntime.activeSkillSetDigest,
  },
  targetIdentity: {
    repository: 'StealthEyeLLC/se-z', branch: 'build/standalone-0.1', product: 'se-z', operationNamespace: 'sez.*', publicTool: 'call_sez', protocol: 'SEZ1',
  },
  installedOperationCount: sourceIdentityProof.supervisor.signedRuntime.operationCount,
  coreOperationCount: sourceDefinitions.length,
  dynamicOperationCount: 1,
  completeness: {
    everyInstalledOperationMapped: operations.length === sourceIdentityProof.supervisor.signedRuntime.operationCount,
    silentDisappearances: [], blocked: [], intentionallyNotCarried: [],
  },
  summary: { operationStates: operations.reduce<Record<string, number>>((counts, item) => { counts[item.state] = (counts[item.state] ?? 0) + 1; return counts; }, {}), allCapabilityStates: stateCounts },
  operations,
  internalCapabilities: internals,
};

const generatedJson = `${JSON.stringify(result, null, 2)}\n`;
const rows = operations.map((item) => `| \`${item.sourceOperation}\` | \`${item.targetOperation}\` | ${item.sourceFamily} | ${item.state} | ${item.canonicalDelta.length ? item.canonicalDelta.map((id) => `\`${id}\``).join(', ') : 'none'} |`).join('\n');
const internalRows = internals.map((item) => `| ${item.capability} | ${item.family} | ${item.state} | \`${item.destinationImplementation}\` | ${item.canonicalDelta.length ? item.canonicalDelta.map((id) => `\`${id}\``).join(', ') : 'none'} |`).join('\n');
const markdown = `# Phase 1 Capability Parity\n\n## Result\n\nThe signed installed source catalog contains **${result.installedOperationCount} operations**: ${result.coreOperationCount} pinned core definitions plus one dynamically loaded proof skill operation. This map contains all ${operations.length}; no installed operation is omitted. Phase 1 records extraction state, not standalone production support. No target operation in this map is marked production-supported.\n\nSource identity: \`${SOURCE_IDENTITIES.supervisor.repository}@${SOURCE_IDENTITIES.supervisor.commit}\` (tree \`${SOURCE_IDENTITIES.supervisor.tree}\`). Installed catalog digest: \`${result.sourceIdentity.installedCatalogDigest}\`.\n\n## State meanings\n\n- **MECHANICALLY_RENAMED**: proven mechanics and definition are present under active se-z identity with parity coverage, but are not exposed by a production se-z supervisor in Phase 1.\n- **EXTRACTED_NOT_INTEGRATED**: source mechanics are present and testable, while final supervisor/gateway registration or activation remains a later build generation.\n- **DEFERRED_TO_0.1C**: source mechanics are traced, but the canonical separately versioned recovery architecture owns final implementation.\n- **SUPERSEDED_BY_CANONICAL_TARGET**: source behavior remains traceable, while the canonical final transport or owner contract replaces it.
- **INTENTIONALLY_NOT_CARRIED**: the source behavior is documented and deliberately excluded from active target semantics.\n\n## Installed operation map\n\n| Source operation | Target operation | Family | Phase 1 state | Canonical delta |\n|---|---|---|---|---|\n${rows}\n\n## Meaningful internal capability map\n\n| Capability | Family | Phase 1 state | Destination | Canonical delta |\n|---|---|---|---|---|\n${internalRows}\n\n## Retention conclusion\n\nRaw execution, durable jobs, streams, files, PTYs, and artifacts are mechanically retained and tested. Release, self-hosting, skills, GitHub App, gateway, and OAuth mechanics are traced and testable without activation. The map explicitly assigns nonmechanical work to the canonical-delta register; it does not turn the extracted operation definitions into a running catalog or a standalone claim.\n`;
if (process.argv.includes('--check')) {
  const currentJson = fs.readFileSync(outputJson, 'utf8');
  const currentMarkdown = fs.readFileSync(outputMarkdown, 'utf8');
  if (currentJson !== generatedJson || currentMarkdown !== markdown) throw new Error('Phase 1 capability map is stale');
} else {
  fs.writeFileSync(outputJson, generatedJson);
  fs.writeFileSync(outputMarkdown, markdown);
}
console.log(JSON.stringify({ outputJson: path.relative(root, outputJson), outputMarkdown: path.relative(root, outputMarkdown), operations: operations.length, internalCapabilities: internals.length, summary: result.summary, passed: result.completeness.everyInstalledOperationMapped }, null, 2));

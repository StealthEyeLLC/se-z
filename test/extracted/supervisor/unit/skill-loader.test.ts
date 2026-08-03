// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/skill-loader.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import type { RuntimeConfig } from '../../../../src/supervisor/configuration/config.js';
import { GitHubAppAuthority } from '../../../../src/github/app-authority.js';
import { OPERATION_DEFINITIONS, buildCapabilityDescription } from '../../../../src/operations/definitions.js';
import type { OperationDefinition } from '../../../../src/operations/definitions.js';
import {
  activateRecord, pointerTarget, redactActivationError, replacePointer,
} from '../../../../src/skills/activation.js';
import type { ActivationRecord } from '../../../../src/skills/activation.js';
import {
  bundleDigest, catalogDigest, describeBundleDirectory, loadActivePackageSet,
  loadPackageSetFromPath, normalizeRelativePath, packageSetDigest, validateSkillManifest,
} from '../../../../src/skills/loader.js';
import { SkillDeploymentService } from '../../../../src/skills/service.js';
import type { SkillServicePaths } from '../../../../src/skills/service.js';
import type {
  GitHubSkillMaterialization,
} from '../../../../src/github/app-authority.js';
import type {
  LoadedPackageSet, PackageSetManifest, PackageSetSkill, SkillManifest,
} from '../../../../src/skills/types.js';

const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const CORE = OPERATION_DEFINITIONS;

interface Fixture extends SkillServicePaths {
  root: string;
}

async function inFixture(run: (fixture: Fixture) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'sez-skill-loader-test-'));
  const fixture: Fixture = {
    root,
    releaseRoot: join(root, 'skills', 'releases'),
    setRoot: join(root, 'skills', 'sets'),
    currentLink: join(root, 'skills', 'current'),
    previousLink: join(root, 'skills', 'previous'),
    deploymentRoot: join(root, 'deployments'),
    stagingRoot: join(root, 'staging'),
  };
  for (const path of [fixture.releaseRoot, fixture.setRoot, fixture.deploymentRoot, fixture.stagingRoot]) {
    mkdirSync(path, { recursive: true });
  }
  try {
    await run(fixture);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function operation(
  operationName = 'sez.skill.proof.echo',
  handler = 'echo',
): SkillManifest['operations'][number] {
  return {
    operation: operationName,
    version: '1.0.0',
    description: 'Deterministic proof echo.',
    mutation: false,
    risk: 'low',
    input: {
      type: 'object', additionalProperties: false, required: ['text'],
      properties: { text: { type: 'string' } },
    },
    output: {
      type: 'object', additionalProperties: false, required: ['text'],
      properties: { text: { type: 'string' } },
    },
    handler,
  };
}

function manifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    schemaVersion: '1.0.0',
    name: 'proof',
    version: '1.0.0',
    entrypoint: 'index.mjs',
    sezCompatibility: '>=0.1.0 <1.0.0',
    operations: [operation()],
    ...overrides,
  };
}

function definitionsFor(value: SkillManifest): OperationDefinition[] {
  return value.operations.map((item) => ({
    operation: item.operation,
    family: 'skill',
    version: item.version,
    description: item.description,
    mutation: item.mutation,
    idempotency: item.mutation ? 'caller_key' : 'read_only',
    risk: item.risk,
    input: item.input,
    output: item.output,
    errors: ['invalid_request', 'operation_failed'],
    cancellation: item.mutation ? 'pre_arm_cleanup_post_arm_rollback' : 'not_applicable',
    restartBehavior: item.mutation ? 'durable_reconcile' : 'read_only',
    postActionVerification: true,
  }));
}

function writeSource(
  directory: string,
  value = manifest(),
  moduleText = 'export function echo(input) { return { text: input.text }; }\n',
): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'skill.json'), `${JSON.stringify(value, null, 2)}\n`);
  writeFileSync(join(directory, value.entrypoint), moduleText);
}

function installBundle(
  fixture: Fixture,
  value = manifest(),
  moduleText?: string,
): { digest: string; path: string; manifest: SkillManifest } {
  const source = mkdtempSync(join(fixture.root, 'bundle-source-'));
  writeSource(source, value, moduleText);
  const digest = bundleDigest(describeBundleDirectory(source));
  const path = join(fixture.releaseRoot, digest);
  cpSync(source, path, { recursive: true });
  rmSync(source, { recursive: true, force: true });
  return { digest, path, manifest: value };
}

function writeSet(
  fixture: Fixture,
  skills: PackageSetSkill[],
  definitions: OperationDefinition[],
  createdAt: string,
  baseSetDigest: string | null = null,
): { digest: string; path: string; manifest: PackageSetManifest } {
  const value: PackageSetManifest = {
    schemaVersion: '1.0.0',
    createdAt,
    baseSetDigest,
    skills,
    expectedCatalogDigest: catalogDigest([...CORE, ...definitions]),
  };
  const digest = packageSetDigest(value);
  const path = join(fixture.setRoot, `${digest}.json`);
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return { digest, path, manifest: value };
}

function emptySet(fixture: Fixture, createdAt: string): ReturnType<typeof writeSet> {
  return writeSet(fixture, [], [], createdAt);
}

function sourceEntry(bundle: ReturnType<typeof installBundle>): PackageSetSkill {
  return {
    name: bundle.manifest.name,
    version: bundle.manifest.version,
    bundleDigest: bundle.digest,
    sourceRepository: 'StealthEyeLLC/se-z',
    sourceCommit: COMMIT,
    sourceTree: TREE,
    sourcePath: 'examples/skills/proof-echo',
  };
}

function activationRecord(
  prior: ReturnType<typeof writeSet>,
  candidate: ReturnType<typeof writeSet>,
  overrides: Partial<ActivationRecord> = {},
): ActivationRecord {
  return {
    action: 'deploy',
    deploymentId: 'deployment-test',
    priorActiveSetDigest: prior.digest,
    priorActiveSetPath: prior.path,
    priorPreviousSetPath: null,
    candidateSetPath: candidate.path,
    candidateSetDigest: candidate.digest,
    expectedCatalogDigest: candidate.manifest.expectedCatalogDigest,
    expectedSkillOperations: [],
    expectedCoreOperations: CORE.map((item) => item.operation),
    removedSkillOperations: [],
    smokeOperation: null,
    smokePayload: null,
    lifecycleState: 'READY',
    timestamps: { readyAt: '2026-07-27T00:00:00.000Z' },
    timingsMs: {},
    restartStatus: 'not_started',
    healthReadback: null,
    describeReadback: null,
    smokeResult: null,
    rollbackStatus: 'not_started',
    finalState: null,
    redactedError: null,
    ...overrides,
  };
}

function writeRecord(fixture: Fixture, record: ActivationRecord): string {
  const path = join(fixture.root, `${record.deploymentId}.json`);
  writeFileSync(path, `${JSON.stringify(record)}\n`);
  return path;
}

function emptyLoaded(): LoadedPackageSet {
  return {
    setDigest: null, setPath: null, manifest: null, skills: [], definitions: [],
    handlers: new Map(), inputValidators: new Map(), outputValidators: new Map(),
    catalogDigest: catalogDigest(CORE),
  };
}

function materialization(value = manifest(), moduleText?: string): GitHubSkillMaterialization {
  const files = [
    {
      path: 'skill.json', mode: '100644' as const,
      data: Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
      size: Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`),
    },
    {
      path: value.entrypoint, mode: '100644' as const,
      data: Buffer.from(moduleText ?? 'export function echo(input) { return { text: input.text }; }\n'),
      size: Buffer.byteLength(moduleText ?? 'export function echo(input) { return { text: input.text }; }\n'),
    },
  ];
  return {
    repository: 'StealthEyeLLC/se-z', ref: COMMIT, commit: COMMIT, tree: TREE,
    skillPath: 'examples/skills/proof-echo', files,
    timingsMs: { sourceResolution: 1, sourceMaterialization: 1 },
    token: { scope: 'single_repository_contents_read', persisted: false },
  };
}

async function createService(fixture: Fixture, materialized = materialization()): Promise<{
  service: SkillDeploymentService;
  getLoaded: () => LoadedPackageSet;
  setLoaded: (value: LoadedPackageSet) => void;
  scheduled: string[];
}> {
  let loaded = emptyLoaded();
  const scheduled: string[] = [];
  const service = new SkillDeploymentService(
    {} as RuntimeConfig,
    CORE,
    () => loaded,
    fixture,
    {
      githubAuthority: { materializeSkill: async () => materialized },
      scheduleActivation: (recordPath) => scheduled.push(recordPath),
    },
  );
  service.ensureInitialSet();
  loaded = await loadActivePackageSet(CORE, fixture.currentLink, fixture.releaseRoot);
  return {
    service,
    getLoaded: () => loaded,
    setLoaded: (value) => { loaded = value; },
    scheduled,
  };
}

function githubResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  });
}

describe('minimal trusted skill loader', () => {
  it('1. no current pointer preserves the exact existing core catalog', async () => {
    await inFixture(async (fixture) => {
      const loaded = await loadActivePackageSet(CORE, fixture.currentLink, fixture.releaseRoot);
      assert.equal(loaded.setDigest, null);
      assert.equal(loaded.definitions.length, 0);
      assert.equal(loaded.catalogDigest, catalogDigest(CORE));
    });
  });

  it('2. empty set loads successfully', async () => {
    await inFixture(async (fixture) => {
      const set = emptySet(fixture, '1970-01-01T00:00:00.000Z');
      const loaded = await loadPackageSetFromPath(set.path, CORE, fixture.releaseRoot);
      assert.equal(loaded.setDigest, set.digest);
      assert.equal(loaded.skills.length, 0);
    });
  });

  it('3. bundle digest is deterministic', async () => {
    await inFixture((fixture) => {
      const one = join(fixture.root, 'one');
      const two = join(fixture.root, 'two');
      writeSource(one);
      writeSource(two);
      assert.equal(
        bundleDigest(describeBundleDirectory(one)),
        bundleDigest(describeBundleDirectory(two)),
      );
    });
  });

  it('4. identical source has one content identity suitable for reuse', async () => {
    await inFixture((fixture) => {
      const one = join(fixture.root, 'one');
      const two = join(fixture.root, 'two');
      writeSource(one);
      writeSource(two);
      const first = bundleDigest(describeBundleDirectory(one));
      const second = bundleDigest(describeBundleDirectory(two));
      assert.equal(first, second);
      mkdirSync(join(fixture.releaseRoot, first));
      assert.equal(readdirSync(fixture.releaseRoot).length, 1);
    });
  });

  it('5. modified source changes the bundle digest', async () => {
    await inFixture((fixture) => {
      const one = join(fixture.root, 'one');
      const two = join(fixture.root, 'two');
      writeSource(one);
      writeSource(two, manifest(), 'export function echo() { return { text: "changed" }; }\n');
      assert.notEqual(
        bundleDigest(describeBundleDirectory(one)),
        bundleDigest(describeBundleDirectory(two)),
      );
    });
  });

  it('6. symlinks are rejected', async () => {
    await inFixture((fixture) => {
      const source = join(fixture.root, 'source');
      writeSource(source);
      symlinkSync('/etc/passwd', join(source, 'bad-link'));
      assert.throws(() => describeBundleDirectory(source), /symlink rejected/);
    });
  });

  it('7. traversal paths are rejected', () => {
    assert.throws(() => normalizeRelativePath('../outside', 'path'), /traversal/);
    assert.throws(() => normalizeRelativePath('a/../b', 'path'), /traversal|normalized/);
  });

  it('8. oversized files are rejected', async () => {
    await inFixture((fixture) => {
      const source = join(fixture.root, 'source');
      writeSource(source);
      writeFileSync(join(source, 'large.bin'), Buffer.alloc((4 * 1024 * 1024) + 1));
      assert.throws(() => describeBundleDirectory(source), /exceeds 4 MiB/);
    });
  });

  it('9. too many files are rejected', async () => {
    await inFixture((fixture) => {
      const source = join(fixture.root, 'source');
      writeSource(source);
      for (let index = 0; index < 255; index += 1) writeFileSync(join(source, `f-${index}`), 'x');
      assert.throws(() => describeBundleDirectory(source), /exceeds 256 files/);
    });
  });

  it('10. wrong repository owner is rejected before GitHub access', async () => {
    await inFixture(async (fixture) => {
      let called = false;
      const service = new SkillDeploymentService(
        {} as RuntimeConfig, CORE, emptyLoaded, fixture,
        {
          githubAuthority: {
            materializeSkill: async () => { called = true; return materialization(); },
          },
          scheduleActivation: () => undefined,
        },
      );
      service.ensureInitialSet();
      await assert.rejects(
        () => service.execute('sez.skill.deploy', 'request', {
          repository: 'Other/se-z', ref: COMMIT, skillPath: 'examples/skills/proof-echo',
        }),
        /StealthEyeLLC/,
      );
      assert.equal(called, false);
    });
  });

  it('11. exact commit mismatch is rejected', async () => {
    await inFixture(async (fixture) => {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const keyPath = join(fixture.root, 'app.pem');
      writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
      const fetchFn: typeof fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.pathname === '/app') return githubResponse(200, { id: 4380878, name: 'se-z GitHub Authority', slug: 'se-z-github-authority', owner: { login: 'StealthEyeLLC' } });
        if (url.pathname === '/app/installations/148647330') return githubResponse(200, { id: 148647330, account: { login: 'StealthEyeLLC' }, repository_selection: 'all', permissions: { contents: 'write' } });
        if (url.pathname.endsWith('/access_tokens')) return githubResponse(201, { token: 'installation-token-value-long-enough', repositories: [{ full_name: 'StealthEyeLLC/se-z' }] });
        if (url.pathname.includes('/commits/')) return githubResponse(200, { sha: COMMIT, commit: { tree: { sha: TREE } } });
        return githubResponse(500, { method: init.method, path: url.pathname });
      };
      const authority = new GitHubAppAuthority({ credentialPath: keyPath, fetchFn });
      await assert.rejects(
        () => authority.materializeSkill('StealthEyeLLC/se-z', 'main', 'examples/skills/proof-echo', 'c'.repeat(40)),
        /expectedCommit/,
      );
    });
  });

  it('12. invalid manifest with an undeclared top-level field is rejected', () => {
    assert.throws(
      () => validateSkillManifest({ ...manifest(), extra: true }),
      /unknown or missing fields/,
    );
  });

  it('13. unknown schema version is rejected', () => {
    assert.throws(
      () => validateSkillManifest({ ...manifest(), schemaVersion: '2.0.0' }),
      /unsupported skill schemaVersion/,
    );
  });

  it('14. missing entrypoint is rejected', async () => {
    await inFixture(async (fixture) => {
      const value = manifest();
      const source = join(fixture.root, 'source');
      mkdirSync(source);
      writeFileSync(join(source, 'skill.json'), JSON.stringify(value));
      const digest = bundleDigest(describeBundleDirectory(source));
      cpSync(source, join(fixture.releaseRoot, digest), { recursive: true });
      const set = writeSet(fixture, [{ ...sourceEntry({ digest, path: source, manifest: value }) }], definitionsFor(value), '2026-07-27T00:00:00.000Z');
      await assert.rejects(() => loadPackageSetFromPath(set.path, CORE, fixture.releaseRoot), /entrypoint missing/);
    });
  });

  it('15. missing handler is rejected', async () => {
    await inFixture(async (fixture) => {
      const bundle = installBundle(fixture, manifest(), 'export function other() { return {}; }\n');
      const set = writeSet(fixture, [sourceEntry(bundle)], definitionsFor(bundle.manifest), '2026-07-27T00:00:00.000Z');
      await assert.rejects(() => loadPackageSetFromPath(set.path, CORE, fixture.releaseRoot), /exports do not exactly match|handler missing/);
    });
  });

  it('16. operation namespace violations are rejected', () => {
    assert.throws(
      () => validateSkillManifest(manifest({ operations: [operation('sez.skill.other.echo')] })),
      /outside the skill namespace/,
    );
  });

  it('17. core-operation collisions are rejected', async () => {
    await inFixture(async (fixture) => {
      const bundle = installBundle(fixture);
      const set = writeSet(fixture, [sourceEntry(bundle)], definitionsFor(bundle.manifest), '2026-07-27T00:00:00.000Z');
      const conflictingCore = [...CORE, definitionsFor(bundle.manifest)[0]!];
      await assert.rejects(() => loadPackageSetFromPath(set.path, conflictingCore, fixture.releaseRoot), /collides with core/);
    });
  });

  it('18. duplicate skill operations are rejected', () => {
    assert.throws(
      () => validateSkillManifest(manifest({ operations: [operation(), operation()] })),
      /duplicate operation/,
    );
  });

  it('19. candidate preload succeeds without pointer mutation', async () => {
    await inFixture((fixture) => {
      const bundle = installBundle(fixture);
      const set = writeSet(fixture, [sourceEntry(bundle)], definitionsFor(bundle.manifest), '2026-07-27T00:00:00.000Z');
      const result = spawnSync(process.execPath, [
        '--import', 'tsx', 'src/skills/preload-cli.ts', set.path, fixture.releaseRoot,
      ], { cwd: process.cwd(), encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(fixture.currentLink), false);
      assert.equal(JSON.parse(result.stdout).setDigest, set.digest);
    });
  });

  it('20. candidate preload failure causes no pointer mutation', async () => {
    await inFixture((fixture) => {
      const prior = emptySet(fixture, '1970-01-01T00:00:00.000Z');
      replacePointer(fixture.currentLink, prior.path);
      const badPath = join(fixture.setRoot, `${'f'.repeat(64)}.json`);
      writeFileSync(badPath, '{}');
      const result = spawnSync(process.execPath, [
        '--import', 'tsx', 'src/skills/preload-cli.ts', badPath, fixture.releaseRoot,
      ], { cwd: process.cwd(), encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.equal(pointerTarget(fixture.currentLink), prior.path);
    });
  });

  it('21. pre-CAS duplicate activation fails without rolling back another transaction', async () => {
    await inFixture(async (fixture) => {
      const prior = emptySet(fixture, '1970-01-01T00:00:00.000Z');
      const other = emptySet(fixture, '1970-01-02T00:00:00.000Z');
      const candidate = emptySet(fixture, '1970-01-03T00:00:00.000Z');
      replacePointer(fixture.currentLink, other.path);
      let restartCalls = 0;
      const recordPath = writeRecord(fixture, activationRecord(prior, candidate));
      const result = await activateRecord(recordPath, {
        currentLink: fixture.currentLink, previousLink: fixture.previousLink,
        releaseRoot: fixture.releaseRoot, coreDefinitions: CORE,
        restart: () => { restartCalls += 1; return 1; },
        healthReadback: async () => ({ durationMs: 1 }),
      });
      assert.equal(result.finalState, 'FAILED');
      assert.equal(result.rollbackStatus, 'not_required');
      assert.equal(pointerTarget(fixture.currentLink), other.path);
      assert.equal(pointerTarget(fixture.previousLink), null);
      assert.equal(restartCalls, 0);
      assert.match(result.redactedError ?? '', /compare-and-swap/);
    });
  });

  it('22. atomic activation exposes candidate and previous pointers before restart', async () => {
    await inFixture(async (fixture) => {
      const prior = emptySet(fixture, '1970-01-01T00:00:00.000Z');
      const candidate = emptySet(fixture, '1970-01-02T00:00:00.000Z');
      replacePointer(fixture.currentLink, prior.path);
      let observed = false;
      const recordPath = writeRecord(fixture, activationRecord(prior, candidate));
      const result = await activateRecord(recordPath, {
        currentLink: fixture.currentLink, previousLink: fixture.previousLink,
        releaseRoot: fixture.releaseRoot, coreDefinitions: CORE,
        restart: () => {
          observed = pointerTarget(fixture.currentLink) === candidate.path &&
            pointerTarget(fixture.previousLink) === prior.path;
          return 2;
        },
        healthReadback: async () => ({ durationMs: 1 }),
      });
      assert.equal(observed, true);
      assert.equal(result.finalState, 'ACTIVE');
    });
  });

  it('22b. active-pointer races are detected before activation success', async () => {
    await inFixture(async (fixture) => {
      const prior = emptySet(fixture, '1970-01-01T00:00:00.000Z');
      const candidate = emptySet(fixture, '1970-01-02T00:00:00.000Z');
      const intruder = emptySet(fixture, '1970-01-03T00:00:00.000Z');
      replacePointer(fixture.currentLink, prior.path);
      let restartCalls = 0;
      let healthCalls = 0;
      const result = await activateRecord(writeRecord(fixture, activationRecord(prior, candidate)), {
        currentLink: fixture.currentLink, previousLink: fixture.previousLink,
        releaseRoot: fixture.releaseRoot, coreDefinitions: CORE,
        restart: () => { restartCalls += 1; return 1; },
        healthReadback: async () => {
          healthCalls += 1;
          if (healthCalls === 1) replacePointer(fixture.currentLink, intruder.path);
          return { durationMs: 1 };
        },
      });
      assert.equal(result.finalState, 'ROLLED_BACK');
      assert.equal(pointerTarget(fixture.currentLink), prior.path);
      assert.equal(restartCalls, 2);
      assert.match(result.redactedError ?? '', /pointer changed/);
    });
  });

  it('23. health failure triggers automatic rollback', async () => {
    await inFixture(async (fixture) => {
      const prior = emptySet(fixture, '1970-01-01T00:00:00.000Z');
      const candidate = emptySet(fixture, '1970-01-02T00:00:00.000Z');
      replacePointer(fixture.currentLink, prior.path);
      let healthCalls = 0;
      let restartCalls = 0;
      const result = await activateRecord(writeRecord(fixture, activationRecord(prior, candidate)), {
        currentLink: fixture.currentLink, previousLink: fixture.previousLink,
        releaseRoot: fixture.releaseRoot, coreDefinitions: CORE,
        restart: () => { restartCalls += 1; return 1; },
        healthReadback: async () => {
          healthCalls += 1;
          if (healthCalls === 1) throw new Error('health failed');
          return { durationMs: 1 };
        },
      });
      assert.equal(result.finalState, 'ROLLED_BACK');
      assert.equal(restartCalls, 2);
      assert.equal(pointerTarget(fixture.currentLink), prior.path);
    });
  });

  it('24. catalog mismatch triggers automatic rollback', async () => {
    await inFixture(async (fixture) => {
      const prior = emptySet(fixture, '1970-01-01T00:00:00.000Z');
      const candidate = emptySet(fixture, '1970-01-02T00:00:00.000Z');
      replacePointer(fixture.currentLink, prior.path);
      const result = await activateRecord(writeRecord(fixture, activationRecord(prior, candidate, {
        expectedCatalogDigest: 'f'.repeat(64),
      })), {
        currentLink: fixture.currentLink, previousLink: fixture.previousLink,
        releaseRoot: fixture.releaseRoot, coreDefinitions: CORE,
        restart: () => 1, healthReadback: async () => ({ durationMs: 1 }),
      });
      assert.equal(result.finalState, 'ROLLED_BACK');
      assert.match(result.redactedError ?? '', /catalog digest mismatch/);
    });
  });

  it('25. smoke failure triggers automatic rollback', async () => {
    await inFixture(async (fixture) => {
      const prior = emptySet(fixture, '1970-01-01T00:00:00.000Z');
      const bundle = installBundle(fixture, manifest(), 'export function echo() { throw new Error("smoke failed"); }\n');
      const candidate = writeSet(fixture, [sourceEntry(bundle)], definitionsFor(bundle.manifest), '1970-01-02T00:00:00.000Z');
      replacePointer(fixture.currentLink, prior.path);
      const result = await activateRecord(writeRecord(fixture, activationRecord(prior, candidate, {
        expectedSkillOperations: ['sez.skill.proof.echo'],
        smokeOperation: 'sez.skill.proof.echo', smokePayload: { text: 'proof' },
      })), {
        currentLink: fixture.currentLink, previousLink: fixture.previousLink,
        releaseRoot: fixture.releaseRoot, coreDefinitions: CORE,
        restart: () => 1, healthReadback: async () => ({ durationMs: 1 }),
      });
      assert.equal(result.finalState, 'ROLLED_BACK');
      assert.match(result.redactedError ?? '', /smoke failed/);
    });
  });

  it('26. explicit rollback activates the previous set successfully', async () => {
    await inFixture(async (fixture) => {
      const current = emptySet(fixture, '1970-01-02T00:00:00.000Z');
      const previous = emptySet(fixture, '1970-01-01T00:00:00.000Z');
      replacePointer(fixture.currentLink, current.path);
      replacePointer(fixture.previousLink, previous.path);
      const record = activationRecord(current, previous, {
        action: 'rollback', priorPreviousSetPath: previous.path,
      });
      const result = await activateRecord(writeRecord(fixture, record), {
        currentLink: fixture.currentLink, previousLink: fixture.previousLink,
        releaseRoot: fixture.releaseRoot, coreDefinitions: CORE,
        restart: () => 1, healthReadback: async () => ({ durationMs: 1 }),
      });
      assert.equal(result.finalState, 'ROLLED_BACK');
      assert.equal(pointerTarget(fixture.currentLink), previous.path);
      assert.equal(pointerTarget(fixture.previousLink), current.path);
    });
  });

  it('27. deploy uses caller-key idempotency and non-blocking durable activation', () => {
    const definition = CORE.find((item) => item.operation === 'sez.skill.deploy');
    assert.equal(definition?.idempotency, 'caller_key');
    assert.equal(definition?.restartBehavior, 'durable_reconcile');
    const serviceSource = readFileSync(new URL('../../../../src/skills/service.ts', import.meta.url), 'utf8');
    assert.match(serviceSource, /'--no-block'/);
  });

  it('27b. exact semantic replay returns one durable deployment record', async () => {
    await inFixture(async (fixture) => {
      const { service, scheduled } = await createService(fixture);
      const request = {
        repository: 'StealthEyeLLC/se-z', ref: COMMIT,
        skillPath: 'examples/skills/proof-echo', expectedCommit: COMMIT,
      };
      const first = await service.execute('sez.skill.deploy', 'same-semantic-fingerprint', request) as Record<string, unknown>;
      const replay = await service.execute('sez.skill.deploy', 'same-semantic-fingerprint', request) as Record<string, unknown>;
      assert.equal(replay.deploymentId, first.deploymentId);
      assert.equal(scheduled.length, 1);
      assert.equal(readdirSync(fixture.deploymentRoot).length, 1);
    });
  });

  it('27c. a different caller key creates a new transaction for identical source', async () => {
    await inFixture(async (fixture) => {
      const { service, scheduled } = await createService(fixture);
      const request = {
        repository: 'StealthEyeLLC/se-z', ref: COMMIT,
        skillPath: 'examples/skills/proof-echo', expectedCommit: COMMIT,
      };
      const first = await service.execute('sez.skill.deploy', 'caller-key-one', request) as Record<string, unknown>;
      const second = await service.execute('sez.skill.deploy', 'caller-key-two', request) as Record<string, unknown>;
      assert.notEqual(second.deploymentId, first.deploymentId);
      assert.equal(scheduled.length, 2);
      assert.equal(readdirSync(fixture.deploymentRoot).length, 2);
      assert.equal(second.bundleDigest, first.bundleDigest);
    });
  });

  it('28. identical redeployment reuses the exact bundle directory', async () => {
    await inFixture(async (fixture) => {
      const { service } = await createService(fixture);
      const request = {
        repository: 'StealthEyeLLC/se-z', ref: COMMIT,
        skillPath: 'examples/skills/proof-echo', expectedCommit: COMMIT,
      };
      const first = await service.execute('sez.skill.deploy', 'request-one', request) as Record<string, unknown>;
      const second = await service.execute('sez.skill.deploy', 'request-two', request) as Record<string, unknown>;
      assert.equal(first.bundleDigest, second.bundleDigest);
      assert.equal(second.bundleReused, true);
      assert.equal(readdirSync(fixture.releaseRoot).length, 1);
    });
  });

  it('29. restart loading uses the active package-set pointer', async () => {
    await inFixture(async (fixture) => {
      const bundle = installBundle(fixture);
      const set = writeSet(fixture, [sourceEntry(bundle)], definitionsFor(bundle.manifest), '2026-07-27T00:00:00.000Z');
      replacePointer(fixture.currentLink, set.path);
      const loaded = await loadActivePackageSet(CORE, fixture.currentLink, fixture.releaseRoot);
      assert.equal(loaded.setDigest, set.digest);
      assert.deepEqual(loaded.definitions.map((item) => item.operation), ['sez.skill.proof.echo']);
    });
  });

  it('30. sez.describe reports the active set and loaded skills', async () => {
    await inFixture(async (fixture) => {
      const bundle = installBundle(fixture);
      const set = writeSet(fixture, [sourceEntry(bundle)], definitionsFor(bundle.manifest), '2026-07-27T00:00:00.000Z');
      const loaded = await loadPackageSetFromPath(set.path, CORE, fixture.releaseRoot);
      const description = buildCapabilityDescription({} as RuntimeConfig, loaded) as {
        skills: { activeSetDigest: string; skillOperationCount: number; loaded: unknown[] };
        operations: Array<{ operation: string }>;
      };
      assert.equal(description.skills.activeSetDigest, set.digest);
      assert.equal(description.skills.skillOperationCount, 1);
      assert.equal(description.skills.loaded.length, 1);
      assert.equal(description.operations.some((item) => item.operation === 'sez.skill.proof.echo'), true);
    });
  });

  it('31. sez.skill.status returns accurate active identities and counts', async () => {
    await inFixture(async (fixture) => {
      const context = await createService(fixture);
      const deployment = await context.service.execute('sez.skill.deploy', 'status-deploy', {
        repository: 'StealthEyeLLC/se-z', ref: COMMIT,
        skillPath: 'examples/skills/proof-echo', expectedCommit: COMMIT,
      }) as { candidateSetDigest: string };
      const candidatePath = join(fixture.setRoot, `${deployment.candidateSetDigest}.json`);
      replacePointer(fixture.currentLink, candidatePath);
      context.setLoaded(await loadPackageSetFromPath(candidatePath, CORE, fixture.releaseRoot));
      const status = await context.service.execute('sez.skill.status', 'status', {}) as {
        activeSetDigest: string; currentCoreOperationCount: number; currentSkillOperationCount: number;
        activeSkills: Array<{ sourceCommit: string }>;
      };
      assert.equal(status.activeSetDigest, deployment.candidateSetDigest);
      assert.equal(status.currentCoreOperationCount, 48);
      assert.equal(status.currentSkillOperationCount, 1);
      assert.equal(status.activeSkills[0]?.sourceCommit, COMMIT);
    });
  });

  it('32. sez.skill.list output is bounded', async () => {
    await inFixture(async (fixture) => {
      const context = await createService(fixture);
      for (let index = 0; index < 205; index += 1) {
        mkdirSync(join(fixture.releaseRoot, index.toString(16).padStart(64, '0')));
      }
      const result = await context.service.execute('sez.skill.list', 'list', {}) as {
        bundles: unknown[]; packageSets: unknown[]; bounded: boolean; maximum: number;
      };
      assert.equal(result.bounded, true);
      assert.equal(result.maximum, 200);
      assert.equal(result.bundles.length, 200);
      assert.ok(result.packageSets.length <= 200);
    });
  });

  it('33. installation tokens are not persisted', async () => {
    await inFixture(async (fixture) => {
      const context = await createService(fixture);
      await context.service.execute('sez.skill.deploy', 'token-scan', {
        repository: 'StealthEyeLLC/se-z', ref: COMMIT,
        skillPath: 'examples/skills/proof-echo', expectedCommit: COMMIT,
      });
      const scan = spawnSync('grep', [
        '-R', '-n', 'installation-token', fixture.root,
      ], { encoding: 'utf8' });
      assert.equal(scan.status, 1, scan.stdout);
      assert.equal(readdirSync(fixture.stagingRoot).length, 0);
    });
  });

  it('34. secrets are redacted from activation errors', () => {
    const redacted = redactActivationError(new Error('failed ghp_supersecretvalue'));
    assert.equal(redacted.includes('ghp_supersecretvalue'), false);
    assert.match(redacted, /\[REDACTED\]/);
  });
});

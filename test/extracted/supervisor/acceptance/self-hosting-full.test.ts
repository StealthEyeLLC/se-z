// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:acceptance/self-hosting-full.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
/**
 * Consolidated protocol-only self-hosting acceptance workflow.
 * Harness filesystem calls are limited to outer sandbox, bare remote, and fixture tarball.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  readdirSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import {
  startTestServer,
  stopTestServer,
  restartTestServer,
  type TestServerContext,
} from '../unit/helpers/server.js';
import { createTestClient, type SezTestClient } from '../unit/helpers/client.js';
import {
  writeFile,
  readFile,
  shellWait,
  readStream,
  assertNoSecretLeak,
} from './helpers/protocol.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const CANARY = 'bq-selfhost-canary-9e4f1b2a';
const RELEASE_V1 = '0.1.0-r1';
const RELEASE_V2 = '0.1.0-r2';

describe('acceptance: protocol-only self-hosting end-to-end', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'bq-selfhost-full-'));
  const bareRemote = join(sandbox, 'bare.git');
  const fixtureDir = join(REPO_ROOT, 'test/extracted/supervisor/acceptance/fixtures/local-fixture-pkg');
  const fixtureTgz = join(sandbox, 'local-fixture-pkg-1.0.0.tgz');
  const projectDir = join(sandbox, 'project');
  const releaseOutput = join(sandbox, 'release-output');

  let ctx: TestServerContext;
  let client: SezTestClient;

  before(() => {
    execFileSync('git', ['init', '--bare', bareRemote]);
    execFileSync('npm', ['pack', '--pack-destination', sandbox], { cwd: fixtureDir, stdio: 'pipe' });
    const packed = readdirSync(sandbox).find((f) => f.endsWith('.tgz'));
    assert.ok(packed, 'fixture tarball must exist');
    if (packed !== 'local-fixture-pkg-1.0.0.tgz') {
      renameSync(join(sandbox, packed), fixtureTgz);
    }
  });

  after(async () => {
    if (ctx) await stopTestServer(ctx);
    rmSync(sandbox, { recursive: true, force: true });
    delete process.env.SEZ_TEST_CANARY;
  });

  it(
    'executes the full se-z protocol workflow in one pass',
    { timeout: 900_000 },
    async () => {
      process.env.SEZ_TEST_CANARY = CANARY;
      ctx = await startTestServer();
      client = createTestClient(ctx);

      const sourceCommit = execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
      assert.equal(sourceCommit.length, 40);

      // 1–3: create project, manifest, sources, patch
      await writeFile(
        client,
        join(projectDir, 'package.json'),
        JSON.stringify(
          {
            name: 'selfhost-demo',
            version: '0.0.1',
            type: 'module',
            scripts: {
              build: 'mkdir -p dist && cp src/app.js dist/app.js',
              test: 'node test/run.test.js',
            },
            dependencies: {
              'local-fixture-pkg': `file:${fixtureTgz}`,
            },
          },
          null,
          2,
        ),
      );
      await writeFile(
        client,
        join(projectDir, 'src/app.js'),
        `import { greet } from 'local-fixture-pkg';\nexport function main() { return greet('world'); }\n`,
      );
      await writeFile(
        client,
        join(projectDir, 'test/run.test.js'),
        `import assert from 'node:assert/strict';\nimport { main } from '../dist/app.js';\nassert.equal(main(), 'hello selfhost');\nconsole.log('project-tests-ok');\n`,
      );
      await client.request('sez.file.patch', {
        path: join(projectDir, 'src/app.js'),
        patches: [{ offset: 0, data: "import { greet } from 'local-fixture-pkg';\nexport function main() { return greet('selfhost'); }\n", encoding: 'utf8' }],
      });
      const patched = await readFile(client, join(projectDir, 'src/app.js'));
      assert.match(patched, /selfhost/);

      // 4–6: git init and author identity
      await shellWait(client, 'git init && git checkout -b main', projectDir);
      await shellWait(
        client,
        'git config user.email "selfhost@test.local" && git config user.name "Self Host"',
        projectDir,
      );

      // 7–9: install dependency, build, test with stream offsets
      const installOut = await shellWait(client, 'npm install --no-audit --no-fund', projectDir);
      assert.match(installOut.stdout + installOut.stderr, /added 1 package/);
      await shellWait(client, 'npm run build', projectDir);
      const testJob = await client.request('sez.shell', {
        script: 'npm test 2>&1',
        cwd: projectDir,
      });
      const testJobId = (testJob.result as { jobId: string }).jobId;
      const partialStdout = await readStream(client, testJobId, 'stdout', 0);
      assertNoSecretLeak(partialStdout, CANARY, 'partial test stdout');
      await client.request('sez.job.wait', { jobId: testJobId, timeoutMs: 120_000 });
      const testStdout = await readStream(client, testJobId, 'stdout', partialStdout.length);
      assert.match(partialStdout + testStdout, /project-tests-ok/);

      const probe = await shellWait(
        client,
        'node -e "console.log(\\"stdout-line\\"); console.error(\\"stderr-line\\")"',
        projectDir,
      );
      const probeStdout = await readStream(client, probe.jobId, 'stdout');
      const probeStderr = await readStream(client, probe.jobId, 'stderr');
      assert.match(probeStdout, /stdout-line/);
      assert.match(probeStderr, /stderr-line/);

      // 10–12: bare remote, commit, push
      await shellWait(client, `git remote add origin ${bareRemote}`, projectDir);
      await shellWait(client, 'git add -A && git commit -m "selfhost initial"', projectDir);
      await shellWait(client, 'git push -u origin main', projectDir);

      const buildRelease = async (version: string): Promise<string> => {
        const script = [
          `cd ${REPO_ROOT}`,
          `export SEZ_SOURCE_COMMIT=${sourceCommit}`,
          'export SEZ_ALLOW_FIXTURE_VERSION=1',
          `export SEZ_OUTPUT_DIR=${releaseOutput}`,
          'npm run build',
          `bash scripts/extracted/supervisor/build-bundle.sh ${version}`,
          `cd ${releaseOutput} && sha256sum -c se-z-${version}.sha256`,
          `python3 -c "import json; m=json.load(open('se-z-${version}.build.json')); assert m['commit']=='${sourceCommit}', m['commit']"`,
        ].join(' && ');
        await shellWait(client, script, REPO_ROOT, 600_000);
        const digest = readFileSync(
          join(releaseOutput, `se-z-${version}.sha256`),
          'utf8',
        )
          .trim()
          .split(/\s+/)[0];
        assert.equal(digest.length, 64);
        return digest;
      };

      const verifyRelease = async (version: string): Promise<void> => {
        const result = await shellWait(
          client,
          [
            'node --import tsx scripts/extracted/supervisor/verify-candidate.ts',
            `--archive ${join(releaseOutput, `se-z-${version}.tar.gz`)}`,
            `--build-record ${join(releaseOutput, `se-z-${version}.build.json`)}`,
          ].join(' '),
          REPO_ROOT,
          600_000,
        );
        assert.match(result.stdout, /"verified":true/u);
      };

      // 13–16: release v1 build and strict verification without pointer mutation
      const digestV1 = await buildRelease(RELEASE_V1);
      await verifyRelease(RELEASE_V1);

      // 17–18: second release is distinct and independently verified
      const digestV2 = await buildRelease(RELEASE_V2);
      assert.notEqual(digestV1, digestV2);
      await verifyRelease(RELEASE_V2);
      const sourceStatus = await shellWait(client, 'git status --porcelain=v1 --untracked-files=all', REPO_ROOT);
      assert.equal(sourceStatus.stdout, '');

      // 21–22: detached job across daemon restart with durable offsets
      const detached = await client.request('sez.exec', {
        argv: ['/bin/sh', '-c', 'printf partial-; sleep 2; echo complete'],
        cwd: projectDir,
        detached: true,
      });
      const detachedId = (detached.result as { jobId: string }).jobId;
      await new Promise((r) => setTimeout(r, 400));
      const offsetBefore = await readStream(client, detachedId, 'stdout', 0);
      assert.match(offsetBefore, /partial-/);

      await restartTestServer(ctx);
      await new Promise((r) => setTimeout(r, 2500));

      let combined = offsetBefore;
      for (let attempt = 0; attempt < 20; attempt++) {
        const chunk = await readStream(client, detachedId, 'stdout', combined.length);
        combined += chunk;
        if (/complete/.test(combined)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.match(combined, /complete/);

      // 23–27: tmux PTY create, input, resize, restart, reattach
      const pty = await client.request('sez.pty.create', {
        shell: '/bin/sh',
        cwd: projectDir,
        cols: 80,
        rows: 24,
      });
      const sessionId = (pty.result as { sessionId: string }).sessionId;
      await client.request('sez.pty.input', {
        sessionId,
        data: 'echo pty-before-restart\n',
        encoding: 'utf8',
      });
      await client.request('sez.pty.resize', { sessionId, cols: 100, rows: 30 });
      await new Promise((r) => setTimeout(r, 600));
      const ptyBefore = await client.request('sez.pty.read', { sessionId, offset: 0 });
      const ptyTextBefore = Buffer.from(
        (ptyBefore.result as { data: string }).data,
        'base64',
      ).toString('utf8');
      assert.match(ptyTextBefore, /pty-before-restart/);
      const ptyOffset = (ptyBefore.result as { offset: number }).offset;

      await restartTestServer(ctx);
      await new Promise((r) => setTimeout(r, 500));

      await client.request('sez.pty.input', {
        sessionId,
        data: 'echo pty-after-restart\n',
        encoding: 'utf8',
      });
      await new Promise((r) => setTimeout(r, 1000));
      const fullPty = await client.request('sez.pty.read', { sessionId, offset: 0 });
      const allPtyText = Buffer.from(
        (fullPty.result as { data: string }).data,
        'base64',
      ).toString('utf8');
      assert.match(allPtyText, /pty-before-restart/);
      assert.match(allPtyText, /pty-after-restart/);
      await client.request('sez.pty.close', { sessionId });

      // 28: cancel isolated process group
      const sleeper = await client.request('sez.shell', {
        command: 'sleep 5',
        cwd: projectDir,
      });
      const sleeperId = (sleeper.result as { jobId: string }).jobId;
      await new Promise((r) => setTimeout(r, 200));
      const cancelled = await client.request('sez.job.cancel', {
        jobId: sleeperId,
        signal: 'SIGTERM',
      });
      assert.equal((cancelled.result as { status: string }).status, 'cancelled');

      // 29–30: secret reference without disclosure
      const secretExec = await client.request('sez.exec', {
        argv: ['sh', '-c', 'printf %s "$GH_TOKEN"'],
        cwd: projectDir,
        environment: [{ name: 'GH_TOKEN', secretReference: 'github:SEZ_TEST_CANARY' }],
      });
      const secretJobId = (secretExec.result as { jobId: string }).jobId;
      await client.request('sez.job.wait', { jobId: secretJobId, timeoutMs: 30_000 });
      const secretStdout = await readStream(client, secretJobId, 'stdout');
      assert.equal(secretStdout.trim(), CANARY);

      const surfaces: string[] = [
        JSON.stringify(await client.request('sez.job.get', { jobId: secretJobId })),
        JSON.stringify(await client.request('sez.job.list', { limit: 50 })),
      ];
      for (const file of readdirSync(join(ctx.stateRoot, 'jobs'))) {
        surfaces.push(readFileSync(join(ctx.stateRoot, 'jobs', file), 'utf8'));
      }
      const buildRecordPath = join(releaseOutput, `se-z-${RELEASE_V1}.build.json`);
      if (existsSync(buildRecordPath)) {
        surfaces.push(readFileSync(buildRecordPath, 'utf8'));
      }
      for (const [idx, surface] of surfaces.entries()) {
        assertNoSecretLeak(surface, CANARY, `surface-${idx}`);
      }

      // Final health check
      const health = await client.request('sez.health');
      assert.equal((health.result as { status: string }).status, 'healthy');
    },
  );
});

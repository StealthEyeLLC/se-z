// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:acceptance/self-hosting.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startTestServer, stopTestServer, type TestServerContext } from '../unit/helpers/server.js';
import { createTestClient, type SezTestClient } from '../unit/helpers/client.js';
import { loadPublicKey } from '../../../../src/protocol/signatures/signing.js';
import { verifyReceipt } from '../../../../src/protocol/receipts/verify.js';

describe('acceptance: self-hosting workflow', () => {
  let ctx: TestServerContext;
  let client: SezTestClient;
  const workspace = mkdtempSync(join(tmpdir(), 'bq-selfhost-'));

  before(async () => {
    ctx = await startTestServer();
    client = createTestClient(ctx);
  });

  after(async () => {
    await stopTestServer(ctx);
    rmSync(workspace, { recursive: true, force: true });
  });

  it('writes source tree, runs build, inspects output, and verifies receipt', async () => {
    const mainPath = join(workspace, 'main.js');
    const source = 'console.log("self-hosted");\n';
    await client.request('sez.file.write', {
      path: mainPath,
      data: Buffer.from(source).toString('base64'),
      encoding: 'base64',
    });

    const stat = await client.request('sez.file.stat', { path: mainPath });
    assert.equal((stat.result as { type: string }).type, 'file');
    assert.ok((stat.result as { sha256: string }).sha256);

    const exec = await client.request('sez.exec', {
      argv: ['node', mainPath],
      cwd: workspace,
    });
    const jobId = (exec.result as { jobId: string }).jobId;
    const completed = await client.request('sez.job.wait', { jobId, timeoutMs: 15_000 });
    assert.equal((completed.result as { status: string }).status, 'completed');

    const stream = await client.request('sez.job.stream.read', { jobId, stream: 'stdout' });
    const output = Buffer.from((stream.result as { data: string }).data, 'base64').toString('utf8');
    assert.match(output, /self-hosted/);

    assert.ok(stat.receipt);
    const receipt = stat.receipt as import('../../../../src/protocol/receipts/receipt.js').SignedReceipt;
    const pub = loadPublicKey(join(ctx.configRoot, 'supervisor-receipt-public.pem'));
    assert.ok(verifyReceipt(receipt, pub), 'receipt signature should verify');
  });

  it('patches file and lists workspace', async () => {
    const path = join(workspace, 'patch.txt');
    await client.request('sez.file.write', {
      path,
      data: Buffer.from('AAAA').toString('base64'),
      encoding: 'base64',
    });
    await client.request('sez.file.patch', {
      path,
      patches: [{ offset: 2, data: 'BB', encoding: 'utf8' }],
    });
    const read = await client.request('sez.file.read', { path, encoding: 'utf8' });
    assert.equal((read.result as { data: string }).data, 'AABB');

    const list = await client.request('sez.file.list', { path: workspace });
    const entries = (list.result as { entries: unknown[] }).entries;
    assert.ok(entries.length >= 2);
  });
});

describe('acceptance: artifact bounds', () => {
  let ctx: TestServerContext;
  let client: SezTestClient;
  const workspace = mkdtempSync(join(tmpdir(), 'bq-artifact-'));

  before(async () => {
    ctx = await startTestServer();
    client = createTestClient(ctx);
  });

  after(async () => {
    await stopTestServer(ctx);
    rmSync(workspace, { recursive: true, force: true });
  });

  it('uploads artifact in chunks and downloads with offset', async () => {
    const source = join(workspace, 'blob.bin');
    const data = Buffer.alloc(128 * 1024, 0xcd);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(source, data);

    const created = await client.request('sez.artifact.create', {
      name: 'test-blob',
      sourcePath: source,
    });
    const artifactId = (created.result as { artifactId: string }).artifactId;
    const download = await client.request('sez.artifact.download', {
      artifactId,
      offset: 0,
      limit: 4096,
    });
    const chunk = Buffer.from((download.result as { data: string }).data, 'base64');
    assert.equal(chunk.length, 4096);
    assert.ok((download.result as { sha256: string }).sha256);
  });
});

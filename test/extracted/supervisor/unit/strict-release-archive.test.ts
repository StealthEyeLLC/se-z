// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:test/strict-release-archive.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import { sha256Hex } from '../../../../src/protocol/canonical/canonical.js';
import {
  PINNED_NODE_VERSION,
  STRICT_ARCHIVE_PROFILE,
  type ExtractableReleaseManifest,
} from '../../../../src/releases/archive-contract.js';
import { createDeterministicTarGz } from '../../../../src/releases/deterministic-archive.js';
import { strictExtractRelease } from '../../../../src/releases/strict-extractor.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'se-z-strict-archive-'));
  roots.push(value);
  return value;
}

function manifest(
  result: Awaited<ReturnType<typeof createDeterministicTarGz>>,
): ExtractableReleaseManifest {
  return {
    schemaVersion: '2.0.0',
    product: 'se-z',
    repository: 'StealthEyeLLC/se-z',
    releaseVersion: '0.3.0-fixture',
    sourceDateEpoch: 1_700_000_000,
    nodeVersion: PINNED_NODE_VERSION,
    archive: result.archive,
    files: result.files,
  };
}

function writeHeaderText(header: Buffer, offset: number, length: number, value: string): void {
  header.fill(0, offset, offset + length);
  Buffer.from(value, 'ascii').copy(header, offset, 0, length);
}

function writeHeaderOctal(
  header: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  writeHeaderText(header, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

function updateChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeHeaderText(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
}

function withArchiveIdentity(
  source: ExtractableReleaseManifest,
  archiveBytes: Buffer,
  decompressedBytes: Buffer,
  files = source.files,
): ExtractableReleaseManifest {
  return {
    ...source,
    archive: {
      ...source.archive,
      digest: sha256Hex(archiveBytes),
      compressedSize: archiveBytes.length,
      decompressedSize: decompressedBytes.length,
      memberCount: files.length + 1,
    },
    files,
  };
}

describe('deterministic strict release archive', () => {
  it('writes byte-identical link-free ustar archives and reads back exact bytes and modes', async () => {
    const workspace = root();
    const release = join(workspace, 'release-root');
    mkdirSync(join(release, 'bin'), { recursive: true });
    mkdirSync(join(release, 'lib', 'empty'), { recursive: true });
    mkdirSync(join(release, 'ops', 'systemd'), { recursive: true });
    writeFileSync(join(release, 'bin', 'entrypoint'), '#!/bin/sh\necho ok\n');
    chmodSync(join(release, 'bin', 'entrypoint'), 0o755);
    writeFileSync(join(release, 'lib', 'payload.json'), '{"ok":true}\n');
    chmodSync(join(release, 'lib', 'payload.json'), 0o640);
    writeFileSync(join(release, 'ops', 'systemd', 'worker@.service'), '[Service]\nType=oneshot\n');
    chmodSync(join(release, 'ops', 'systemd', 'worker@.service'), 0o644);
    chmodSync(release, 0o700);

    const first = await createDeterministicTarGz({
      releaseRoot: release,
      topLevelPrefix: 'se-z-0.3.0-fixture',
      archivePath: join(workspace, 'first.tar.gz'),
      sourceDateEpoch: 1_700_000_000,
    });
    const second = await createDeterministicTarGz({
      releaseRoot: release,
      topLevelPrefix: 'se-z-0.3.0-fixture',
      archivePath: join(workspace, 'second.tar.gz'),
      sourceDateEpoch: 1_700_000_000,
    });
    assert.equal(first.archive.digest, second.archive.digest);
    assert.deepEqual(readFileSync(join(workspace, 'first.tar.gz')), readFileSync(join(workspace, 'second.tar.gz')));
    assert.equal(first.archive.strictProfile, STRICT_ARCHIVE_PROFILE);
    assert.ok(first.files.every((entry) => entry.type !== 'file' || entry.digest.length === 64));

    const archiveBytes = gunzipSync(readFileSync(join(workspace, 'first.tar.gz')));
    assert.equal(Number.parseInt(archiveBytes.subarray(100, 108).toString('ascii').replace(/\0.*$/u, ''), 8), 0o755);

    const extracted = join(workspace, 'extracted');
    const result = await strictExtractRelease({
      archivePath: join(workspace, 'first.tar.gz'),
      destination: extracted,
      manifest: manifest(first),
    });
    assert.equal(readFileSync(join(result.releaseRoot, 'bin', 'entrypoint'), 'utf8'), '#!/bin/sh\necho ok\n');
    assert.equal(readFileSync(join(result.releaseRoot, 'lib', 'payload.json'), 'utf8'), '{"ok":true}\n');
    assert.match(readFileSync(join(result.releaseRoot, 'ops', 'systemd', 'worker@.service'), 'utf8'), /Type=oneshot/u);
  });

  it('rejects archive identity drift before writing a destination', async () => {
    const workspace = root();
    const release = join(workspace, 'release-root');
    mkdirSync(release);
    writeFileSync(join(release, 'payload'), 'exact');
    const built = await createDeterministicTarGz({
      releaseRoot: release,
      topLevelPrefix: 'se-z-0.3.0-fixture',
      archivePath: join(workspace, 'release.tar.gz'),
      sourceDateEpoch: 1_700_000_000,
    });
    const changed = manifest(built);
    changed.archive = { ...changed.archive, digest: '0'.repeat(64) };
    await assert.rejects(
      strictExtractRelease({
        archivePath: join(workspace, 'release.tar.gz'),
        destination: join(workspace, 'out'),
        manifest: changed,
      }),
      /identity differs/u,
    );
  });

  it('rejects links, extension records, wrong prefixes, and trailing garbage', async () => {
    const workspace = root();
    const source = join(workspace, 'source');
    const prefix = 'se-z-0.3.0-fixture';
    mkdirSync(join(source, prefix), { recursive: true });
    writeFileSync(join(source, prefix, 'regular'), 'data');
    symlinkSync('/etc/passwd', join(source, prefix, 'link'));

    const cases: Array<{ name: string; args: string[] }> = [
      {
        name: 'link',
        args: ['--format=ustar', '-czf', join(workspace, 'link.tar.gz'), '-C', source, prefix],
      },
      {
        name: 'pax',
        args: ['--format=pax', '-czf', join(workspace, 'pax.tar.gz'), '-C', source, `${prefix}/regular`],
      },
      {
        name: 'wrong-prefix',
        args: ['--format=ustar', '-czf', join(workspace, 'wrong-prefix.tar.gz'), '-C', source, `${prefix}/regular`],
      },
    ];
    for (const item of cases) execFileSync('tar', item.args);

    const baseManifest: ExtractableReleaseManifest = {
      schemaVersion: '2.0.0',
      product: 'se-z',
      repository: 'StealthEyeLLC/se-z',
      releaseVersion: '0.3.0-fixture',
      sourceDateEpoch: 1_700_000_000,
      nodeVersion: PINNED_NODE_VERSION,
      archive: {
        format: 'tar.gz',
        digest: '0'.repeat(64),
        compressedSize: 1,
        decompressedSize: 1024,
        memberCount: 2,
        topLevelPrefix: `${prefix}/`,
        strictProfile: STRICT_ARCHIVE_PROFILE,
      },
      files: [
        { path: 'regular', type: 'file', mode: '0644', size: 4, digest: sha256Hex('data') },
      ],
    };

    for (const item of cases) {
      const archivePath = join(workspace, `${item.name}.tar.gz`);
      const bytes = readFileSync(archivePath);
      const decompressed = gunzipSync(bytes);
      const candidate: ExtractableReleaseManifest = {
        ...baseManifest,
        archive: {
          ...baseManifest.archive,
          digest: sha256Hex(bytes),
          compressedSize: bytes.length,
          decompressedSize: decompressed.length,
          memberCount: item.name === 'link' ? 3 : 1,
        },
      };
      await assert.rejects(
        strictExtractRelease({
          archivePath,
          destination: join(workspace, `out-${item.name}`),
          manifest: candidate,
        }),
        /Forbidden|POSIX ustar|root|prefix|manifest|mtime|member count|declaration/iu,
      );
    }

    const goodRelease = join(workspace, 'good-release');
    mkdirSync(goodRelease);
    writeFileSync(join(goodRelease, 'regular'), 'data');
    const good = await createDeterministicTarGz({
      releaseRoot: goodRelease,
      topLevelPrefix: prefix,
      archivePath: join(workspace, 'good.tar.gz'),
      sourceDateEpoch: 1_700_000_000,
    });
    const garbagePath = join(workspace, 'garbage.tar.gz');
    copyFileSync(join(workspace, 'good.tar.gz'), garbagePath);
    writeFileSync(garbagePath, Buffer.concat([readFileSync(garbagePath), Buffer.from('not-zero')]));
    const garbageBytes = readFileSync(garbagePath);
    const garbageManifest = manifest(good);
    garbageManifest.archive = {
      ...garbageManifest.archive,
      digest: sha256Hex(garbageBytes),
      compressedSize: garbageBytes.length,
    };
    await assert.rejects(
      strictExtractRelease({
        archivePath: garbagePath,
        destination: join(workspace, 'out-garbage'),
        manifest: garbageManifest,
      }),
    );
  });

  it('rejects absolute, traversal, backslash, NUL, special-bit, device, sparse, checksum, duplicate, and conflict records', async () => {
    const workspace = root();
    const release = join(workspace, 'release-root');
    mkdirSync(release);
    writeFileSync(join(release, 'payload'), 'payload');
    const archivePath = join(workspace, 'base.tar.gz');
    const built = await createDeterministicTarGz({
      releaseRoot: release,
      topLevelPrefix: 'se-z-0.3.0-fixture',
      archivePath,
      sourceDateEpoch: 1_700_000_000,
    });
    const baseManifest = manifest(built);
    const baseTar = gunzipSync(readFileSync(archivePath));
    const prefix = 'se-z-0.3.0-fixture';

    const mutations: Array<{ name: string; mutate: (header: Buffer) => void }> = [
      {
        name: 'absolute',
        mutate: (header) => {
          writeHeaderText(header, 0, 100, '/etc/passwd');
          updateChecksum(header);
        },
      },
      {
        name: 'traversal',
        mutate: (header) => {
          writeHeaderText(header, 0, 100, `${prefix}/../escape`);
          updateChecksum(header);
        },
      },
      {
        name: 'backslash',
        mutate: (header) => {
          writeHeaderText(header, 0, 100, `${prefix}\\escape`);
          updateChecksum(header);
        },
      },
      {
        name: 'embedded-nul',
        mutate: (header) => {
          writeHeaderText(header, 0, 100, `${prefix}/bad\0tail`);
          updateChecksum(header);
        },
      },
      {
        name: 'setuid',
        mutate: (header) => {
          writeHeaderOctal(header, 100, 8, 0o4755);
          updateChecksum(header);
        },
      },
      {
        name: 'device',
        mutate: (header) => {
          header[156] = '3'.charCodeAt(0);
          updateChecksum(header);
        },
      },
      {
        name: 'sparse',
        mutate: (header) => {
          header[156] = 'S'.charCodeAt(0);
          updateChecksum(header);
        },
      },
      {
        name: 'checksum',
        mutate: (header) => {
          header[0] ^= 1;
        },
      },
    ];

    for (const item of mutations) {
      const tar = Buffer.from(baseTar);
      const header = tar.subarray(512, 1024);
      item.mutate(header);
      const bytes = gzipSync(tar, { level: 9 });
      const path = join(workspace, `${item.name}.tar.gz`);
      writeFileSync(path, bytes);
      await assert.rejects(
        strictExtractRelease({
          archivePath: path,
          destination: join(workspace, `out-${item.name}`),
          manifest: withArchiveIdentity(baseManifest, bytes, tar),
        }),
        /unsafe|malformed|forbidden|checksum|permission|entry type/iu,
        item.name,
      );
    }

    const rootHeader = baseTar.subarray(0, 512);
    const fileRecord = baseTar.subarray(512, 1536);
    const duplicateTar = Buffer.concat([rootHeader, fileRecord, fileRecord, Buffer.alloc(1024)]);
    const duplicateBytes = gzipSync(duplicateTar, { level: 9 });
    const duplicatePath = join(workspace, 'duplicate.tar.gz');
    writeFileSync(duplicatePath, duplicateBytes);
    const duplicateFiles = [
      ...baseManifest.files,
      { ...baseManifest.files[0]!, path: 'declared-but-absent' },
    ];
    await assert.rejects(
      strictExtractRelease({
        archivePath: duplicatePath,
        destination: join(workspace, 'out-duplicate'),
        manifest: withArchiveIdentity(baseManifest, duplicateBytes, duplicateTar, duplicateFiles),
      }),
      /Duplicate normalized archive path/iu,
    );

    const childHeader = Buffer.from(baseTar.subarray(512, 1024));
    writeHeaderText(childHeader, 0, 100, `${prefix}/payload/child`);
    writeHeaderOctal(childHeader, 124, 12, 0);
    updateChecksum(childHeader);
    const conflictTar = Buffer.concat([
      rootHeader,
      fileRecord,
      childHeader,
      Buffer.alloc(1024),
    ]);
    const conflictBytes = gzipSync(conflictTar, { level: 9 });
    const conflictPath = join(workspace, 'conflict.tar.gz');
    writeFileSync(conflictPath, conflictBytes);
    const conflictFiles = [
      ...baseManifest.files,
      {
        path: 'payload/child',
        type: 'file' as const,
        mode: baseManifest.files[0]!.mode,
        size: 0,
        digest: sha256Hex(Buffer.alloc(0)),
      },
    ];
    await assert.rejects(
      strictExtractRelease({
        archivePath: conflictPath,
        destination: join(workspace, 'out-conflict'),
        manifest: withArchiveIdentity(baseManifest, conflictBytes, conflictTar, conflictFiles),
      }),
      /parent directory is absent or conflicting/iu,
    );
  });

  it('rejects nonempty extraction destinations and configured size bounds', async () => {
    const workspace = root();
    const release = join(workspace, 'release-root');
    mkdirSync(release);
    writeFileSync(join(release, 'payload'), 'bounded');
    const built = await createDeterministicTarGz({
      releaseRoot: release,
      topLevelPrefix: 'se-z-0.3.0-fixture',
      archivePath: join(workspace, 'release.tar.gz'),
      sourceDateEpoch: 1_700_000_000,
    });
    const destination = join(workspace, 'nonempty');
    mkdirSync(destination);
    writeFileSync(join(destination, 'existing'), 'keep');
    await assert.rejects(
      strictExtractRelease({
        archivePath: join(workspace, 'release.tar.gz'),
        destination,
        manifest: manifest(built),
      }),
      /empty/u,
    );
    await assert.rejects(
      strictExtractRelease({
        archivePath: join(workspace, 'release.tar.gz'),
        destination: join(workspace, 'bounded-out'),
        manifest: manifest(built),
        limits: {
          maxCompressedBytes: built.archive.compressedSize - 1,
          maxDecompressedBytes: built.archive.decompressedSize,
          maxFileBytes: 1024,
          maxMembers: 100,
        },
      }),
      /bound/u,
    );
  });
});

// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Bounded streaming extractor for the one supported release archive profile. */

import { createHash, type Hash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  utimesSync,
  writeSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { sha256Hex } from '../protocol/canonical/canonical.js';
import { DeploymentError } from './deployment/types.js';
import {
  DEFAULT_STRICT_ARCHIVE_LIMITS,
  parseMode,
  validateExtractableManifest,
  type ExtractableReleaseManifest,
  type ReleaseFileEntry,
  type StrictArchiveLimits,
} from './archive-contract.js';

interface ParsedHeader {
  path: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtime: number;
  type: 'file' | 'directory';
}

interface ActiveFile {
  path: string;
  absolutePath: string;
  fd: number;
  remaining: number;
  padding: number;
  written: number;
  expected: ReleaseFileEntry;
  hash: Hash;
}

function fail(message: string): never {
  throw new DeploymentError('deployment_invalid', message);
}

function readTextField(header: Buffer, offset: number, length: number, label: string): string {
  const field = header.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  const content = terminator >= 0 ? field.subarray(0, terminator) : field;
  if (terminator >= 0 && field.subarray(terminator + 1).some((byte) => byte !== 0)) {
    fail(`Malformed ${label} field`);
  }
  if (content.some((byte) => byte < 0x20 || byte > 0x7e)) {
    fail(`Non-ASCII ${label} field`);
  }
  return content.toString('ascii');
}

function readOctal(header: Buffer, offset: number, length: number, label: string): number {
  const field = header.subarray(offset, offset + length);
  if ((field[0] ?? 0) >= 0x80) fail(`Base-256 ${label} is unsupported`);
  const value = field.toString('ascii').replace(/[\0 ]+$/u, '').replace(/^ +/u, '');
  if (!/^[0-7]+$/.test(value)) fail(`Malformed octal ${label}`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) fail(`Unsafe numeric ${label}`);
  return parsed;
}

function verifyChecksum(header: Buffer): void {
  const checksumText = header.subarray(148, 156).toString('ascii').replace(/[\0 ]/gu, '');
  if (!/^[0-7]{1,6}$/.test(checksumText)) fail('Malformed tar checksum');
  const declared = Number.parseInt(checksumText, 8);
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  const actual = copy.reduce((sum, byte) => sum + byte, 0);
  if (actual !== declared) fail('Tar header checksum mismatch');
}

function parseHeader(header: Buffer): ParsedHeader {
  verifyChecksum(header);
  if (!header.subarray(257, 263).equals(Buffer.from('ustar\0', 'ascii'))) {
    fail('Only POSIX ustar headers are supported');
  }
  if (!header.subarray(263, 265).equals(Buffer.from('00', 'ascii'))) {
    fail('Unsupported ustar version');
  }
  if (header.subarray(500, 512).some((byte) => byte !== 0)) {
    fail('Unsupported tar header metadata');
  }
  if (header.subarray(157, 257).some((byte) => byte !== 0)) {
    fail('Link metadata is forbidden');
  }

  const name = readTextField(header, 0, 100, 'name');
  const prefix = readTextField(header, 345, 155, 'prefix');
  const path = prefix ? `${prefix}/${name}` : name;
  if (
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.includes('//')
  ) {
    fail(`Unsafe archive path ${path}`);
  }
  const withoutDirectorySlash = path.endsWith('/') ? path.slice(0, -1) : path;
  const parts = withoutDirectorySlash.split('/');
  if (
    parts.some((part) => part === '' || part === '.' || part === '..') ||
    !parts.every((part) => /^[A-Za-z0-9._@-]+$/.test(part))
  ) {
    fail(`Unsafe archive path ${path}`);
  }

  const typeflag = header[156];
  const type = typeflag === 0x35
    ? 'directory'
    : typeflag === 0x30 || typeflag === 0
      ? 'file'
      : undefined;
  if (!type) fail(`Forbidden or extended tar entry type ${String.fromCharCode(typeflag ?? 0)}`);
  if (type === 'directory' && !path.endsWith('/')) fail('Directory entry lacks trailing slash');
  if (type === 'file' && path.endsWith('/')) fail('Regular file has directory path');

  const mode = readOctal(header, 100, 8, 'mode');
  const uid = readOctal(header, 108, 8, 'uid');
  const gid = readOctal(header, 116, 8, 'gid');
  const size = readOctal(header, 124, 12, 'size');
  const mtime = readOctal(header, 136, 12, 'mtime');
  if ((mode & ~0o777) !== 0) fail(`Forbidden special permission bits on ${path}`);
  if (uid !== 0 || gid !== 0) fail(`Archive ownership is not normalized for ${path}`);
  if (type === 'directory' && size !== 0) fail(`Directory has content bytes: ${path}`);
  return { path: withoutDirectorySlash, mode, uid, gid, size, mtime, type };
}

function hashRegularFile(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

class StrictTarExtractor extends Writable {
  private headerBuffer = Buffer.alloc(0);
  private activeFile: ActiveFile | undefined;
  private zeroBlocks = 0;
  private ended = false;
  private decompressedBytes = 0;
  private memberCount = 0;
  private readonly seen = new Set<string>();
  private readonly seenTypes = new Map<string, 'file' | 'directory'>();
  private readonly directories: string[] = [];
  private readonly releaseRoot: string;
  private readonly prefix: string;

  constructor(
    destination: string,
    private readonly manifest: ExtractableReleaseManifest,
    private readonly expected: Map<string, ReleaseFileEntry>,
    private readonly limits: StrictArchiveLimits,
  ) {
    super();
    this.prefix = manifest.archive.topLevelPrefix.slice(0, -1);
    this.releaseRoot = join(destination, this.prefix);
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      this.decompressedBytes += data.length;
      if (
        this.decompressedBytes > this.limits.maxDecompressedBytes ||
        this.decompressedBytes > this.manifest.archive.decompressedSize
      ) {
        fail('Decompressed archive exceeds its declared bound');
      }
      this.consume(data);
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private consume(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.ended) {
        if (chunk.subarray(offset).some((byte) => byte !== 0)) {
          fail('Tar archive has trailing nonzero data');
        }
        return;
      }

      if (this.activeFile) {
        const active = this.activeFile;
        if (active.remaining > 0) {
          const count = Math.min(active.remaining, chunk.length - offset);
          const slice = chunk.subarray(offset, offset + count);
          const written = writeSync(active.fd, slice, 0, slice.length, null);
          if (written !== slice.length) fail(`Short extraction write for ${active.path}`);
          active.hash.update(slice);
          active.remaining -= count;
          active.written += count;
          offset += count;
          if (active.remaining === 0 && active.padding === 0) this.finishActiveFile();
          continue;
        }
        if (active.padding > 0) {
          const count = Math.min(active.padding, chunk.length - offset);
          if (chunk.subarray(offset, offset + count).some((byte) => byte !== 0)) {
            fail(`Nonzero tar padding for ${active.path}`);
          }
          active.padding -= count;
          offset += count;
          if (active.padding === 0) this.finishActiveFile();
          continue;
        }
      }

      const needed = 512 - this.headerBuffer.length;
      const count = Math.min(needed, chunk.length - offset);
      this.headerBuffer = Buffer.concat([
        this.headerBuffer,
        chunk.subarray(offset, offset + count),
      ]);
      offset += count;
      if (this.headerBuffer.length === 512) {
        const header = this.headerBuffer;
        this.headerBuffer = Buffer.alloc(0);
        if (header.every((byte) => byte === 0)) {
          this.zeroBlocks += 1;
          if (this.zeroBlocks === 2) this.ended = true;
          continue;
        }
        if (this.zeroBlocks !== 0) fail('A single zero tar block preceded another member');
        this.startEntry(parseHeader(header));
      }
    }
  }

  private startEntry(header: ParsedHeader): void {
    this.memberCount += 1;
    if (this.memberCount > this.limits.maxMembers) fail('Archive contains too many members');
    if (header.mtime !== this.manifest.sourceDateEpoch) {
      fail(`Non-normalized mtime for ${header.path}`);
    }
    if (this.seen.has(header.path)) fail(`Duplicate normalized archive path ${header.path}`);
    this.seen.add(header.path);

    if (header.path === this.prefix) {
      if (this.memberCount !== 1 || header.type !== 'directory' || header.mode !== 0o755) {
        fail('Archive root must be the first normalized 0755 directory');
      }
      mkdirSync(this.releaseRoot, { recursive: false, mode: 0o755 });
      chmodSync(this.releaseRoot, 0o755);
      this.directories.push(this.releaseRoot);
      this.seenTypes.set('', 'directory');
      return;
    }

    const expectedPrefix = `${this.prefix}/`;
    if (!header.path.startsWith(expectedPrefix)) {
      fail(`Archive entry is outside the one expected prefix: ${header.path}`);
    }
    const relativePath = header.path.slice(expectedPrefix.length);
    const expected = this.expected.get(relativePath);
    if (!expected) fail(`Undeclared archive entry ${relativePath}`);
    if (
      expected.type !== header.type ||
      parseMode(expected.mode) !== header.mode ||
      expected.size !== header.size
    ) {
      fail(`Archive header differs from manifest for ${relativePath}`);
    }
    if (header.size > this.limits.maxFileBytes) fail(`Archive file is too large: ${relativePath}`);

    const components = relativePath.split('/');
    let parent = '';
    for (const component of components.slice(0, -1)) {
      parent = parent ? `${parent}/${component}` : component;
      if (this.seenTypes.get(parent) !== 'directory') {
        fail(`Archive parent directory is absent or conflicting: ${parent}`);
      }
    }
    if ([...this.seenTypes.keys()].some((path) => path.startsWith(`${relativePath}/`))) {
      fail(`Archive file/directory conflict at ${relativePath}`);
    }
    this.seenTypes.set(relativePath, header.type);
    const target = resolve(this.releaseRoot, ...components);
    if (!target.startsWith(`${this.releaseRoot}${sep}`)) fail(`Extraction escaped root: ${relativePath}`);

    if (header.type === 'directory') {
      mkdirSync(target, { recursive: false, mode: header.mode });
      chmodSync(target, header.mode);
      this.directories.push(target);
      if (expected.digest !== sha256Hex(Buffer.alloc(0))) {
        fail(`Directory digest is not canonical: ${relativePath}`);
      }
      return;
    }

    const fd = openSync(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      header.mode,
    );
    this.activeFile = {
      path: relativePath,
      absolutePath: target,
      fd,
      remaining: header.size,
      padding: (512 - (header.size % 512)) % 512,
      written: 0,
      expected,
      hash: createHash('sha256'),
    };
    if (header.size === 0 && this.activeFile.padding === 0) this.finishActiveFile();
  }

  private finishActiveFile(): void {
    const active = this.activeFile;
    if (!active) return;
    try {
      fsyncSync(active.fd);
      if (active.written !== active.expected.size) fail(`Truncated file ${active.path}`);
      const digest = active.hash.digest('hex');
      if (digest !== active.expected.digest) fail(`File digest mismatch for ${active.path}`);
      chmodSync(active.absolutePath, parseMode(active.expected.mode));
      const timestamp = new Date(this.manifest.sourceDateEpoch * 1000);
      utimesSync(active.absolutePath, timestamp, timestamp);
    } finally {
      closeSync(active.fd);
      this.activeFile = undefined;
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    try {
      if (this.activeFile || this.headerBuffer.length !== 0 || !this.ended) {
        fail('Archive ended before two zero blocks');
      }
      if (this.decompressedBytes !== this.manifest.archive.decompressedSize) {
        fail('Decompressed archive length differs from manifest');
      }
      if (this.memberCount !== this.manifest.archive.memberCount) {
        fail('Archive member count differs from manifest');
      }
      for (const path of this.expected.keys()) {
        if (!this.seen.has(`${this.prefix}/${path}`)) fail(`Manifest entry is missing: ${path}`);
      }
      const timestamp = new Date(this.manifest.sourceDateEpoch * 1000);
      for (const directory of [...this.directories].reverse()) {
        utimesSync(directory, timestamp, timestamp);
        fsyncDirectory(directory);
      }
      this.readBack();
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.activeFile) {
      try {
        closeSync(this.activeFile.fd);
      } catch {
        // Preserve the extraction error.
      }
      this.activeFile = undefined;
    }
    callback(error);
  }

  private readBack(): void {
    const found = new Set<string>();
    const walk = (directory: string, base = ''): void => {
      for (const name of readdirSync(directory).sort()) {
        const absolute = join(directory, name);
        const path = base ? `${base}/${name}` : name;
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
          fail(`Extracted special entry ${path}`);
        }
        const expected = this.expected.get(path);
        if (!expected) fail(`Extracted undeclared entry ${path}`);
        if (
          (stat.isDirectory() ? 'directory' : 'file') !== expected.type ||
          (stat.mode & 0o777) !== parseMode(expected.mode) ||
          (stat.isFile() && stat.size !== expected.size)
        ) {
          fail(`Extracted metadata mismatch for ${path}`);
        }
        if (stat.isFile() && hashRegularFile(absolute) !== expected.digest) {
          fail(`Extracted readback digest mismatch for ${path}`);
        }
        found.add(path);
        if (stat.isDirectory()) walk(absolute, path);
      }
    };
    walk(this.releaseRoot);
    if (found.size !== this.expected.size) fail('Extracted file count differs from manifest');
  }
}

function hashArchive(path: string, maxBytes: number): { digest: string; size: number } {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('Archive path is not a regular file');
  if (stat.size <= 0 || stat.size > maxBytes) fail('Compressed archive exceeds its bound');
  return { digest: hashRegularFile(path), size: stat.size };
}

export async function strictExtractRelease(input: {
  archivePath: string;
  destination: string;
  manifest: ExtractableReleaseManifest;
  limits?: StrictArchiveLimits;
}): Promise<{ releaseRoot: string; archiveDigest: string }> {
  const limits = input.limits ?? DEFAULT_STRICT_ARCHIVE_LIMITS;
  const expected = validateExtractableManifest(input.manifest, limits);
  const archive = hashArchive(input.archivePath, limits.maxCompressedBytes);
  if (
    archive.digest !== input.manifest.archive.digest ||
    archive.size !== input.manifest.archive.compressedSize
  ) {
    fail('Compressed archive identity differs from manifest');
  }

  const destination = resolve(input.destination);
  if (existsSync(destination)) {
    const stat = lstatSync(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Destination is not a real directory');
    if (readdirSync(destination).length !== 0) fail('Destination must be empty');
  } else {
    mkdirSync(destination, { recursive: false, mode: 0o700 });
  }

  const extractor = new StrictTarExtractor(destination, input.manifest, expected, limits);
  try {
    await pipeline(createReadStream(input.archivePath), createGunzip(), extractor);
    fsyncDirectory(destination);
    return {
      releaseRoot: join(destination, input.manifest.archive.topLevelPrefix.slice(0, -1)),
      archiveDigest: archive.digest,
    };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

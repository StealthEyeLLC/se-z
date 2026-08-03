// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Deterministic POSIX ustar+gzip release writer with no extension records. */

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs';
import { finished } from 'node:stream/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { createGzip } from 'node:zlib';
import { sha256Hex } from '../protocol/canonical/canonical.js';
import {
  formatMode,
  type ReleaseFileEntry,
  type StrictArchiveDeclaration,
  STRICT_ARCHIVE_PROFILE,
} from './archive-contract.js';

interface SourceEntry {
  absolutePath: string;
  relativePath: string;
  type: 'file' | 'directory';
  mode: number;
  size: number;
  digest: string;
}

function assertAsciiPath(path: string): void {
  if (!/^[A-Za-z0-9._@/-]+$/.test(path) || path.includes('//')) {
    throw new Error(`Path cannot be represented by the strict ustar profile: ${path}`);
  }
}

function hashFile(path: string): string {
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

function enumerate(root: string): SourceEntry[] {
  const absoluteRoot = resolve(root);
  const entries: SourceEntry[] = [];
  const visit = (directory: string): void => {
    const names = readdirSync(directory).sort();
    for (const name of names) {
      const absolutePath = join(directory, name);
      const stat = lstatSync(absolutePath);
      const relativePath = relative(absoluteRoot, absolutePath).split(sep).join('/');
      assertAsciiPath(relativePath);
      if (stat.isSymbolicLink()) throw new Error(`Release tree contains a link: ${relativePath}`);
      if (!stat.isFile() && !stat.isDirectory()) {
        throw new Error(`Release tree contains a special entry: ${relativePath}`);
      }
      if ((stat.mode & 0o7000) !== 0) {
        throw new Error(`Release tree contains special permission bits: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        entries.push({
          absolutePath,
          relativePath,
          type: 'directory',
          mode: stat.mode & 0o777,
          size: 0,
          digest: sha256Hex(Buffer.alloc(0)),
        });
        visit(absolutePath);
      } else {
        entries.push({
          absolutePath,
          relativePath,
          type: 'file',
          mode: stat.mode & 0o777,
          size: stat.size,
          digest: hashFile(absolutePath),
        });
      }
    }
  };
  visit(absoluteRoot);
  return entries.sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
  );
}

function writeString(header: Buffer, value: string, offset: number, length: number): void {
  const encoded = Buffer.from(value, 'ascii');
  if (encoded.length > length) throw new Error(`ustar field overflow: ${value}`);
  encoded.copy(header, offset);
}

function writeOctal(header: Buffer, value: number, offset: number, length: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid ustar number');
  const encoded = value.toString(8).padStart(length - 1, '0');
  if (encoded.length > length - 1) throw new Error(`ustar numeric field overflow: ${value}`);
  writeString(header, `${encoded}\0`, offset, length);
}

function splitUstarPath(path: string): { name: string; prefix: string } {
  const encoded = Buffer.byteLength(path, 'ascii');
  if (encoded <= 100) return { name: path, prefix: '' };
  for (let index = path.lastIndexOf('/'); index > 0; index = path.lastIndexOf('/', index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix, 'ascii') <= 155 && Buffer.byteLength(name, 'ascii') <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`Path exceeds strict ustar fields: ${path}`);
}

function tarHeader(input: {
  path: string;
  type: 'file' | 'directory';
  mode: number;
  size: number;
  mtime: number;
}): Buffer {
  const path = input.type === 'directory' && !input.path.endsWith('/')
    ? `${input.path}/`
    : input.path;
  const { name, prefix } = splitUstarPath(path);
  const header = Buffer.alloc(512, 0);
  writeString(header, name, 0, 100);
  writeOctal(header, input.mode, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, input.type === 'directory' ? 0 : input.size, 124, 12);
  writeOctal(header, input.mtime, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = input.type === 'directory' ? 0x35 : 0x30;
  writeString(header, 'ustar\0', 257, 6);
  writeString(header, '00', 263, 2);
  writeString(header, prefix, 345, 155);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, '0');
  writeString(header, `${checksumText}\0 `, 148, 8);
  return header;
}

async function writeWithBackpressure(
  stream: NodeJS.WritableStream,
  data: Buffer,
): Promise<void> {
  if (stream.write(data)) return;
  await new Promise<void>((resolvePromise, reject) => {
    const cleanup = (): void => {
      stream.removeListener('drain', onDrain);
      stream.removeListener('error', onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolvePromise();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

export interface DeterministicArchiveResult {
  archive: StrictArchiveDeclaration;
  files: ReleaseFileEntry[];
}

export async function createDeterministicTarGz(input: {
  releaseRoot: string;
  topLevelPrefix: string;
  archivePath: string;
  sourceDateEpoch: number;
}): Promise<DeterministicArchiveResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.topLevelPrefix)) {
    throw new Error('Invalid archive top-level prefix');
  }
  if (!Number.isSafeInteger(input.sourceDateEpoch) || input.sourceDateEpoch < 0) {
    throw new Error('Invalid source-date epoch');
  }
  const entries = enumerate(input.releaseRoot);
  const output = createWriteStream(input.archivePath, { flags: 'wx', mode: 0o600 });
  const gzip = createGzip({ level: 9 });
  gzip.pipe(output);
  let decompressedSize = 0;
  const writeTar = async (data: Buffer): Promise<void> => {
    decompressedSize += data.length;
    await writeWithBackpressure(gzip, data);
  };

  try {
    await writeTar(
      tarHeader({
        path: input.topLevelPrefix,
        type: 'directory',
        mode: 0o755,
        size: 0,
        mtime: input.sourceDateEpoch,
      }),
    );
    for (const entry of entries) {
      const archivePath = posix.join(input.topLevelPrefix, entry.relativePath);
      await writeTar(
        tarHeader({
          path: archivePath,
          type: entry.type,
          mode: entry.mode,
          size: entry.size,
          mtime: input.sourceDateEpoch,
        }),
      );
      if (entry.type === 'file') {
        for await (const chunk of createReadStream(entry.absolutePath)) {
          await writeTar(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const padding = (512 - (entry.size % 512)) % 512;
        if (padding > 0) await writeTar(Buffer.alloc(padding));
      }
    }
    await writeTar(Buffer.alloc(1024));
    gzip.end();
    await Promise.all([finished(gzip), finished(output)]);
  } catch (error) {
    gzip.destroy();
    output.destroy();
    throw error;
  }

  const archiveFd = openSync(input.archivePath, 'r');
  try {
    fsyncSync(archiveFd);
  } finally {
    closeSync(archiveFd);
  }
  const directoryFd = openSync(dirname(input.archivePath), 'r');
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
  return {
    archive: {
      format: 'tar.gz',
      digest: hashFile(input.archivePath),
      compressedSize: lstatSync(input.archivePath).size,
      decompressedSize,
      memberCount: entries.length + 1,
      topLevelPrefix: `${input.topLevelPrefix}/`,
      strictProfile: STRICT_ARCHIVE_PROFILE,
    },
    files: entries.map((entry) => ({
      path: entry.relativePath,
      type: entry.type,
      mode: formatMode(entry.mode),
      size: entry.size,
      digest: entry.digest,
    })),
  };
}

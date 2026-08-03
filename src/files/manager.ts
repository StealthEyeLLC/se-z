// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Binary-safe file operations with symlink, recursion, and atomic replacement bounds. */

import {
  lstatSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
  writeSync,
  rmSync,
  fsyncSync,
  fchmodSync,
  fchownSync,
  constants,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { OperationError } from '../operations/errors.js';

export const FILE_LIST_MAX_DEPTH = 32;
export const FILE_LIST_MAX_ENTRIES = 4096;
export const FILE_READ_MAX_CHUNK = 64 * 1024;

export interface FileStatPayload {
  path: string;
}

export interface FileReadPayload {
  path: string;
  offset?: number;
  limit?: number;
  encoding?: 'base64' | 'utf8';
}

export interface FileWritePayload {
  path: string;
  data: string;
  encoding?: 'base64' | 'utf8';
  offset?: number;
  create?: boolean;
}

export interface FileReplacePayload {
  root: string;
  path: string;
  data: string;
  encoding?: 'base64' | 'utf8';
  expectedSha256?: string;
  expectedAbsent?: boolean;
  preserveMode?: boolean;
  durable?: boolean;
  createParents?: boolean;
}

export interface FilePatchPayload {
  path: string;
  patches: Array<{
    offset: number;
    data: string;
    encoding?: 'base64' | 'utf8';
  }>;
}

export interface FileCopyPayload {
  source: string;
  destination: string;
  overwrite?: boolean;
}

export interface FileMovePayload {
  source: string;
  destination: string;
  overwrite?: boolean;
}

export interface FileRemovePayload {
  path: string;
  recursive?: boolean;
}

export interface FileListPayload {
  path: string;
  recursive?: boolean;
  maxDepth?: number;
  maxEntries?: number;
}

export interface FileStatResult {
  path: string;
  exists: boolean;
  type?: 'file' | 'directory' | 'symlink' | 'other';
  size?: number;
  mode?: number;
  uid?: number;
  gid?: number;
  mtime?: string;
  sha256?: string;
}

function assertSafePath(path: string): string {
  const resolved = resolve(path);
  if (resolved.includes('\0')) {
    throw new OperationError('invalid_path', 'Path contains null byte');
  }
  return resolved;
}

function decodeData(data: string, encoding: 'base64' | 'utf8' = 'base64'): Buffer {
  return encoding === 'utf8' ? Buffer.from(data, 'utf8') : Buffer.from(data, 'base64');
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isWithinRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function assertNoSymlinkComponents(root: string, targetParent: string, createParents: boolean): void {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new OperationError('unsafe_path', 'Confinement root must be a real directory');
  }

  const rel = relative(root, targetParent);
  const components = rel === '' ? [] : rel.split(sep);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    if (!existsSync(current)) {
      if (!createParents) {
        throw new OperationError('parent_not_found', `Parent directory does not exist: ${current}`);
      }
      mkdirSync(current, { mode: 0o750 });
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new OperationError('unsafe_path', `Path component is not a real directory: ${current}`);
    }
  }
}

export class FileManager {
  stat(payload: FileStatPayload): FileStatResult {
    const path = assertSafePath(payload.path);
    if (!existsSync(path)) {
      return { path, exists: false };
    }
    const s = lstatSync(path);
    const result: FileStatResult = {
      path,
      exists: true,
      size: s.size,
      mode: s.mode,
      uid: s.uid,
      gid: s.gid,
      mtime: s.mtime.toISOString(),
    };
    if (s.isSymbolicLink()) {
      result.type = 'symlink';
    } else if (s.isFile()) {
      result.type = 'file';
      if (s.size <= 10 * 1024 * 1024) {
        result.sha256 = sha256File(path);
      }
    } else if (s.isDirectory()) {
      result.type = 'directory';
    } else {
      result.type = 'other';
    }
    return result;
  }

  read(payload: FileReadPayload): { data: string; offset: number; eof: boolean; encoding: string } {
    const path = assertSafePath(payload.path);
    const encoding = payload.encoding ?? 'base64';
    const offset = payload.offset ?? 0;
    const limit = Math.min(payload.limit ?? FILE_READ_MAX_CHUNK, FILE_READ_MAX_CHUNK);

    const fd = openSync(path, 'r');
    try {
      const stat = lstatSync(path);
      const available = Math.max(0, stat.size - offset);
      const toRead = Math.min(limit, available);
      const buf = Buffer.alloc(toRead);
      if (toRead > 0) {
        readSync(fd, buf, 0, toRead, offset);
      }
      const data = encoding === 'utf8' ? buf.toString('utf8') : buf.toString('base64');
      return {
        data,
        offset: offset + toRead,
        eof: offset + toRead >= stat.size,
        encoding,
      };
    } finally {
      closeSync(fd);
    }
  }

  write(payload: FileWritePayload): { path: string; bytesWritten: number } {
    const path = assertSafePath(payload.path);
    const encoding = payload.encoding ?? 'base64';
    const buf = decodeData(payload.data, encoding);

    if (payload.offset !== undefined && payload.offset > 0) {
      const fd = openSync(path, 'r+');
      try {
        writeSync(fd, buf, 0, buf.length, payload.offset);
      } finally {
        closeSync(fd);
      }
    } else {
      if (payload.create !== false) {
        mkdirSync(dirname(path), { recursive: true });
      }
      writeFileSync(path, buf);
    }
    return { path, bytesWritten: buf.length };
  }

  replace(payload: FileReplacePayload): {
    path: string;
    bytesWritten: number;
    created: boolean;
    previousSha256?: string;
    sha256: string;
    durable: boolean;
  } {
    if (!payload.root || !payload.path) {
      throw new OperationError('invalid_request', 'root and path are required');
    }
    if (payload.expectedAbsent && payload.expectedSha256) {
      throw new OperationError(
        'invalid_request',
        'expectedAbsent and expectedSha256 cannot be used together',
      );
    }

    const root = assertSafePath(payload.root);
    const path = assertSafePath(isAbsolute(payload.path) ? payload.path : join(root, payload.path));
    if (!isWithinRoot(root, path)) {
      throw new OperationError('path_outside_root', 'Target path must be strictly beneath root', false, {
        root,
        path,
      });
    }

    const parent = dirname(path);
    assertNoSymlinkComponents(root, parent, payload.createParents ?? false);

    const existed = existsSync(path);
    let previousSha256: string | undefined;
    let previousMode = 0o600;
    let previousUid: number | undefined;
    let previousGid: number | undefined;
    if (existed) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new OperationError('unsafe_path', 'Target must be a regular file and not a symlink');
      }
      previousSha256 = sha256File(path);
      previousMode = stat.mode & 0o7777;
      previousUid = stat.uid;
      previousGid = stat.gid;
    }

    if (payload.expectedAbsent && existed) {
      throw new OperationError('precondition_failed', 'Target already exists', false, {
        expectedAbsent: true,
        actualSha256: previousSha256,
      });
    }
    if (payload.expectedSha256) {
      if (!existed || previousSha256 !== payload.expectedSha256) {
        throw new OperationError('precondition_failed', 'Target SHA-256 does not match', false, {
          expectedSha256: payload.expectedSha256,
          actualSha256: previousSha256 ?? null,
        });
      }
    }

    const data = decodeData(payload.data, payload.encoding ?? 'base64');
    const temporary = join(parent, `.${basename(path)}.se-z-${randomUUID()}.tmp`);
    const durable = payload.durable ?? true;
    let fd: number | undefined;
    try {
      fd = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        payload.preserveMode === false ? 0o600 : previousMode,
      );
      writeFileSync(fd, data);
      if (payload.preserveMode !== false && existed) {
        fchmodSync(fd, previousMode);
        if (previousUid !== undefined && previousGid !== undefined) {
          fchownSync(fd, previousUid, previousGid);
        }
      }
      if (durable) fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, path);
      if (durable) {
        const directoryFd = openSync(parent, 'r');
        try {
          fsyncSync(directoryFd);
        } finally {
          closeSync(directoryFd);
        }
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
    }

    return {
      path,
      bytesWritten: data.length,
      created: !existed,
      ...(previousSha256 ? { previousSha256 } : {}),
      sha256: sha256File(path),
      durable,
    };
  }

  patch(payload: FilePatchPayload): { path: string; patchesApplied: number } {
    const path = assertSafePath(payload.path);
    const fd = openSync(path, 'r+');
    let applied = 0;
    try {
      for (const patch of payload.patches) {
        const buf = decodeData(patch.data, patch.encoding ?? 'base64');
        writeSync(fd, buf, 0, buf.length, patch.offset);
        applied++;
      }
    } finally {
      closeSync(fd);
    }
    return { path, patchesApplied: applied };
  }

  copy(payload: FileCopyPayload): { source: string; destination: string } {
    const source = assertSafePath(payload.source);
    const destination = assertSafePath(payload.destination);
    if (!payload.overwrite && existsSync(destination)) {
      throw new OperationError('destination_exists', 'Destination exists');
    }
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    return { source, destination };
  }

  move(payload: FileMovePayload): { source: string; destination: string } {
    const source = assertSafePath(payload.source);
    const destination = assertSafePath(payload.destination);
    if (!payload.overwrite && existsSync(destination)) {
      throw new OperationError('destination_exists', 'Destination exists');
    }
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(source, destination);
    return { source, destination };
  }

  remove(payload: FileRemovePayload): { path: string; removed: boolean } {
    const path = assertSafePath(payload.path);
    if (!existsSync(path)) {
      return { path, removed: false };
    }
    const s = lstatSync(path);
    if (s.isDirectory() && !s.isSymbolicLink()) {
      if (payload.recursive) {
        rmSync(path, { recursive: true, force: true });
      } else {
        throw new OperationError('recursive_required', 'Cannot remove directory without recursive flag');
      }
    } else {
      unlinkSync(path);
    }
    return { path, removed: true };
  }

  list(payload: FileListPayload): {
    path: string;
    entries: Array<{ name: string; type: string; path: string }>;
    truncated: boolean;
  } {
    const basePath = assertSafePath(payload.path);
    const maxDepth = payload.maxDepth ?? FILE_LIST_MAX_DEPTH;
    const maxEntries = payload.maxEntries ?? FILE_LIST_MAX_ENTRIES;
    const entries: Array<{ name: string; type: string; path: string }> = [];
    let truncated = false;

    const walk = (dir: string, depth: number) => {
      if (depth > maxDepth) {
        truncated = true;
        return;
      }
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      for (const name of readdirSync(dir)) {
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
        const fullPath = join(dir, name);
        try {
          const s = lstatSync(fullPath);
          const type = s.isSymbolicLink()
            ? 'symlink'
            : s.isDirectory()
              ? 'directory'
              : s.isFile()
                ? 'file'
                : 'other';
          entries.push({ name, type, path: fullPath });
          if (payload.recursive && s.isDirectory() && !s.isSymbolicLink()) {
            walk(fullPath, depth + 1);
          }
        } catch {
          entries.push({ name, type: 'inaccessible', path: fullPath });
        }
      }
    };

    walk(basePath, 0);
    return { path: basePath, entries, truncated };
  }
}

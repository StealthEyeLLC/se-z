import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  SezError,
  ensureDir,
  fileSha256,
  fsyncDirectory,
  normalizeError,
  randomId,
  sha256Hex,
} from './util.mjs';

function exact(payload, allowed) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new SezError('invalid_payload', 'File payload must be an object');
  for (const key of Object.keys(payload)) if (!allowed.includes(key)) throw new SezError('invalid_payload', `Unknown file payload field: ${key}`);
}

function absolute(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0')) throw new SezError('invalid_payload', 'path must be an absolute NUL-free string');
  return path.normalize(filePath);
}

function dataBuffer(data, encoding = 'base64') {
  if (typeof data !== 'string' || !['base64', 'utf8', 'hex'].includes(encoding)) throw new SezError('invalid_payload', 'data and supported encoding are required');
  try { return Buffer.from(data, encoding); }
  catch { throw new SezError('invalid_payload', 'Invalid encoded data'); }
}

function modeValue(value, fallback = undefined) {
  if (value === undefined) return fallback;
  const mode = typeof value === 'string' ? Number.parseInt(value, 8) : value;
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new SezError('invalid_payload', 'mode must be an octal string or integer');
  return mode;
}

function getent(database, value) {
  try { return execFileSync('/usr/bin/getent', [database, String(value)], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

function resolveOwner(value, database) {
  if (value === undefined) return -1;
  if (Number.isInteger(value) && value >= 0) return value;
  const row = getent(database, value);
  if (!row) throw new SezError('invalid_payload', `${database} identity does not exist: ${value}`);
  const fields = row.split(':');
  const id = Number(fields[2]);
  if (!Number.isInteger(id)) throw new SezError('state_corrupt', `${database} database returned invalid identity`);
  return id;
}

function statType(stat) {
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isBlockDevice()) return 'block-device';
  if (stat.isCharacterDevice()) return 'character-device';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isSocket()) return 'socket';
  return 'other';
}

function statRecord(filePath, stat, symlinkTarget = null) {
  return {
    path: filePath,
    type: statType(stat),
    size: stat.size,
    mode: stat.mode & 0o7777,
    modeOctal: (stat.mode & 0o7777).toString(8).padStart(4, '0'),
    uid: stat.uid,
    gid: stat.gid,
    atime: stat.atime.toISOString(),
    mtime: stat.mtime.toISOString(),
    ctime: stat.ctime.toISOString(),
    birthtime: stat.birthtime.toISOString(),
    device: stat.dev,
    inode: stat.ino,
    links: stat.nlink,
    rdev: stat.rdev,
    blockSize: stat.blksize,
    blocks: stat.blocks,
    symlinkTarget,
  };
}

export class FileOperations {
  constructor(config) { this.config = config; }

  async stat(payload) {
    exact(payload, ['path', 'followSymlinks']);
    const filePath = absolute(payload.path);
    try {
      const stat = payload.followSymlinks ? await fsp.stat(filePath) : await fsp.lstat(filePath);
      const target = stat.isSymbolicLink() ? await fsp.readlink(filePath) : null;
      return statRecord(filePath, stat, target);
    } catch (error) { throw this.wrap(error, filePath); }
  }

  async read(payload) {
    exact(payload, ['path', 'offset', 'length', 'encoding', 'followSymlinks']);
    const filePath = absolute(payload.path);
    const offset = payload.offset ?? 0;
    const length = payload.length ?? this.config.streamPageLimit;
    const encoding = payload.encoding ?? 'base64';
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > this.config.streamPageLimit) throw new SezError('invalid_payload', 'offset/length are outside the bounded file-read contract');
    if (!['base64', 'utf8', 'hex'].includes(encoding)) throw new SezError('invalid_payload', 'Unsupported file read encoding');
    const flags = fs.constants.O_RDONLY | (payload.followSymlinks === false && fs.constants.O_NOFOLLOW ? fs.constants.O_NOFOLLOW : 0);
    let handle;
    try {
      handle = await fsp.open(filePath, flags);
      const stat = await handle.stat();
      if (!stat.isFile()) throw new SezError('conflict', 'File read requires a regular file');
      if (offset > stat.size) throw new SezError('offset_out_of_range', 'File offset exceeds size', { offset, size: stat.size });
      const bytes = Math.min(length, stat.size - offset);
      const buffer = Buffer.alloc(bytes);
      let total = 0;
      while (total < bytes) {
        const result = await handle.read(buffer, total, bytes - total, offset + total);
        if (result.bytesRead === 0) break;
        total += result.bytesRead;
      }
      const data = buffer.subarray(0, total);
      return {
        path: filePath,
        encoding,
        data: data.toString(encoding),
        requestedOffset: offset,
        nextOffset: offset + total,
        bytes: total,
        size: stat.size,
        endOfFile: offset + total >= stat.size,
        pageSha256: sha256Hex(data),
        device: stat.dev,
        inode: stat.ino,
      };
    } catch (error) { throw this.wrap(error, filePath); }
    finally { await handle?.close().catch(() => {}); }
  }

  async write(payload) {
    exact(payload, ['path', 'data', 'encoding', 'offset', 'create', 'truncate', 'mode', 'flush', 'followSymlinks']);
    const filePath = absolute(payload.path);
    const buffer = dataBuffer(payload.data, payload.encoding ?? 'base64');
    const create = payload.create ?? true;
    const truncate = payload.truncate ?? payload.offset === undefined;
    const offset = payload.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new SezError('invalid_payload', 'offset must be nonnegative');
    let flags = fs.constants.O_WRONLY;
    if (create) flags |= fs.constants.O_CREAT;
    if (truncate) flags |= fs.constants.O_TRUNC;
    if (payload.followSymlinks === false && fs.constants.O_NOFOLLOW) flags |= fs.constants.O_NOFOLLOW;
    let handle;
    try {
      handle = await fsp.open(filePath, flags, modeValue(payload.mode, 0o600));
      let written = 0;
      while (written < buffer.length) {
        const result = await handle.write(buffer, written, buffer.length - written, offset + written);
        written += result.bytesWritten;
      }
      if (payload.flush ?? true) await handle.sync();
      const stat = await handle.stat();
      return { path: filePath, bytesWritten: written, offset, nextOffset: offset + written, size: stat.size, sha256: await fileSha256(filePath) };
    } catch (error) { throw this.wrap(error, filePath); }
    finally { await handle?.close().catch(() => {}); }
  }

  async replace(payload) {
    exact(payload, ['path', 'data', 'encoding', 'mode', 'uid', 'gid', 'preserveMetadata', 'expectedSha256', 'expectedAbsent']);
    const filePath = absolute(payload.path);
    const buffer = dataBuffer(payload.data, payload.encoding ?? 'base64');
    const directory = path.dirname(filePath);
    const existing = await fsp.lstat(filePath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing?.isSymbolicLink()) throw new SezError('conflict', 'Atomic replacement refuses a symlink destination');
    if (payload.expectedAbsent && existing) throw new SezError('conflict', 'Destination exists but expectedAbsent was requested');
    if (payload.expectedSha256) {
      if (!existing?.isFile()) throw new SezError('digest_mismatch', 'Expected source digest but destination is not a regular file');
      const actual = await fileSha256(filePath);
      if (actual !== payload.expectedSha256) throw new SezError('digest_mismatch', 'Destination digest does not match expectedSha256', { expected: payload.expectedSha256, actual });
    }
    await ensureDir(directory);
    const temporary = path.join(directory, `.${path.basename(filePath)}.se-z-${randomId()}`);
    let handle;
    try {
      const preserve = payload.preserveMetadata ?? true;
      const mode = modeValue(payload.mode, preserve && existing ? existing.mode & 0o7777 : 0o600);
      const uid = payload.uid === undefined ? (preserve && existing ? existing.uid : -1) : resolveOwner(payload.uid, 'passwd');
      const gid = payload.gid === undefined ? (preserve && existing ? existing.gid : -1) : resolveOwner(payload.gid, 'group');
      handle = await fsp.open(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
      await handle.writeFile(buffer);
      await handle.sync();
      await handle.close(); handle = null;
      if (uid !== -1 || gid !== -1) await fsp.chown(temporary, uid, gid);
      await fsp.chmod(temporary, mode);
      if (this.config.faultInjection.atomicReplaceStage === 'before-rename') throw new Error('Injected atomic replace failure before rename');
      await fsp.rename(temporary, filePath);
      if (this.config.faultInjection.atomicReplaceStage === 'after-rename') throw new Error('Injected atomic replace failure after rename');
      await fsyncDirectory(directory);
      return { path: filePath, bytes: buffer.length, sha256: sha256Hex(buffer), atomic: true, replaced: Boolean(existing) };
    } catch (error) {
      await handle?.close().catch(() => {});
      await fsp.unlink(temporary).catch(() => {});
      throw this.wrap(error, filePath);
    }
  }

  async patch(payload) {
    exact(payload, ['path', 'expectedSha256', 'patches', 'mode', 'uid', 'gid']);
    const filePath = absolute(payload.path);
    if (typeof payload.expectedSha256 !== 'string') throw new SezError('invalid_payload', 'expectedSha256 is mandatory for patch');
    if (!Array.isArray(payload.patches) || payload.patches.length === 0) throw new SezError('invalid_payload', 'patches must be a nonempty array');
    const actual = await fileSha256(filePath).catch((error) => { throw this.wrap(error, filePath); });
    if (actual !== payload.expectedSha256) throw new SezError('digest_mismatch', 'Patch source digest mismatch', { expected: payload.expectedSha256, actual });
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new SezError('conflict', 'Patch source must be a regular file');
    const patches = payload.patches.map((entry, index) => {
      exact(entry, ['offset', 'removeLength', 'data', 'encoding']);
      if (!Number.isSafeInteger(entry.offset) || entry.offset < 0 || !Number.isSafeInteger(entry.removeLength) || entry.removeLength < 0) throw new SezError('invalid_payload', `Invalid patch range at index ${index}`);
      return { offset: entry.offset, removeLength: entry.removeLength, data: dataBuffer(entry.data, entry.encoding ?? 'base64') };
    }).sort((a, b) => a.offset - b.offset);
    for (let index = 0; index < patches.length; index += 1) {
      const patch = patches[index];
      if (patch.offset + patch.removeLength > stat.size) throw new SezError('offset_out_of_range', 'Patch range exceeds source file');
      if (index && patches[index - 1].offset + patches[index - 1].removeLength > patch.offset) throw new SezError('conflict', 'Patch ranges overlap');
    }
    const source = await fsp.readFile(filePath);
    const pieces = [];
    let cursor = 0;
    for (const patch of patches) {
      pieces.push(source.subarray(cursor, patch.offset), patch.data);
      cursor = patch.offset + patch.removeLength;
    }
    pieces.push(source.subarray(cursor));
    const output = Buffer.concat(pieces);
    return await this.replace({ path: filePath, data: output.toString('base64'), encoding: 'base64', mode: payload.mode, uid: payload.uid, gid: payload.gid, preserveMetadata: true, expectedSha256: actual });
  }

  async copy(payload) {
    exact(payload, ['source', 'destination', 'overwrite', 'recursive', 'preserveTimestamps', 'dereference']);
    const source = absolute(payload.source); const destination = absolute(payload.destination);
    const stat = await fsp.lstat(source).catch((error) => { throw this.wrap(error, source); });
    if (stat.isDirectory() && !payload.recursive) throw new SezError('conflict', 'Directory copy requires recursive=true');
    if (!payload.overwrite && await fsp.lstat(destination).catch(() => null)) throw new SezError('conflict', 'Copy destination exists');
    try {
      await fsp.cp(source, destination, { recursive: Boolean(payload.recursive), force: Boolean(payload.overwrite), errorOnExist: !payload.overwrite, preserveTimestamps: Boolean(payload.preserveTimestamps), dereference: Boolean(payload.dereference) });
      return { source, destination, type: statType(stat), copied: true };
    } catch (error) { throw this.wrap(error, destination); }
  }

  async move(payload) {
    exact(payload, ['source', 'destination', 'overwrite', 'crossFilesystem']);
    const source = absolute(payload.source); const destination = absolute(payload.destination);
    if (!payload.overwrite && await fsp.lstat(destination).catch(() => null)) throw new SezError('conflict', 'Move destination exists');
    try {
      if (payload.overwrite) await fsp.rm(destination, { recursive: true, force: true });
      await fsp.rename(source, destination);
      await fsyncDirectory(path.dirname(destination));
      if (path.dirname(source) !== path.dirname(destination)) await fsyncDirectory(path.dirname(source));
      return { source, destination, atomic: true, crossFilesystem: false };
    } catch (error) {
      if (error.code !== 'EXDEV') throw this.wrap(error, source);
      if (!payload.crossFilesystem) throw new SezError('conflict', 'Cross-filesystem move requires crossFilesystem=true');
      const stat = await fsp.lstat(source);
      await fsp.cp(source, destination, { recursive: stat.isDirectory(), force: Boolean(payload.overwrite), errorOnExist: !payload.overwrite, preserveTimestamps: true });
      await fsp.rm(source, { recursive: stat.isDirectory(), force: false });
      return { source, destination, atomic: false, crossFilesystem: true, method: 'copy-delete' };
    }
  }

  async remove(payload) {
    exact(payload, ['path', 'recursive', 'force']);
    const filePath = absolute(payload.path);
    const stat = await fsp.lstat(filePath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat) {
      if (payload.force) return { path: filePath, removed: false, absent: true };
      throw new SezError('not_found', 'Path does not exist', { path: filePath });
    }
    if (stat.isDirectory() && !payload.recursive) {
      try { await fsp.rmdir(filePath); }
      catch (error) { throw this.wrap(error, filePath); }
    } else await fsp.rm(filePath, { recursive: Boolean(payload.recursive), force: Boolean(payload.force) });
    await fsyncDirectory(path.dirname(filePath)).catch(() => {});
    return { path: filePath, removed: true, recursive: Boolean(payload.recursive) };
  }

  async list(payload) {
    exact(payload, ['path', 'offset', 'limit', 'includeHidden', 'followSymlinks']);
    const directory = absolute(payload.path);
    const offset = payload.offset ?? 0; const limit = payload.limit ?? 1000;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new SezError('invalid_payload', 'Invalid list offset/limit');
    let names;
    try { names = (await fsp.readdir(directory)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))); }
    catch (error) { throw this.wrap(error, directory); }
    if (!payload.includeHidden) names = names.filter((name) => !name.startsWith('.'));
    const selected = names.slice(offset, offset + limit);
    const entries = [];
    for (const name of selected) {
      const entryPath = path.join(directory, name);
      const stat = payload.followSymlinks ? await fsp.stat(entryPath) : await fsp.lstat(entryPath);
      entries.push(statRecord(entryPath, stat, stat.isSymbolicLink() ? await fsp.readlink(entryPath) : null));
    }
    return { path: directory, offset, nextOffset: offset + selected.length, totalEntries: names.length, complete: offset + selected.length >= names.length, entries };
  }

  async mkdir(payload) {
    exact(payload, ['path', 'recursive', 'mode']);
    const directory = absolute(payload.path);
    await fsp.mkdir(directory, { recursive: Boolean(payload.recursive), mode: modeValue(payload.mode, 0o755) }).catch((error) => { throw this.wrap(error, directory); });
    return await this.stat({ path: directory, followSymlinks: false });
  }

  async chmod(payload) {
    exact(payload, ['path', 'mode', 'followSymlinks']);
    const filePath = absolute(payload.path); const mode = modeValue(payload.mode);
    if (payload.followSymlinks === false) {
      const stat = await fsp.lstat(filePath);
      if (stat.isSymbolicLink()) throw new SezError('conflict', 'chmod does not follow symlink unless explicitly requested');
    }
    await fsp.chmod(filePath, mode).catch((error) => { throw this.wrap(error, filePath); });
    return await this.stat({ path: filePath, followSymlinks: Boolean(payload.followSymlinks) });
  }

  async chown(payload) {
    exact(payload, ['path', 'uid', 'gid', 'followSymlinks']);
    const filePath = absolute(payload.path); const uid = resolveOwner(payload.uid, 'passwd'); const gid = resolveOwner(payload.gid, 'group');
    if (uid === -1 && gid === -1) throw new SezError('invalid_payload', 'At least one of uid or gid is required');
    try {
      if (payload.followSymlinks === false && fsp.lchown) await fsp.lchown(filePath, uid, gid);
      else await fsp.chown(filePath, uid, gid);
    } catch (error) { throw this.wrap(error, filePath); }
    return await this.stat({ path: filePath, followSymlinks: Boolean(payload.followSymlinks) });
  }

  async link(payload) {
    exact(payload, ['existingPath', 'newPath']);
    const existingPath = absolute(payload.existingPath); const newPath = absolute(payload.newPath);
    await fsp.link(existingPath, newPath).catch((error) => { throw this.wrap(error, newPath); });
    return { existingPath, newPath, linked: true, type: 'hard-link' };
  }

  async symlink(payload) {
    exact(payload, ['target', 'path', 'type']);
    if (typeof payload.target !== 'string' || payload.target.includes('\0')) throw new SezError('invalid_payload', 'symlink target must be NUL-free');
    const filePath = absolute(payload.path);
    await fsp.symlink(payload.target, filePath, payload.type).catch((error) => { throw this.wrap(error, filePath); });
    return { path: filePath, target: payload.target, type: 'symlink' };
  }

  async truncate(payload) {
    exact(payload, ['path', 'length', 'followSymlinks']);
    const filePath = absolute(payload.path);
    if (!Number.isSafeInteger(payload.length) || payload.length < 0) throw new SezError('invalid_payload', 'length must be nonnegative');
    if (payload.followSymlinks === false) {
      const stat = await fsp.lstat(filePath); if (stat.isSymbolicLink()) throw new SezError('conflict', 'truncate refuses symlink unless explicitly followed');
    }
    await fsp.truncate(filePath, payload.length).catch((error) => { throw this.wrap(error, filePath); });
    return await this.stat({ path: filePath, followSymlinks: Boolean(payload.followSymlinks) });
  }

  wrap(error, filePath) {
    if (error instanceof SezError) return error;
    if (error.code === 'ENOENT') return new SezError('not_found', 'Path not found', { path: filePath });
    if (error.code === 'ENOSPC' || error.code === 'EDQUOT') return new SezError('disk_full', 'Filesystem has no available space', { path: filePath });
    if (['EEXIST', 'ENOTEMPTY', 'EISDIR', 'ENOTDIR', 'ELOOP'].includes(error.code)) return new SezError('conflict', error.message, { path: filePath, errno: error.code });
    return new SezError('operation_failed', error.message, { path: filePath, errno: error.code });
  }
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const PROTOCOL = 'SEZ1';
export const PROTOCOL_VERSION = '1.0.0';
export const PRODUCT = 'se-z';
export const KERNEL_VERSION = '0.1.0-kernel';
export const RELEASE_MILESTONE = '0.1A';
export const STATE_SCHEMA_VERSION = '0.1A.1';
export const SUBJECT = 'stealtheye-owner';
export const AUTHORITY_CLASS = 'unrestricted-owner';
export const MAX_FRAME_SIZE = 16 * 1024 * 1024;
export const DEFAULT_INLINE_LIMIT = 32 * 1024;
export const DEFAULT_STREAM_PAGE_LIMIT = 1024 * 1024;

export const ERROR_DEFINITIONS = Object.freeze({
  invalid_frame: { retryable: false, terminal: true, receipt: false },
  frame_too_large: { retryable: false, terminal: true, receipt: false },
  invalid_utf8: { retryable: false, terminal: true, receipt: false },
  invalid_json: { retryable: false, terminal: true, receipt: false },
  invalid_request: { retryable: false, terminal: true, receipt: true },
  unsupported_protocol: { retryable: false, terminal: true, receipt: true },
  unsupported_version: { retryable: false, terminal: true, receipt: true },
  handshake_required: { retryable: false, terminal: true, receipt: false },
  unknown_operation: { retryable: false, terminal: true, receipt: true },
  invalid_payload: { retryable: false, terminal: true, receipt: true },
  unauthorized_peer: { retryable: false, terminal: true, receipt: true },
  peer_class_mismatch: { retryable: false, terminal: true, receipt: true },
  unknown_gateway: { retryable: false, terminal: true, receipt: true },
  unknown_key: { retryable: false, terminal: true, receipt: true },
  invalid_signature: { retryable: false, terminal: true, receipt: true },
  stale_generation: { retryable: false, terminal: true, receipt: true },
  future_generation: { retryable: false, terminal: true, receipt: true },
  request_expired: { retryable: true, terminal: true, receipt: true },
  replay_detected: { retryable: false, terminal: true, receipt: true },
  idempotency_conflict: { retryable: false, terminal: true, receipt: true },
  target_not_supported: { retryable: false, terminal: true, receipt: true },
  not_found: { retryable: false, terminal: true, receipt: true },
  conflict: { retryable: false, terminal: true, receipt: true },
  digest_mismatch: { retryable: false, terminal: true, receipt: true },
  offset_out_of_range: { retryable: false, terminal: true, receipt: true },
  job_not_terminal: { retryable: true, terminal: false, receipt: true },
  job_lost: { retryable: false, terminal: true, receipt: true },
  job_ambiguous: { retryable: false, terminal: true, receipt: true },
  state_corrupt: { retryable: false, terminal: true, receipt: true },
  repair_required: { retryable: false, terminal: true, receipt: true },
  disk_full: { retryable: true, terminal: true, receipt: true },
  timeout: { retryable: true, terminal: true, receipt: true },
  cancelled: { retryable: false, terminal: true, receipt: true },
  operation_failed: { retryable: false, terminal: true, receipt: true },
  internal_error: { retryable: true, terminal: true, receipt: true },
});

export class SezError extends Error {
  constructor(code, message, details = undefined, options = {}) {
    super(message);
    this.name = 'SezError';
    this.code = code;
    const definition = ERROR_DEFINITIONS[code] ?? ERROR_DEFINITIONS.internal_error;
    this.retryable = options.retryable ?? definition.retryable;
    this.terminal = options.terminal ?? definition.terminal;
    this.receipt = options.receipt ?? definition.receipt;
    this.details = details === undefined ? undefined : sanitizeDiagnostic(details);
  }
}

export function normalizeError(error, fallbackCode = 'operation_failed') {
  if (error instanceof SezError) return error;
  const code = error?.code === 'ENOSPC' ? 'disk_full' : fallbackCode;
  const message = error instanceof Error ? error.message : String(error);
  return new SezError(code, message);
}

const SENSITIVE_KEY = /(private|secret|token|credential|password|bearer|authorization|cookie)/i;
export function sanitizeDiagnostic(value, depth = 0) {
  if (depth > 8) return '[depth-limit]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > 2048 ? `${value.slice(0, 2048)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 64).map((entry) => sanitizeDiagnostic(entry, depth + 1));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, entry] of Object.entries(value).slice(0, 64)) {
      output[key] = SENSITIVE_KEY.test(key) ? '[omitted]' : sanitizeDiagnostic(entry, depth + 1);
    }
    return output;
  }
  return String(value);
}

function assertPlainObject(value, location) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new SezError('invalid_request', `Unsupported object type at ${location}`);
  }
}

function compareUtf8Keys(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function canonicalNumber(value, location) {
  if (!Number.isFinite(value)) throw new SezError('invalid_request', `Non-finite number at ${location}`);
  if (Object.is(value, -0)) return '0';
  return JSON.stringify(value);
}

function canonicalizeInner(value, location, seen) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return canonicalNumber(value, location);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (seen.has(value)) throw new SezError('invalid_request', `Cyclic value at ${location}`);
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          const entries = [];
          for (let index = 0; index < value.length; index += 1) {
            if (!Object.hasOwn(value, index)) throw new SezError('invalid_request', `Sparse array at ${location}[${index}]`);
            entries.push(canonicalizeInner(value[index], `${location}[${index}]`, seen));
          }
          return `[${entries.join(',')}]`;
        }
        assertPlainObject(value, location);
        const keys = Object.keys(value).sort(compareUtf8Keys);
        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeInner(value[key], `${location}.${key}`, seen)}`).join(',')}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new SezError('invalid_request', `Unsupported ${typeof value} at ${location}`);
  }
}

export function canonicalJson(value) {
  return canonicalizeInner(value, '$', new Set());
}

export function canonicalBytes(value) {
  return Buffer.from(canonicalJson(value), 'utf8');
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function sha256Base64Url(value) {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

export function randomNonce(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomId() {
  return crypto.randomUUID();
}

export function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function assertExactKeys(object, required, optional = [], label = 'object') {
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    throw new SezError('invalid_request', `${label} must be an object`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new SezError('invalid_request', `Unknown ${label} field: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) throw new SezError('invalid_request', `Missing ${label} field: ${key}`);
  }
}

export function assertObject(value, label = 'value') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SezError('invalid_payload', `${label} must be an object`);
  }
  return value;
}

export function assertString(value, label, { min = 0, max = 1_000_000, pattern } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || (pattern && !pattern.test(value))) {
    throw new SezError('invalid_payload', `${label} must be a string matching its contract`);
  }
  return value;
}

export function assertInteger(value, label, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new SezError('invalid_payload', `${label} must be an integer in range`);
  }
  return value;
}

export function assertBoolean(value, label) {
  if (typeof value !== 'boolean') throw new SezError('invalid_payload', `${label} must be Boolean`);
  return value;
}

export async function ensureDir(directory, mode = 0o750) {
  await fsp.mkdir(directory, { recursive: true, mode });
}

export async function fsyncDirectory(directory) {
  const handle = await fsp.open(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicWriteFile(filePath, data, options = {}) {
  const directory = path.dirname(filePath);
  await ensureDir(directory, options.directoryMode ?? 0o750);
  const temporary = path.join(directory, `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  const mode = options.mode ?? 0o600;
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY;
  let handle;
  try {
    handle = await fsp.open(temporary, flags, mode);
    if (Buffer.isBuffer(data) || typeof data === 'string') await handle.writeFile(data);
    else await handle.writeFile(Buffer.from(data));
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (options.uid !== undefined || options.gid !== undefined) {
      await fsp.chown(temporary, options.uid ?? -1, options.gid ?? -1);
    }
    if (options.mode !== undefined) await fsp.chmod(temporary, options.mode);
    if (options.beforeRename) await options.beforeRename(temporary);
    await fsp.rename(temporary, filePath);
    await fsyncDirectory(directory);
  } catch (error) {
    try { if (handle) await handle.close(); } catch {}
    try { await fsp.unlink(temporary); } catch {}
    throw normalizeError(error);
  }
}

export async function atomicWriteJson(filePath, value, options = {}) {
  await atomicWriteFile(filePath, `${canonicalJson(value)}\n`, options);
}

export async function readJsonStrict(filePath, label = 'state') {
  let text;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new SezError('not_found', `${label} not found`, { path: filePath });
    throw normalizeError(error);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SezError('state_corrupt', `${label} contains invalid JSON`, { path: filePath, cause: error.message });
  }
}

export async function readJsonIfExists(filePath, label = 'state') {
  try {
    return await readJsonStrict(filePath, label);
  } catch (error) {
    if (error instanceof SezError && error.code === 'not_found') return undefined;
    throw error;
  }
}

export async function listJsonRecords(directory, label) {
  await ensureDir(directory);
  const names = (await fsp.readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  const records = [];
  for (const name of names) records.push(await readJsonStrict(path.join(directory, name), `${label}:${name}`));
  return records;
}

export async function withDirectoryLock(lockPath, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 20;
  const started = process.hrtime.bigint();
  await ensureDir(path.dirname(lockPath));
  while (true) {
    try {
      await fsp.mkdir(lockPath, { mode: 0o700 });
      await atomicWriteJson(path.join(lockPath, 'owner.json'), {
        pid: process.pid,
        startTime: await readProcStartTime(process.pid).catch(() => null),
        acquiredAt: new Date().toISOString(),
      });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw normalizeError(error);
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      if (elapsed >= timeoutMs) throw new SezError('conflict', 'Timed out acquiring durable state lock', { lockPath });
      await sleep(pollMs);
    }
  }
  try {
    return await fn();
  } finally {
    await fsp.rm(lockPath, { recursive: true, force: true });
    await fsyncDirectory(path.dirname(lockPath)).catch(() => {});
  }
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function readProcStartTime(pid) {
  const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
  const close = stat.lastIndexOf(')');
  if (close < 0) throw new Error('Malformed /proc stat');
  const fields = stat.slice(close + 2).split(' ');
  return fields[19];
}

export async function readBootId() {
  return (await fsp.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
}

export async function readMachineIdHash() {
  const value = (await fsp.readFile('/etc/machine-id', 'utf8')).trim();
  return sha256Hex(Buffer.from(value, 'utf8'));
}

export async function fileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

export async function hashFilePrefix(filePath, bytes = undefined) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath, bytes === undefined ? {} : { start: 0, end: Math.max(0, bytes - 1) });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

export function safeBasenameId(value, label = 'identifier') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === '.' || value === '..') {
    throw new SezError('invalid_payload', `Invalid ${label}`);
  }
  return value;
}

export function terminalState(state) {
  return ['completed', 'failed', 'cancelled', 'lost', 'ambiguous', 'reconciled'].includes(state);
}

export function redactPathForEvidence(filePath) {
  return typeof filePath === 'string' ? filePath.replace(/\/run\/credentials\/[^/]+\/[^/]+/g, '/run/credentials/[omitted]') : filePath;
}

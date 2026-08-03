import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// The untyped migration helper is the repository's machine-readable mechanical identity oracle.
// @ts-expect-error JavaScript module intentionally has no declaration file.
import { applyMechanicalIdentity } from '../../../scripts/phase1/source-layout.mjs';

export const REPOSITORY_ROOT = process.cwd();
export const SOURCE_SUPERVISOR_ROOT = path.resolve(process.env.SEZ_PHASE1_SUPERVISOR_SOURCE ?? path.join(REPOSITORY_ROOT, '.phase1-sources/baby-quirt'));
export const SOURCE_GATEWAY_ROOT = path.resolve(process.env.SEZ_PHASE1_GATEWAY_SOURCE ?? path.join(REPOSITORY_ROOT, '.phase1-sources/baby-quirt-mcp'));

export async function sourceSupervisor(relativePath: string): Promise<Record<string, any>> {
  return import(pathToFileURL(path.join(SOURCE_SUPERVISOR_ROOT, relativePath)).href);
}

export async function sourceGateway(relativePath: string): Promise<Record<string, any>> {
  return import(pathToFileURL(path.join(SOURCE_GATEWAY_ROOT, relativePath)).href);
}

export async function target(relativePath: string): Promise<Record<string, any>> {
  return import(pathToFileURL(path.join(REPOSITORY_ROOT, relativePath)).href);
}

export function stable(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]));
  }
  if (value === undefined) return '<UNDEFINED>';
  throw new TypeError(`Unsupported stable value: ${typeof value}`);
}

export function canonical(value: unknown): string {
  return JSON.stringify(stable(value));
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function identityNormalize<T>(value: T): T {
  return JSON.parse(applyMechanicalIdentity(JSON.stringify(value))) as T;
}

const DYNAMIC_KEYS = new Set([
  'artifactId', 'bootId', 'completedAt', 'createdAt', 'jobId', 'keyId', 'machineId',
  'machineIdSha256', 'nonce', 'outputPath', 'path', 'pgid', 'pid', 'receiptId',
  'releasePath', 'requestId', 'sessionId', 'signature', 'startedAt', 'timestamp',
  'tmuxServer', 'tmuxSession', 'tmuxWindow',
]);

export interface NormalizeOptions {
  roots?: string[];
  preserveKeys?: string[];
}

export function normalizeDynamic(value: unknown, options: NormalizeOptions = {}, key = ''): unknown {
  const preserve = new Set(options.preserveKeys ?? []);
  if (!preserve.has(key) && DYNAMIC_KEYS.has(key)) {
    if (key === 'pid' || key === 'pgid') return '<PID>';
    if (key.endsWith('At') || key === 'timestamp') return '<TIMESTAMP>';
    if (key === 'path' || key === 'outputPath' || key === 'releasePath') return '<PATH>';
    if (key === 'signature') return '<SIGNATURE>';
    return `<${key.toUpperCase()}>`;
  }
  if (typeof value === 'string') {
    let normalized = applyMechanicalIdentity(value);
    for (const root of options.roots ?? []) normalized = normalized.split(root).join('<ROOT>');
    normalized = normalized
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu, '<UUID>')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu, '<TIMESTAMP>');
    return normalized;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeDynamic(item, options));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([entryKey, item]) => [entryKey, normalizeDynamic(item, options, entryKey)]));
  }
  return value;
}

export function assertSemanticEqual(sourceValue: unknown, targetValue: unknown, options: NormalizeOptions = {}): void {
  assert.deepEqual(
    stable(normalizeDynamic(sourceValue, options)),
    stable(normalizeDynamic(targetValue, options)),
  );
}

export function assertMaterializedSources(): void {
  for (const [name, root] of [['supervisor', SOURCE_SUPERVISOR_ROOT], ['gateway', SOURCE_GATEWAY_ROOT]] as const) {
    assert.equal(fs.existsSync(path.join(root, '.git')), true, `${name} source must be materialized`);
  }
}

export function readJson(relativePath: string): any {
  return JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath), 'utf8'));
}

export function streamBytes(manager: any, jobId: string, stream: 'stdout' | 'stderr', chunkSize = 64 * 1024): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const result = manager.readStream({ jobId, stream, offset, limit: chunkSize });
    const chunk = Buffer.from(result.data, 'base64');
    chunks.push(chunk);
    assert.equal(result.offset, offset + chunk.length);
    offset = result.offset;
    if (result.eof) break;
    assert.ok(chunk.length > 0, 'non-EOF stream read must advance');
  }
  return Buffer.concat(chunks);
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

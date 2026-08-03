#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  atomicWriteJson,
  readJsonStrict,
  readProcStartTime,
  readBootId,
  SezError,
  normalizeError,
} from './util.mjs';

async function main() {
  const specPath = process.argv[2];
  if (!specPath) throw new Error('job-runner requires a runner spec path');
  const spec = await readJsonStrict(specPath, 'job runner specification');
  const startedAt = new Date().toISOString();
  const stdoutHandle = await fsp.open(spec.stdoutPath, 'a', 0o600);
  const stderrHandle = await fsp.open(spec.stderrPath, 'a', 0o600);
  const hashes = { stdout: crypto.createHash('sha256'), stderr: crypto.createHash('sha256') };
  const counts = { stdout: 0, stderr: 0 };
  const syncCounts = { stdout: 0, stderr: 0 };
  const updateStream = async (stream, complete = false) => {
    const handle = stream === 'stdout' ? stdoutHandle : stderrHandle;
    await handle.datasync();
    syncCounts[stream] = counts[stream];
    await atomicWriteJson(spec.streamStatePaths[stream], {
      jobId: spec.jobId,
      stream,
      committedBytes: counts[stream],
      committedSha256: hashes[stream].copy().digest('hex'),
      complete,
      updatedAt: new Date().toISOString(),
    });
  };

  let child;
  let cancellation = null;
  let timedOut = false;
  let timeoutHandle;
  let finalized = false;
  let stdoutPump = Promise.resolve(null);
  let stderrPump = Promise.resolve(null);

  const writeRunnerState = async (extra = {}) => {
    await atomicWriteJson(spec.runnerStatePath, {
      jobId: spec.jobId,
      runnerPid: process.pid,
      runnerStartTime: await readProcStartTime(process.pid).catch(() => null),
      bootId: await readBootId().catch(() => null),
      childPid: child?.pid ?? null,
      childStartTime: child?.pid ? await readProcStartTime(child.pid).catch(() => null) : null,
      processGroup: child?.pid ?? null,
      startedAt,
      ...extra,
    });
  };

  const forwardSignal = (signal) => {
    if (finalized) return;
    cancellation = signal;
    if (child?.pid) {
      try { process.kill(-child.pid, signal); }
      catch { try { child.kill(signal); } catch {} }
    }
  };
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));
  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGHUP', () => forwardSignal('SIGHUP'));

  const pump = async (stream, readable, handle) => {
    for await (const chunk of readable) {
      const failAfter = spec.faultInjection?.streamWriteFailAfterBytes;
      if (Number.isSafeInteger(failAfter) && failAfter >= 0 && counts[stream] + chunk.length > failAfter) {
        const error = new Error(`Injected ${stream} stream write failure after ${failAfter} bytes`);
        error.code = 'EIO';
        throw error;
      }
      hashes[stream].update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
        offset += bytesWritten;
      }
      counts[stream] += chunk.length;
      if (counts[stream] - syncCounts[stream] >= 1024 * 1024) await updateStream(stream, false);
    }
    await updateStream(stream, true);
  };

  try {
    if (Number.isInteger(spec.umask)) process.umask(spec.umask);
    child = spawn(spec.launchArgv[0], spec.launchArgv.slice(1), {
      cwd: spec.cwd,
      env: spec.environment,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Register terminal observation immediately. A fast process can close between
    // the spawn event and later setup; a Promise added afterward would never
    // resolve and Node could exit with no durable runner result.
    const closePromise = new Promise((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    // Attach stream consumers before waiting for the spawn event. Linux can run
    // and close a tiny process before later setup; unread pipe bytes are then
    // discarded when Node destroys the closed child streams.
    stdoutPump = pump('stdout', child.stdout, stdoutHandle).then(() => null, (error) => error);
    stderrPump = pump('stderr', child.stderr, stderrHandle).then(() => null, (error) => error);
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    await writeRunnerState({ state: 'running' });

    if (spec.stdin?.data) child.stdin.end(Buffer.from(spec.stdin.data, spec.stdin.encoding ?? 'base64'));
    else child.stdin.end();

    if (Number.isSafeInteger(spec.timeoutMs) && spec.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        forwardSignal('SIGTERM');
        setTimeout(() => {
          if (!finalized && child?.pid) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch {}
          }
        }, Math.min(5000, Math.max(500, Math.floor(spec.timeoutMs / 10)))).unref();
      }, spec.timeoutMs);
      timeoutHandle.unref();
    }

    const exit = await closePromise;
    const [stdoutError, stderrError] = await Promise.all([stdoutPump, stderrPump]);
    if (stdoutError) throw stdoutError;
    if (stderrError) throw stderrError;
    finalized = true;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const terminalAt = new Date().toISOString();
    const state = timedOut ? 'failed' : cancellation ? 'cancelled' : exit.code === 0 ? 'completed' : 'failed';
    const error = timedOut
      ? { code: 'timeout', retryable: true, message: 'Explicit job timeout expired' }
      : cancellation
        ? { code: 'cancelled', retryable: false, message: `Job cancelled by ${cancellation}` }
        : exit.code === 0
          ? null
          : { code: 'operation_failed', retryable: false, message: `Process exited with code ${exit.code}${exit.signal ? ` signal ${exit.signal}` : ''}` };
    await atomicWriteJson(spec.runnerResultPath, {
      jobId: spec.jobId,
      requestId: spec.requestId,
      state,
      exitCode: exit.code,
      signal: exit.signal,
      error,
      startedAt,
      terminalAt,
      stdout: { bytes: counts.stdout, sha256: hashes.stdout.copy().digest('hex') },
      stderr: { bytes: counts.stderr, sha256: hashes.stderr.copy().digest('hex') },
      cancellation,
      timedOut,
    });
    await writeRunnerState({ state, terminalAt, exitCode: exit.code, signal: exit.signal });
    process.exitCode = state === 'completed' ? 0 : state === 'cancelled' ? 130 : 1;
  } catch (error) {
    finalized = true;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    // Consume any stream-pump terminal errors before publishing the primary
    // failure so no unhandled rejection can preempt the durable result write.
    await Promise.all([stdoutPump, stderrPump]);
    const normalized = normalizeError(error);
    await updateStream('stdout', true).catch(() => {});
    await updateStream('stderr', true).catch(() => {});
    await atomicWriteJson(spec.runnerResultPath, {
      jobId: spec.jobId,
      requestId: spec.requestId,
      state: 'failed',
      exitCode: null,
      signal: null,
      error: {
        code: normalized.code,
        retryable: normalized.retryable,
        message: normalized.message,
        ...(normalized.details === undefined ? {} : { details: normalized.details }),
      },
      startedAt,
      terminalAt: new Date().toISOString(),
      stdout: { bytes: counts.stdout, sha256: hashes.stdout.copy().digest('hex') },
      stderr: { bytes: counts.stderr, sha256: hashes.stderr.copy().digest('hex') },
    }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await stdoutHandle.close().catch(() => {});
    await stderrHandle.close().catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`se-z job runner fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

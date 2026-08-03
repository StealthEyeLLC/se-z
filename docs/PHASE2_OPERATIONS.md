# Phase 2 Active Operations

The authoritative machine-readable definitions are `contracts/operations-0.1a.json` and `src/kernel/definitions.mjs`. `sez.describe` publishes those complete active definitions and their deterministic `catalogDigest`.

## Active families

Core: `sez.describe`, `sez.health`, `sez.version`, `sez.doctor`, `sez.request.resume`.

Execution and jobs: `sez.exec`, `sez.shell`, `sez.job.get`, `sez.job.list`, `sez.job.wait`, `sez.job.cancel`, `sez.job.stream.read`.

Files: `sez.file.stat`, `sez.file.read`, `sez.file.write`, `sez.file.replace`, `sez.file.patch`, `sez.file.copy`, `sez.file.move`, `sez.file.remove`, `sez.file.list`, `sez.file.mkdir`, `sez.file.chmod`, `sez.file.chown`, `sez.file.link`, `sez.file.symlink`, `sez.file.truncate`.

PTYs: `sez.pty.create`, `sez.pty.input`, `sez.pty.resize`, `sez.pty.read`, `sez.pty.close`.

Artifacts: `sez.artifact.create`, `sez.artifact.begin`, `sez.artifact.upload`, `sez.artifact.finalize`, `sez.artifact.abort`, `sez.artifact.download`, `sez.artifact.get`, `sez.artifact.list`, `sez.artifact.remove`.

## Interpretation contract

Every definition binds name, operation version, description, input/output schemas, mutation classification, durable-job behavior, target support, defaults, idempotency, peer authority, stream behavior, typed errors and implementation status. The catalog digest covers complete definitions rather than operation names.

Only `host` is supported in 0.1A. Explicit `nspawn:<id>` and `kvm:<id>` requests return `target_not_supported` and never fall back to host. The default lane is `fast`; the default execution identity is root:root in `/root`, with no timeout unless requested.

## Inactive families

`sez.github.*`, `sez.machine.*`, `sez.skill.*`, `sez.release.*`, `sez.recovery.*`, `sez.backup.*`, `sez.evidence.*` and `sez.selfhost.*` are absent from the active registry. Extracted historical mechanics do not imply installed support.

# Build Plan

## Phase -1 — Hardware admission

Prove `/dev/kvm`, real KVM acceleration, QMP, nspawn, cgroups v2, systemd scopes, storage headroom, filesystem behavior, pidfds, namespaces, and required host packages. Missing KVM means changing VPS capability; no TCG fallback.

## Phase 0 — Canonical initialization

Freeze identity, precedence, one-tool schema, SEZ1, OAuth/resource contract, executable requirements, threat model, state ownership, recovery, and acceptance.

## Phase 1 — Extraction and parity

Copy proven Baby mechanics with provenance/license notices, mechanically rename, add parity tests, and only then refactor. Preserve the deployed Baby path as rollback.

## Phase 0.1A — Kernel

Implement supervisor, dual sockets, local CLI, SEZ1, authority generation, raw exec/shell, jobs, durable streams, files, PTYs, artifacts, receipts, replay/idempotency, wait/resume, and restart reconciliation.

## Phase 0.1B — Gateway and control

Implement GitHub OAuth, protected-resource metadata, `WWW-Authenticate`, exact resource propagation, `sez.root` plus refresh lifecycle support, isolated `/var/lib/se-z-gateway` slots, one-tool MCP gateway, Secure MCP Tunnel, generic GitHub App operations, and blue/green release control.

## Phase 0.1C — Machines and skills

Implement nspawn, bundle exact `z`, pass real KVM lifecycle, implement explicit targets, immutable skills, separately versioned recovery, backup/restore, temporary app testing, permanent app recreation, and Baby decommission.

## Standalone gate

The combined system must pass `docs/ACCEPTANCE.md` before a standalone claim.

## Phase 1 extracted-source toolchain

The exact deployed supervisor and gateway manifests and both pinned package engines require Node.js `24.18.0`. Phase 1 therefore pins the target development/build engine to exactly `24.18.0`; this is not a stylistic upgrade from the original `>=22` scaffold range. TypeScript, `tsx`, `node-gyp`, `node-addon-api`, and the Linux C/C++ toolchain are retained solely because the proven supervisor source and native `SO_PEERCRED` addon require them. Gateway source remains ES modules with no package runtime dependency.

Install deterministic development dependencies even on production-configured hosts with:

```bash
npm ci --include=dev
```

A host-level `NODE_ENV=production` must not silently omit the Phase 1 compiler or test runner. Runtime packaging later separates build dependencies from the installed product.

# Phase 2 Kernel — Release Milestone 0.1A

Phase 2 implements the standalone local se-z kernel. It is a candidate milestone, not production activation and not the complete standalone product.

## Executable path

```text
se-z CLI
  -> /run/se-z/local.sock
  -> SO_PEERCRED authorization
  -> SEZ1 request and current authorityGeneration
  -> UID-0 se-z supervisor
  -> active 0.1A operation definition
  -> host execution or state operation
  -> durable request, job, streams, PTY, artifact and receipt
  -> deterministic wait or resume
```

The future gateway boundary is physically separate at `/run/se-z/gateway.sock`. It requires the configured gateway UID/GID and executable identity, a recognized gateway and key ID, and an exact Ed25519 signature over the canonical request digest.

## Protocol and authority

SEZ1 uses a four-byte unsigned big-endian payload length followed by canonical UTF-8 JSON. The maximum frame is 16 MiB. The connection welcome is informational and does not grant authority. Every accepted request carries `authorityGeneration`; the generation is included in the request digest and is checked before durable reservation or mutation. The supervisor reads recovery-owned generation state but cannot advance it and does not claim physical writer fencing.

## State and durability

Correctness-bearing JSON records use temporary creation, file flush, atomic rename, and parent-directory flush. Jobs run through durable systemd transient units when systemd is available. Each job stores process start time, boot ID, process group, cgroup, command digest and launch sequence rather than trusting a naked PID. Restart reconciliation reads durable runner state and operating-system truth and reports `lost` or `ambiguous` when completion cannot be proven.

Stdout and stderr are separate binary-safe files with committed offsets and SHA-256 state. The 16 MiB frame maximum does not impose a total output limit. PTYs use a persistent forkpty broker and durable output backing. Artifacts use exact offsets, duplicate-chunk verification, declared size and digest, and atomic immutable finalization.

## Security boundary without policy theater

The kernel does not add command, executable, path, mount, network or package allowlists. It has no approval layer, forced sandbox, rehearsal or automatic redaction of owner-requested bytes. Security controls are limited to protocol integrity, peer identity, current authority, replay/idempotency, state correctness and artifact-store integrity.

## Explicit non-claims

Milestone 0.1A does not activate OAuth, Secure MCP Tunnel, `call_sez`, public ingress, generic GitHub operations, nspawn/KVM lifecycle, skills, release cutover, independent recovery, physical fencing, backup/restore or Baby decommission. Testing inside systemd-nspawn is acceptance infrastructure only.

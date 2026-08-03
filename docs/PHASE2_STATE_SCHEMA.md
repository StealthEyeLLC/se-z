# Phase 2 State Schema

State schema version: `0.1A.1`. The machine-readable contract is `contracts/state-schema-0.1a.json`.

## Ownership

The supervisor owns `/var/lib/se-z/requests`, `idempotency`, `replay`, `jobs`, `streams`, `ptys`, `artifacts`, `receipts`, `catalog`, `reconciliation` and `locks`. Runtime sockets are under `/run/se-z`; public configuration and verification keys are under `/etc/se-z`.

Authority generation is recovery-owned under `/var/lib/se-z-recovery/authority-generation.json`. The supervisor may read and compare it but may not create over existing state, increment, decrement or claim that a generation change proves physical fencing.

The supervisor does not own OAuth clients/tokens/revocations, gateway OAuth replay, KVM state or recovery release state.

## Correctness writes

JSON state that controls request identity, idempotency, replay, jobs, artifacts, PTYs, receipts or reconciliation is serialized strictly and written through a same-directory temporary file, file sync, atomic rename and parent-directory sync. Corruption is returned as typed `state_corrupt`, `lost`, `ambiguous` or `repair_required`; it is never rewritten as success.

## Request and job identity

Requests persist request digest, semantic digest, authority generation, catalog digest, durable sequence, accepted time, state, job binding and terminal response. Idempotency binds subject, operation, canonical payload, explicit target, authority generation and key. Nonce replay is a distinct durable record.

Jobs persist request ID, launch sequence, command digest, systemd unit, runner and child process identity, start time, boot ID, process group, cgroup, exit/signal state and separate stdout/stderr handles. Cancellation and adoption require identity agreement rather than PID alone.

## Streams, PTYs and artifacts

Streams expose stable handles, committed bytes, page/final digests and completion state. Reads are bounded and deterministic at exact offsets.

PTY state binds session, broker and child process identities, exact output offsets, terminal dimensions and persistence boundary. Output already committed remains readable after loss.

Artifact upload state binds declared size/digest and committed offset. Exact duplicate chunks are idempotent; conflicting chunks fail. Finalized artifacts are immutable and downloaded in bounded pages.

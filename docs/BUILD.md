# Build Plan

The product canonicals are established. Build execution uses phases; `0.1A`, `0.1B`, and `0.1C` are release milestones, not phase numbers.

## Phase -1 — Hardware admission

- verify KVM exposure, nested virtualization, nspawn prerequisites, storage, cgroups, and backup capacity;
- fail closed on hardware assumptions.

## Phase 0 — Canonical initialization

- publish product, protocol, public tool, authority, state-owner, and no-theater contracts;
- establish exact source, test, build, and acceptance rules.

## Phase 1 — Extraction and parity

- pin the deployed Baby supervisor and gateway commits, trees, manifests, and source archives;
- preserve notices and file-level provenance;
- mechanically extract proven execution, jobs, streams, files, PTYs, artifacts, receipt, gateway, OAuth, release, skills, and GitHub mechanics;
- measure source and target parity without claiming standalone operation.

## Phase 2 — Kernel — release milestone 0.1A

- final SEZ1 framing, strict envelopes, canonical serialization, request/result digests, and Ed25519 receipts;
- read-only authority-generation provider and pre-dispatch mismatch rejection;
- distinct gateway and local Unix sockets with real peer identity and gateway signatures;
- UID-0 supervisor, native CLI, active 0.1A operation catalog, raw host execution, durable jobs and streams, files, PTYs, artifacts, replay, semantic idempotency, wait, resume, and restart reconciliation;
- immutable candidate packaging, clean systemd-nspawn acceptance, isolated authorized-VPS candidate acceptance, and Baby protected-configuration readback.

Milestone 0.1A does not activate OAuth, a tunnel, public MCP, generic GitHub operations, machine lifecycle, recovery mutation, production release handoff, or permanent cutover.

## Phase 3 — Gateway and control — release milestone 0.1B

- GitHub OAuth with PKCE, exact protected-resource metadata and audience propagation, refresh lifecycle, revocation, and isolated gateway state slots;
- OpenAI Secure MCP Tunnel and exactly one public `call_sez` tool;
- generic GitHub App API/git/reconciliation operations with explicit write proofs;
- blue/green product release control and temporary-app acceptance.

## Phase 4 — Machines and recovery — release milestone 0.1C

- native nspawn lifecycle and reconciliation;
- digest-pinned bundled `z` and real hardware-accelerated KVM lifecycle;
- skills activation;
- separately versioned independent recovery, physical writer fencing, authority-generation mutation, backups, and clean-host restore.

## Phase 5 — Integrated acceptance, cutover, and Baby decommission

- execute the complete integrated gate, including reboots, failed upgrades, rollback, repair, restore, and zero-Baby runtime dependency;
- recreate or republish the permanent ChatGPT app against the accepted `call_sez` catalog;
- cut over only after acceptance, retain the bounded rollback window, then decommission Baby.

## Rule

A phase is complete only when its executable gate passes. Later-phase scope is not represented as implemented by earlier milestones.

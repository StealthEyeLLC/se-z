# Phase 1 Report

## Result

**Status: PASSED.** Phase 1 extraction and parity is complete for tested commit `12cc307f28d85df3095ca5a7ca40a5991bfa03e4` (tree `4a03ef7985fafc3bee4436d03a29435926750534`) on branch `build/standalone-0.1`.

**Standalone claim: No.** No se-z production listener, `call_sez` app, final SEZ1 authority boundary, Secure MCP Tunnel, nspawn lifecycle, KVM lifecycle, or independent recovery product was activated by this phase. Those remain assigned to 0.1A–0.1C and the full standalone acceptance gate.

## Exact migration sources

| Component | Repository | Commit | Tree | Archive SHA-256 |
|---|---|---|---|---|
| Supervisor | `StealthEyeLLC/baby-quirt` | `b3a7119fb9321d74fee9a730517f519ed0d351c4` | `9ebab95f7f136c8480495f812796ac0bdc558a21` | `539dc742bbd832cb5644674da19b19261d2ae373f3929d50331e1cc1e27a22bf` |
| Gateway | `StealthEyeLLC/baby-quirt-mcp` | `0bfcd99757afe198151e96b18771626388914205` | `d0598af304c8cda8df3bb538d703d9db6c7dcb04` | `5867084e488a4f5d2b8ebaf316007661fd2a775527848e4bb09cb8c942ad1308` |

Both exact trees were materialized, their commits, trees, archive digests, tracked-file counts, and per-file source-map digests were verified, and no branch head was substituted for a deployed commit.

## Executed tests

| Evidence group | Commands | Unit | Integration | Acceptance | Gateway | Parity | Skipped |
|---|---:|---:|---:|---:|---:|---:|---:|
| Exact pinned source | 10 | 219 | 5 | 28 | — | — | 0 |
| Extracted target and behavioral parity | 10 | 174 | 5 | 28 | 28 | 60 | — |

The target evidence came from a clean detached worktree at the tested commit. Check, build, native peer-credential compilation, scaffold tests, extracted supervisor tests, gateway tests, static lineage checks, and source-versus-target behavioral parity all passed.

## Capability retention

The signed installed source catalog contains **49 operations**. The Phase 1 map contains **49** entries: 48 core operations and 1 dynamic skill operation. Silent disappearances: **0**.

Phase 1 records whether mechanics were preserved, mechanically renamed, extracted but not integrated, superseded by the canonical target, deferred, or intentionally not carried. It does not mark extracted definitions as production-supported operations.

## Runtime-dependency, credential, and requirement gates

- Active target-runtime Baby dependency findings: **0** across 128 active files.
- Repository credential findings: **0** across 341 files.
- Requirements audited: **35**; all contain enforcement, executable tests, evidence, and a mandatory release gate.
- Canonical differences registered: **20**.

## Production readback

The read-only comparison found **0 configuration mismatches**. Baby services, active/previous release pointers, socket identity and mode, installed manifest digests, and the public endpoint configuration matched the captured baseline. No release or service activation was performed. Routine authorized Baby job, stream, and receipt records created while doing this work are explicitly outside configuration equality and are not represented as unchanged state.

## Evidence

The machine-readable gate is `npm run phase1:verify`. Its inputs are content-addressed in `evidence/phase1/phase1-summary.json`. Raw command logs remain local and uncommitted; committed evidence contains bounded command metadata, counts, exit status, and stdout/stderr digests.

## Boundary after Phase 1

The next build generation is **0.1A**: final SEZ1 request authority generation, dual peer sockets, integrated supervisor registration, durable unbounded aggregate output, deterministic request wait/resume, and the canonical local CLI boundary. Phase 1 completion does not satisfy the product's standalone gate.

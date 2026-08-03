# Phase 1 Capability Parity

## Result

The signed installed source catalog contains **49 operations**: 48 pinned core definitions plus one dynamically loaded proof skill operation. This map contains all 49; no installed operation is omitted. Phase 1 records extraction state, not standalone production support. No target operation in this map is marked production-supported.

Source identity: `StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4` (tree `9ebab95f7f136c8480495f812796ac0bdc558a21`). Installed catalog digest: `444356b24912f157f29057479f0a1eb5ad3bcebdf6f1a451be8e861ecbf66fb1`.

## State meanings

- **MECHANICALLY_RENAMED**: proven mechanics and definition are present under active se-z identity with parity coverage, but are not exposed by a production se-z supervisor in Phase 1.
- **EXTRACTED_NOT_INTEGRATED**: source mechanics are present and testable, while final supervisor/gateway registration or activation remains a later build generation.
- **DEFERRED_TO_0.1C**: source mechanics are traced, but the canonical separately versioned recovery architecture owns final implementation.
- **SUPERSEDED_BY_CANONICAL_TARGET**: source behavior remains traceable, while the canonical final transport or owner contract replaces it.
- **INTENTIONALLY_NOT_CARRIED**: the source behavior is documented and deliberately excluded from active target semantics.

## Installed operation map

| Source operation | Target operation | Family | Phase 1 state | Canonical delta |
|---|---|---|---|---|
| `baby.describe` | `sez.describe` | discovery | MECHANICALLY_RENAMED | `DELTA-PROTOCOL-001`, `DELTA-CATALOG-001` |
| `baby.health` | `sez.health` | health | MECHANICALLY_RENAMED | none |
| `baby.github.app.verify` | `sez.github.app.verify` | github | MECHANICALLY_RENAMED | `DELTA-GITHUB-001` |
| `baby.github.app.proof` | `sez.github.app.proof` | github | MECHANICALLY_RENAMED | `DELTA-GITHUB-001` |
| `baby.exec` | `sez.exec` | execution | MECHANICALLY_RENAMED | `DELTA-OUTPUT-001` |
| `baby.shell` | `sez.shell` | execution | MECHANICALLY_RENAMED | `DELTA-OUTPUT-001` |
| `baby.job.get` | `sez.job.get` | job | MECHANICALLY_RENAMED | `DELTA-OUTPUT-001`, `DELTA-RESUME-001` |
| `baby.job.list` | `sez.job.list` | job | MECHANICALLY_RENAMED | `DELTA-OUTPUT-001`, `DELTA-RESUME-001` |
| `baby.job.wait` | `sez.job.wait` | job | MECHANICALLY_RENAMED | `DELTA-OUTPUT-001`, `DELTA-RESUME-001` |
| `baby.job.cancel` | `sez.job.cancel` | job | MECHANICALLY_RENAMED | `DELTA-OUTPUT-001`, `DELTA-RESUME-001` |
| `baby.job.stream.read` | `sez.job.stream.read` | job | MECHANICALLY_RENAMED | `DELTA-OUTPUT-001`, `DELTA-RESUME-001` |
| `baby.file.stat` | `sez.file.stat` | file | MECHANICALLY_RENAMED | none |
| `baby.file.read` | `sez.file.read` | file | MECHANICALLY_RENAMED | none |
| `baby.file.write` | `sez.file.write` | file | MECHANICALLY_RENAMED | none |
| `baby.file.replace` | `sez.file.replace` | file | MECHANICALLY_RENAMED | none |
| `baby.file.patch` | `sez.file.patch` | file | MECHANICALLY_RENAMED | none |
| `baby.file.copy` | `sez.file.copy` | file | MECHANICALLY_RENAMED | none |
| `baby.file.move` | `sez.file.move` | file | MECHANICALLY_RENAMED | none |
| `baby.file.remove` | `sez.file.remove` | file | MECHANICALLY_RENAMED | none |
| `baby.file.list` | `sez.file.list` | file | MECHANICALLY_RENAMED | none |
| `baby.pty.create` | `sez.pty.create` | pty | MECHANICALLY_RENAMED | `DELTA-RESUME-001` |
| `baby.pty.input` | `sez.pty.input` | pty | MECHANICALLY_RENAMED | `DELTA-RESUME-001` |
| `baby.pty.resize` | `sez.pty.resize` | pty | MECHANICALLY_RENAMED | `DELTA-RESUME-001` |
| `baby.pty.read` | `sez.pty.read` | pty | MECHANICALLY_RENAMED | `DELTA-RESUME-001` |
| `baby.pty.close` | `sez.pty.close` | pty | MECHANICALLY_RENAMED | `DELTA-RESUME-001` |
| `baby.artifact.create` | `sez.artifact.create` | artifact | MECHANICALLY_RENAMED | none |
| `baby.artifact.begin` | `sez.artifact.begin` | artifact | MECHANICALLY_RENAMED | none |
| `baby.artifact.upload` | `sez.artifact.upload` | artifact | MECHANICALLY_RENAMED | none |
| `baby.artifact.finalize` | `sez.artifact.finalize` | artifact | MECHANICALLY_RENAMED | none |
| `baby.artifact.abort` | `sez.artifact.abort` | artifact | MECHANICALLY_RENAMED | none |
| `baby.artifact.download` | `sez.artifact.download` | artifact | MECHANICALLY_RENAMED | none |
| `baby.artifact.list` | `sez.artifact.list` | artifact | MECHANICALLY_RENAMED | none |
| `baby.artifact.get` | `sez.artifact.get` | artifact | MECHANICALLY_RENAMED | none |
| `baby.release.status` | `sez.release.status` | release | EXTRACTED_NOT_INTEGRATED | `DELTA-RECOVERY-001`, `DELTA-RELEASE-IDENTITY-001` |
| `baby.release.build` | `sez.release.build` | release | EXTRACTED_NOT_INTEGRATED | `DELTA-RECOVERY-001`, `DELTA-RELEASE-IDENTITY-001` |
| `baby.release.stage` | `sez.release.stage` | release | EXTRACTED_NOT_INTEGRATED | `DELTA-RECOVERY-001`, `DELTA-RELEASE-IDENTITY-001` |
| `baby.release.verify` | `sez.release.verify` | release | EXTRACTED_NOT_INTEGRATED | `DELTA-RECOVERY-001`, `DELTA-RELEASE-IDENTITY-001` |
| `baby.release.activate` | `sez.release.activate` | release | EXTRACTED_NOT_INTEGRATED | `DELTA-RECOVERY-001`, `DELTA-RELEASE-IDENTITY-001` |
| `baby.release.rollback` | `sez.release.rollback` | release | EXTRACTED_NOT_INTEGRATED | `DELTA-RECOVERY-001`, `DELTA-RELEASE-IDENTITY-001` |
| `baby.release.repair` | `sez.release.repair` | release | EXTRACTED_NOT_INTEGRATED | `DELTA-RECOVERY-001`, `DELTA-RELEASE-IDENTITY-001` |
| `baby.release.prune` | `sez.release.prune` | release | EXTRACTED_NOT_INTEGRATED | `DELTA-RECOVERY-001`, `DELTA-RELEASE-IDENTITY-001` |
| `baby.selfhost.source.get` | `sez.selfhost.source.get` | selfhost | EXTRACTED_NOT_INTEGRATED | `DELTA-RECOVERY-001`, `DELTA-TOOLCHAIN-001` |
| `baby.selfhost.acceptance.run` | `sez.selfhost.acceptance.run` | selfhost | EXTRACTED_NOT_INTEGRATED | `DELTA-RECOVERY-001`, `DELTA-TOOLCHAIN-001` |
| `baby.selfhost.evidence.get` | `sez.selfhost.evidence.get` | selfhost | EXTRACTED_NOT_INTEGRATED | `DELTA-RECOVERY-001`, `DELTA-TOOLCHAIN-001` |
| `baby.skill.deploy` | `sez.skill.deploy` | skill | EXTRACTED_NOT_INTEGRATED | `DELTA-CATALOG-001` |
| `baby.skill.status` | `sez.skill.status` | skill | EXTRACTED_NOT_INTEGRATED | `DELTA-CATALOG-001` |
| `baby.skill.rollback` | `sez.skill.rollback` | skill | EXTRACTED_NOT_INTEGRATED | `DELTA-CATALOG-001` |
| `baby.skill.list` | `sez.skill.list` | skill | EXTRACTED_NOT_INTEGRATED | `DELTA-CATALOG-001` |
| `baby.skill.proof.echo` | `sez.skill.proof.echo` | skill | EXTRACTED_NOT_INTEGRATED | `DELTA-CATALOG-001` |

## Meaningful internal capability map

| Capability | Family | Phase 1 state | Destination | Canonical delta |
|---|---|---|---|---|
| protocol framing | protocol | MECHANICALLY_RENAMED | `src/protocol/framing/frame.ts` | `DELTA-PROTOCOL-001` |
| canonical encoding | canonical encoding | MECHANICALLY_RENAMED | `src/protocol/canonical/canonical.ts` | `DELTA-AUTHORITY-001` |
| peer authorization | peer authorization | EXTRACTED_NOT_INTEGRATED | `src/supervisor/peers/peer-cred.ts` | `DELTA-PEERS-001` |
| native SO_PEERCRED addon | native addon | PRESERVED_DIRECTLY | `src/native/peercred/src/peer_cred.cc` | none |
| request authentication | request authentication | EXTRACTED_NOT_INTEGRATED | `src/supervisor/dispatch/auth/authenticator.ts` | `DELTA-AUTHORITY-001` |
| request signatures and keys | signatures and keys | MECHANICALLY_RENAMED | `src/protocol/signatures/signing.ts` | `DELTA-AUTHORITY-001` |
| signed receipts | receipts | MECHANICALLY_RENAMED | `src/protocol/receipts/` | none |
| nonce replay | replay | MECHANICALLY_RENAMED | `src/state/replay/store.ts` | none |
| semantic idempotency | idempotency | MECHANICALLY_RENAMED | `src/jobs/manager.ts` | none |
| durable state store | state storage | MECHANICALLY_RENAMED | `src/state/store/store.ts` | `DELTA-STATE-OWNERSHIP-001` |
| exact argv and shell execution | raw execution | MECHANICALLY_RENAMED | `src/jobs/manager.ts` | `DELTA-OUTPUT-001` |
| durable jobs | jobs | MECHANICALLY_RENAMED | `src/jobs/manager.ts` | `DELTA-RESUME-001` |
| stdout and stderr streams | streams | MECHANICALLY_RENAMED | `src/jobs/manager.ts` | `DELTA-OUTPUT-001` |
| raw files | files | MECHANICALLY_RENAMED | `src/files/manager.ts` | none |
| PTY sessions | PTY | MECHANICALLY_RENAMED | `src/pty/manager.ts` | `DELTA-RESUME-001` |
| artifacts | artifacts | MECHANICALLY_RENAMED | `src/artifacts/manager.ts` | none |
| operation registry | operation registry | MECHANICALLY_RENAMED | `src/operations/registry.ts` | `DELTA-CATALOG-001` |
| dynamic catalog | catalog | EXTRACTED_NOT_INTEGRATED | `src/operations/registry.ts` | `DELTA-CATALOG-001` |
| immutable skills | skills | EXTRACTED_NOT_INTEGRATED | `src/skills/` | `DELTA-CATALOG-001` |
| release lifecycle | release lifecycle | EXTRACTED_NOT_INTEGRATED | `src/releases/` | `DELTA-RECOVERY-001` |
| self-hosting | self-hosting | EXTRACTED_NOT_INTEGRATED | `src/selfhost/` | `DELTA-RECOVERY-001` |
| recovery source mechanics | recovery source mechanics | DEFERRED_TO_0.1C | `src/releases/ and src/supervisor/cli/repair.ts` | `DELTA-RECOVERY-001` |
| GitHub App authority | GitHub authority | MECHANICALLY_RENAMED | `src/github/app-authority.ts` | `DELTA-GITHUB-001` |
| MCP one-tool gateway | MCP gateway | EXTRACTED_NOT_INTEGRATED | `src/gateway/mcp/` | `DELTA-TOOL-001`, `DELTA-TRANSPORT-001` |
| OAuth and token lifecycle | OAuth | EXTRACTED_NOT_INTEGRATED | `src/auth/oauth/` | `DELTA-SCOPE-001`, `DELTA-REFRESH-001`, `DELTA-OAUTH-STATE-001` |
| configuration | configuration | EXTRACTED_NOT_INTEGRATED | `src/supervisor/configuration/ and src/gateway/configuration/` | `DELTA-PEERS-001` |
| CLI mechanics | CLI | EXTRACTED_NOT_INTEGRATED | `src/supervisor/cli/ and src/gateway/cli/` | none |
| packaging | packaging | EXTRACTED_NOT_INTEGRATED | `scripts/extracted/ and packaging/` | `DELTA-RELEASE-IDENTITY-001` |
| systemd assets | systemd | EXTRACTED_NOT_INTEGRATED | `packaging/systemd/` | `DELTA-PEERS-001` |
| Caddy assets | Caddy | SUPERSEDED_BY_CANONICAL_TARGET | `packaging/caddy/` | `DELTA-TRANSPORT-001` |
| source broad secret redaction | raw output policy | INTENTIONALLY_NOT_CARRIED | `historical source tests and docs/PHASE1_CANONICAL_DELTA.md` | `DELTA-SECRET-001` |
| nspawn rehearsal and deployment mechanics | nspawn | DEFERRED_TO_0.1C | `src/releases/rehearsal/ and isolated release fixtures` | `DELTA-NSPAWN-001` |
| KVM lifecycle | KVM | DEFERRED_TO_0.1C | `future bundled z integration` | `DELTA-KVM-001` |

## Retention conclusion

Raw execution, durable jobs, streams, files, PTYs, and artifacts are mechanically retained and tested. Release, self-hosting, skills, GitHub App, gateway, and OAuth mechanics are traced and testable without activation. The map explicitly assigns nonmechanical work to the canonical-delta register; it does not turn the extracted operation definitions into a running catalog or a standalone claim.

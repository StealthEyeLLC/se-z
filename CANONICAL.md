# se-z Canonical Product Record

## 1. Identity

- Repository: `StealthEyeLLC/se-z`
- Product: `se-z`
- Local command: `se-z`
- Public MCP tool: `call_sez`
- Operation namespace: `sez.*`
- Protocol: `SEZ1`
- Owner subject: `stealtheye-owner`
- Authoritative GitHub identity: numeric user ID `247854506`
- Authority class: `unrestricted-owner`
- Authority scope: `sez.root`
- Refresh lifecycle capability: `offline_access`
- Primary MCP transport: OpenAI Secure MCP Tunnel
- Browser authentication: GitHub OAuth with PKCE `S256`

## 2. Precedence

Conflicts are resolved in this order:

1. This file.
2. `docs/ENGINEERING_SPEC.md`.
3. `protocol/SEZ1.md`.
4. `contracts/requirements.yaml`.
5. `docs/BUILD.md`.
6. Other repository documentation.
7. Migration evidence and historical records.

Historical evidence records what happened; it never silently changes the product contract.

## 3. Product decision

se-z is an owner-only, standalone, unrestricted UID-0 control system for the authorized VPS. The ChatGPT app is the primary remote operator. The native CLI is the offline/local operator. Both reach the same supervisor and operation catalog.

The permanent defaults are:

```text
lane   = fast
target = host
user   = root
group  = root
cwd    = /root
```

No se-z command allowlist, path allowlist, policy engine, approval layer, forced sandbox, forced rehearsal, artificial owner quota, or mandatory evidence package is permitted in the normal path. An explicitly selected `nspawn:<id>` or `kvm:<id>` target is never substituted for another target.

## 4. Public contract

The public MCP catalog contains exactly one tool, `call_sez`, whose schema is permanently limited to:

- `operation`
- `payload`
- `idempotencyKey`

The operation field is a string matching `sez.*`; it is never frozen into a public enum. Runtime expansion occurs through the signed catalog returned by `sez.describe`.

`catalogDigest` is present in every SEZ1 response. Caller-side catalog caching is guidance, not a server guarantee.

## 5. SEZ1 authority

Every gateway-signed SEZ1 request contains `authorityGeneration`. The canonical request digest binds that exact field. A stale authority generation is rejected before mutation.

The production supervisor has two peer classes and two Unix sockets:

- `/run/se-z/gateway.sock`: the unprivileged gateway peer; every request must carry a valid gateway signature and current authority generation.
- `/run/se-z/local.sock`: UID 0 or genuine local members of the `se-z` group; authority is established by `SO_PEERCRED` and the request still carries the current authority generation.

The gateway cannot use the local-operator socket. Local operators do not impersonate the gateway.

## 6. OAuth and protected resource

The tunnel-backed MCP resource publishes RFC 9728 protected-resource metadata at:

```text
/.well-known/oauth-protected-resource
```

Unauthenticated or invalid MCP requests return `401` with a `WWW-Authenticate` Bearer challenge containing the exact `resource_metadata` URL and the advertised scopes.

The exact protected-resource URI is propagated as the OAuth `resource` parameter through both authorization and token requests. Access tokens are rejected unless their audience matches that exact resource.

`sez.root` is the only authority-bearing scope. `offline_access` is advertised only to request refresh-token lifecycle support; it grants no additional operation authority.

## 7. Gateway state

Gateway-owned state is rooted at `/var/lib/se-z-gateway/` and includes:

- registered OAuth clients;
- authorization codes and transient authorization state;
- hashed refresh-token families;
- revocations;
- OAuth replay state;
- gateway release/slot metadata needed to interpret that state.

Blue and green candidate state are isolated. Active gateway state is backed up and restored with the rest of se-z.

## 8. Output and frame contract

SEZ1 frames are bounded to 16 MiB. Unrestricted command output is not bounded by that frame size.

All stdout and stderr are captured in durable streams. Responses contain bounded inline excerpts plus stream handles, byte offsets, total size when known, and SHA-256 digests. Complete output is retrievable with deterministic stream-read operations.

## 9. State ownership

- Gateway: OAuth/DCR/token/revocation/replay state and gateway request-signing material.
- Supervisor: jobs, streams, PTYs, artifacts, receipts, idempotency, supervisor replay state, skills, releases, nspawn state, and operation catalog.
- `z`: KVM manifests, disks, guest keys, QEMU/QMP identity, snapshots, and KVM lifecycle.
- Recovery: active/previous release pointers, authority generation, fencing state, rollback guard, and recovery release state.

No component creates a competing source of truth.

## 10. Targets

Canonical execution targets are:

```text
host
nspawn:<id>
kvm:<id>
```

The host is permanent and cannot be created, deleted, cloned, snapshotted, or restored. Machine lifecycle operations apply only to nspawn and KVM targets.

## 11. Physical fencing

Authority generation is necessary but not sufficient. Before generation advancement, recovery must stop the old supervisor, resolve or adopt its mutating job scopes, terminate non-adopted descendants, verify the old cgroup is empty, verify no old writer remains, and only then hand the production sockets and new generation to the candidate.

## 12. Recovery

Recovery is a separately versioned product with blue/green slots and a distinct upgrade transaction. Ordinary product releases cannot modify, disable, or share fate with their rollback authority.

## 13. KVM

Every release bundles an exact digest-pinned `z`. External installation is not required. KVM is not claimed until real create/start/exec/reboot/stop/start/snapshot/restore/delete tests pass with hardware acceleration on the actual VPS. TCG fallback is forbidden.

## 14. Migration source

Baby Quirt is the proven migration source and temporary rollback path. Its mechanics may be copied with provenance and license notices, mechanically renamed, parity-tested, and then refactored. Standalone means eliminating runtime dependencies, not erasing legitimate historical references.

## 15. No-theater rule

Every control, artifact, attestation, validation, or service must map to a named threat, failure mode, acceptance test, or recovery requirement. Anything without enforcement effect, test evidence, or recovery value is removed.

## 16. Standalone claim

se-z is called standalone only after the complete acceptance gate passes, including reboot, upgrade, failed-upgrade rollback, independent recovery, clean-host restore, native nspawn, real KVM, GitHub writes, tunnel/OAuth, and zero-Baby runtime dependency.

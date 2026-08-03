# se-z Standalone Engineering Specification

**Status:** canonical 10/10 target design, initialized for implementation  
**Repository:** `StealthEyeLLC/se-z`  
**Date:** 2026-08-03

## 1. Executive contract

se-z is an owner-only, standalone, unrestricted UID-0 control system for one authorized VPS, operated primarily by the ChatGPT app and secondarily by a native local CLI. Fast lane is the permanent default. The system does not add a command allowlist, policy engine, internal approval workflow, forced sandbox, forced rehearsal, artificial owner quota, mandatory evidence package, or automatic secret redaction to ordinary root work.

The deployed Baby-backed system is the migration source and rollback path. The final product has independent se-z keys, services, sockets, state, releases, recovery, protocol, operation namespace, app schema, and GitHub/OAuth identity. Historical provenance remains truthful.

## 2. Identity

```text
Repository:            StealthEyeLLC/se-z
Product:               se-z
Command:               se-z
Public MCP tool:       call_sez
Operation namespace:   sez.*
Protocol:              SEZ1/1.0.0
Owner subject:         stealtheye-owner
Owner GitHub user ID:  247854506
Authority class:       unrestricted-owner
Authority scope:       sez.root
Refresh capability:   offline_access
Primary transport:     OpenAI Secure MCP Tunnel
OAuth issuer:          https://auth.se-z.stealtheye.io
```

## 3. Default execution

When fields are absent:

```text
lane   = fast
target = host
user   = root
group  = root
cwd    = /root
timeout = none
```

Fast lane performs the requested operation directly. Multi-stage operations such as release activation, key rotation, backup restore, nspawn lifecycle, and KVM lifecycle remain internally transactional because their functionality requires durable state transitions; they do not require a second human confirmation inside se-z.

## 4. Architecture

```text
ChatGPT app
  -> one tool: call_sez
  -> OpenAI Secure MCP Tunnel
  -> private loopback se-z gateway
  -> /run/se-z/gateway.sock
  -> signed SEZ1 request + gateway SO_PEERCRED
  -> se-z supervisor as UID 0
       -> host
       -> nspawn:<id>
       -> kvm:<id> through bundled z

Local operator
  -> native se-z CLI
  -> /run/se-z/local.sock
  -> SO_PEERCRED owner authorization
  -> same supervisor and catalog

Independent recovery
  -> physical writer fencing
  -> authority generation
  -> active/previous product slots
  -> rollback and repair
```

Public MCP ingress is disabled. Only the browser-facing GitHub OAuth authorization surface is public when required by ChatGPT authentication.

## 5. Public MCP contract

The MCP catalog permanently exposes exactly one tool:

```text
call_sez(operation, payload, idempotencyKey)
```

The schema never enumerates `sez.*` operations. `sez.describe` publishes the current installed catalog, operation schemas, limits, release identity, target support, skill-set identity, and deterministic `catalogDigest`.

Every operation response includes the `catalogDigest` used to interpret the request. ChatGPT may cache a catalog by digest, but caching is caller guidance rather than a server guarantee.

## 6. OAuth and ChatGPT authentication

### 6.1 Resource server metadata

The tunnel-backed MCP resource serves:

```text
/.well-known/oauth-protected-resource
```

The document returns at least:

```json
{
  "resource": "<exact tunnel-backed protected-resource URI>",
  "authorization_servers": ["https://auth.se-z.stealtheye.io"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["sez.root", "offline_access"]
}
```

The `resource` value must exactly match the protected-resource URI configured for the ChatGPT app and tunnel.

### 6.2 Challenge

A missing or invalid bearer token on `/mcp` returns:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="<exact-resource-origin>/.well-known/oauth-protected-resource", scope="sez.root offline_access"
```

Insufficient authority returns `403` with an appropriate Bearer challenge. There is no anonymous MCP mode.

### 6.3 Exact resource propagation

The OAuth `resource` parameter is propagated unchanged through:

- authorization requests;
- token exchange requests;
- refresh requests where supported;
- access-token audience binding;
- protected-resource metadata;
- `WWW-Authenticate` discovery.

The gateway rejects tokens whose audience does not exactly name the configured resource.

### 6.4 GitHub owner binding

The authorization code flow uses PKCE `S256` and GitHub login. Authority is granted only when GitHub’s numeric user ID equals `247854506`. Login text is a hint, not authority.

### 6.5 Scopes and refresh

`sez.root` is the only scope that grants operation authority. `offline_access` or an equivalent advertised lifecycle capability is requested when refresh tokens are issued so ChatGPT can maintain access without unnecessary reauthentication. Refresh tokens are rotating, single-use families with hashed durable state and replay rejection.

### 6.6 Gateway state

Gateway state is rooted at:

```text
/var/lib/se-z-gateway/
  slots/blue/
  slots/green/
  active -> slots/<slot>
```

Each slot owns isolated:

- dynamic client registrations;
- authorization state;
- authorization codes;
- hashed refresh-token families;
- revocations;
- replay state;
- slot metadata.

Candidate gateways never share writable OAuth state with the active gateway. Active/previous gateway state is included in backup and clean-host restore.

## 7. SEZ1 peer classes and sockets

### 7.1 Gateway peer

```text
/run/se-z/gateway.sock
root:se-z-gateway 0660
```

The unprivileged gateway uses this socket. The supervisor requires both the expected gateway Unix peer credentials and a valid gateway-signed envelope. The gateway cannot use the local operator socket.

### 7.2 Local peer

```text
/run/se-z/local.sock
root:se-z 0660
```

UID 0 and genuine local members of the `se-z` group use this socket. The supervisor authorizes them through `SO_PEERCRED`; no copied OAuth or gateway bearer credential is required. Local requests still use SEZ1 request IDs, idempotency, replay rules, and the current `authorityGeneration`.

## 8. SEZ1 request identity

Every request includes:

```text
protocol
protocolVersion
requestId
operation
payload
idempotencyKey
subject
authorityClass
authorityGeneration
issuedAt
nonce
peerClass
gateway identity and signature when applicable
```

The canonical request digest binds `authorityGeneration`. Stale generations are rejected. Recovery advances the generation only after physical fencing.

## 9. Physical fencing

Before production handoff, recovery:

1. blocks new shared mutations;
2. stops the old gateway’s mutation intake;
3. enumerates old mutating job scopes;
4. completes, cancels, terminates, or explicitly adopts each scope;
5. stops the old supervisor;
6. terminates non-adopted descendants;
7. verifies the old cgroup is empty;
8. verifies no old writer or state lock remains;
9. advances the authority generation;
10. hands the preserved production sockets to the new supervisor;
11. verifies the new generation and root health;
12. reopens mutations.

An integer counter without old-process termination is not accepted as fencing.

## 10. Frames, streams, and unrestricted output

SEZ1 frames are limited to 16 MiB. Execution output is not.

All stdout and stderr are captured into durable binary-safe streams. A normal response returns:

- bounded inline content;
- encoding;
- stable stream handle;
- starting and next offsets;
- total size when known;
- digest;
- completion flag.

`sez.job.stream.read` retrieves the complete stream in bounded pages. Large output therefore remains fully available without violating frame limits.

## 11. Deterministic wait and resume

The server provides:

```text
sez.job.get
sez.job.wait
sez.job.stream.read
sez.request.resume
```

`sez.job.wait` accepts a bounded wait duration and stream offsets. `sez.request.resume` recovers the exact durable request after response loss using request ID or exact idempotency identity. The server never relies on an assumption that ChatGPT automatically waits or remembers state.

Caller guidance may tell ChatGPT to call these operations automatically so Jamie experiences one coherent interaction.

## 12. Result contract

Every result includes:

```text
requestId
operation
state
terminal
authorityGeneration
catalogDigest
result or typed error
jobId when applicable
stdout/stderr descriptors
resultDigest
signed receipt
```

Valid states are:

```text
accepted
running
completed
failed
cancelled
lost
ambiguous
reconciled
```

Accepted or running never means completed.

## 13. Raw capability

The permanent raw operations include:

```text
sez.exec
sez.shell
sez.file.*
sez.pty.*
sez.job.*
```

They do not impose command, path, package, network, or capability allowlists. Explicit owner-authorized root reads and output may contain sensitive data. se-z never automatically injects managed credentials into commands or copies raw sensitive streams into searchable evidence.

## 14. Operation catalog

### Core

```text
sez.describe
sez.health
sez.version
sez.doctor
sez.request.resume
```

### Execution and jobs

```text
sez.exec
sez.shell
sez.job.get
sez.job.list
sez.job.wait
sez.job.cancel
sez.job.stream.read
```

### Files and PTYs

```text
sez.file.stat/read/write/replace/patch/copy/move/remove/list/mkdir/chmod/chown/link/symlink/truncate
sez.pty.create/input/resize/read/close
```

### Artifacts

```text
sez.artifact.create/begin/upload/finalize/abort/download/get/list/remove
```

### GitHub

```text
sez.github.app.verify
sez.github.api
sez.github.git
sez.github.reconcile
sez.github.proof
```

GitHub App installation tokens are minted immediately before one operation, kept in memory, and discarded. Every write family receives an independent proof; read verification is never treated as proof of all writes.

### Machines

```text
sez.machine.create/start/stop/reboot/status/inspect/list/delete/snapshot/restore/clone/resize/forward
sez.machine.console.read
sez.machine.image.list/fetch/prune
```

Execution into machines still uses the raw exec/shell/PTY families with an explicit target.

### Skills, release, recovery, backup, evidence

```text
sez.skill.deploy/status/list/rollback/remove
sez.release.status/build/stage/verify/activate/rollback/repair/prune
sez.recovery.status/lockdown/upgrade/rollback/repair
sez.backup.create/list/verify/restore/prune
sez.evidence.capture/get/export
sez.selfhost.source.get/acceptance.run/evidence.get
```

## 15. State ownership

- Gateway owns OAuth, registration, refresh, revocation, and gateway replay state only.
- Supervisor owns jobs, streams, PTYs, artifacts, receipts, operation idempotency/replay, skills, releases, nspawn, and catalog state.
- `z` alone owns KVM manifests, disks, keys, QEMU/QMP identity, snapshots, and lifecycle.
- Recovery owns active/previous product and recovery slots, authority generation, fencing, rollback guard, and repair state.

No second lifecycle database is introduced.

## 16. Target model

```text
host
nspawn:<id>
kvm:<id>
```

Host is the permanent VPS and the default. It is not creatable, deletable, clonable, or snapshot-capable through machine lifecycle operations.

nspawn provides persistent or disposable full-system environments sharing the host kernel. KVM provides persistent separate-kernel machines through the exact bundled `z` backend. No failed target silently falls back to another target or to TCG.

## 17. KVM and bundled z

Each immutable se-z release contains an exact `libexec/z`. Its source repository, commit, tree, executable digest, CLI version, state schema, and compatibility digest are part of release identity.

KVM remains unclaimed until the actual VPS passes create, start, strict root execution, persistence, reboot, stop/start, snapshot/restore, delete, stale PID, failed start, disk pressure, concurrency, and host-reboot reconciliation with real KVM acceleration.

## 18. Blue/green product deployment

Complete candidate supervisor, sockets, gateway, tunnel, catalog, bundled z, and skills start beside the active stack. Candidate OAuth state, jobs, artifacts, nspawn IDs, KVM IDs, and GitHub proof resources are isolated.

Caddy/tunnel routing switches only after candidate acceptance. Production handoff uses physical fencing and authority-generation change. A single activation call performs the transaction; se-z does not ask Jamie for an internal second approval.

## 19. Independent recovery

Recovery is separately versioned with blue/green slots and a distinct upgrade transaction. Ordinary releases cannot replace recovery code, state schemas, keys, or units. Recovery can restore the previous product release when `/opt/se-z/current` is defective.

Raw host root can always modify anything; recovery independence is an operational availability property, not a security boundary against UID 0.

## 20. Backup and restore

Backup includes:

- `/etc/se-z`;
- `/etc/se-z-gateway`;
- `/var/lib/se-z`;
- `/var/lib/se-z-gateway` active and previous state;
- `/var/lib/se-z-recovery`;
- release and verification-key history;
- selected artifacts, nspawn state, and KVM disks.

Standalone status requires restoring into a clean Ubuntu 24.04 host-shaped environment and passing root, OAuth/tunnel, GitHub, nspawn, KVM, release rollback, and recovery acceptance.

## 21. Threat boundary

The threat model explicitly covers compromised ChatGPT identity, GitHub OAuth token, tunnel credential, gateway, gateway signing key, GitHub source, build input, builder, guest, supervisor, and host root.

Once host root is compromised, local guarantees end. Locally signed receipts remain operational records but are not independent proof against the compromised host. Independent build/sign/verify/backup authorities are identified when independent assurance is claimed.

## 22. Supply-chain claims

Provenance signed by the same host that built and stores the artifact is useful lineage, not independent assurance. Releases distinguish source, builder, signer, verifier, and off-host append-only backup authority. No SLSA level or similar label is claimed without meeting and verifying its actual trust requirements.

## 23. Build generations

### 0.1A — Kernel

SEZ1, supervisor, dual sockets, CLI, raw execution, jobs, durable streams, files, PTYs, artifacts, receipts, replay/idempotency, restart reconciliation.

### 0.1B — Gateway and control

GitHub OAuth, RFC 9728 protected-resource metadata, exact resource propagation, refresh lifecycle, `/var/lib/se-z-gateway`, one-tool MCP gateway, Secure MCP Tunnel, GitHub App operations, blue/green product release.

### 0.1C — Machines and skills

nspawn, bundled `z`, real KVM acceptance, target routing, skills, independent recovery, backup/restore, app migration, zero-Baby cutover.

The combined result is called standalone only after the full acceptance gate passes.

## 24. Executable requirements

Every invariant and anti-invariant has a stable ID, enforcement point, acceptance test, and required evidence artifact in `contracts/requirements.yaml`. Prose without enforcement or evidence is not counted as an implemented guarantee.

## 25. Final operating experience

Jamie gives a direct request. ChatGPT calls `call_sez`. Missing fields select fast lane, host, and root. se-z executes, returns bounded inline output and durable stream handles, and ChatGPT deterministically waits or resumes when necessary. There is no se-z preview, recipe, forced sandbox, or internal confirmation ceremony.

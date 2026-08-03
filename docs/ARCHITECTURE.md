# Architecture

## Components

| Component | Identity | Owns | Does not own |
|---|---|---|---|
| ChatGPT app | `call_sez` | caller intent and OAuth session | jobs, files, releases |
| Secure MCP Tunnel | outbound client | transport | authentication authority, execution |
| Gateway | unprivileged | OAuth/DCR/refresh/revocation state, request signing | root execution, jobs, artifacts, releases |
| Supervisor | UID 0 | operations, jobs, streams, PTYs, artifacts, receipts, skills, nspawn, product releases | OAuth clients, KVM truth, recovery truth |
| `z` | bundled executable | KVM manifests, disks, keys, QEMU/QMP and snapshots | host jobs, OAuth, nspawn |
| Recovery | separately released UID 0 service | fencing, authority generation, active/previous pointers, rollback/repair | normal root operations, OAuth clients |

## Socket topology

```text
se-z-gateway -> /run/se-z/gateway.sock -> supervisor
se-z CLI     -> /run/se-z/local.sock   -> supervisor
```

Gateway authentication is signed-envelope plus `SO_PEERCRED`. Local authentication is `SO_PEERCRED` for UID 0 or the `se-z` group.

## Network topology

- MCP: private tunnel only.
- OAuth browser flow: public `auth.se-z.stealtheye.io` only when required.
- Supervisor: no TCP listener.
- Gateway: loopback listener and Unix-socket client.
- SSH: break-glass/provider access, not normal product control.

## State paths

```text
/etc/se-z/
/etc/se-z-gateway/
/var/lib/se-z/
/var/lib/se-z-gateway/slots/{blue,green}/
/var/lib/se-z-recovery/
/opt/se-z/releases/
/opt/se-z-recovery/releases/
/run/se-z/{gateway.sock,local.sock}
```

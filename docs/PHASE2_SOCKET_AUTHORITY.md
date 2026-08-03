# Phase 2 Socket and Authority Boundary

## Physical listeners

- `/run/se-z/local.sock`: root:se-z, mode 0660.
- `/run/se-z/gateway.sock`: root:se-z-gateway, mode 0660.

The systemd socket units pass named descriptors. The supervisor records which listener accepted a connection; it never derives socket class from the request envelope.

## Local peer

A local request must arrive on the local socket, declare `peerClass=local-peer`, omit gateway impersonation fields and carry the current generation. Authorization requires UID 0 or actual primary/supplementary membership in the configured `se-z` group.

The native addon returns accepted-socket PID, UID and GID through Linux `SO_PEERCRED`. Supplementary groups are read from the peer process `/proc/<pid>/status`; process start time is sampled before and after identity collection to reject obvious PID reuse.

## Gateway peer

A gateway request must arrive on the gateway socket and declare `peerClass=gateway-signed`. The peer UID/GID and executable must match configured service identity. The gateway ID and key ID must be accepted and the Ed25519 signature must verify over the exact canonical request digest, including authority generation and peer class.

## Cross-class rejection

A gateway user has no special local-socket authority. A local operator cannot submit a gateway-class envelope or impersonate a gateway key. A cryptographically valid gateway request on the local socket still fails peer-class matching. Root is accepted on the local socket through local authority, not gateway impersonation.

## Authority generation

The welcome advertises the currently observed generation so a legitimate peer can construct a request. The welcome grants no authority. Stale and future generations fail before request reservation, process launch, file change or artifact creation. Phase 2 does not claim physical old-writer fencing; that remains recovery scope.

# State Ownership

## Gateway

Owns only OAuth and gateway transport state under `/var/lib/se-z-gateway/` plus its own signing material under `/etc/se-z-gateway/`.

## Supervisor

Owns jobs, streams, PTYs, artifacts, receipts, request replay/idempotency, skills, nspawn, operation catalog, and se-z product release transaction records under `/var/lib/se-z/`.

## z

Owns KVM manifests, disks, guest identity, QEMU/QMP state, port allocation, snapshot chains, and machine lifecycle. se-z calls the bundled `z` interface and does not duplicate this state.

## Recovery

Owns product and recovery slot pointers, authority generation, physical fencing records, rollback guards, and recovery evidence under `/var/lib/se-z-recovery/`.

## Rule

A component may cache another component’s identity for validation but may not become a competing authority for its lifecycle truth.

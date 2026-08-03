# Independent Recovery

Recovery is separately versioned from the product and has blue/green slots, its own state schema, release identity, and upgrade transaction.

Ordinary product releases cannot modify recovery executables, service units, signing roots, or state schemas.

## Product handoff

Recovery blocks mutations, resolves old mutating scopes, stops the old supervisor, removes non-adopted descendants, verifies no old writer remains, advances `authorityGeneration`, and hands preserved sockets to the new supervisor.

## Recovery upgrade

The old recovery verifies a candidate that proves it can:

1. restore a deliberately broken se-z product stack;
2. reinstall or roll back to the previous recovery;
3. preserve product rollback state;
4. survive restart and host reboot.

Only the old recovery performs the handoff.

## Local commands

```text
se-z-recovery status
se-z-recovery lockdown
se-z-recovery rollback
se-z-recovery repair
```

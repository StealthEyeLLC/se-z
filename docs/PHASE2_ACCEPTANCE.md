# Phase 2 Acceptance — Kernel / Release Milestone 0.1A

This document is the executable Phase 2 gate, not a completion claim. `npm run phase2:verify` validates implementation-bound evidence and reruns the required protocol, authority, operation, durability, packaging, nspawn, host-candidate, readback, dependency, secret, and no-theater checks.

Mandatory environments are:

1. ordinary unit and real Unix-socket integration tests with ephemeral state and keys;
2. an exact-path Ubuntu 24.04 systemd-nspawn machine, including a machine reboot;
3. an isolated candidate-only supervisor on the authorized VPS;
4. a clean detached worktree at the tested commit.

A skipped mandatory test, unresolved high-severity no-theater finding, changed Baby protected identity, non-clean tested tree, or remote/local divergence fails milestone 0.1A.

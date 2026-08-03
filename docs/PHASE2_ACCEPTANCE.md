# Phase 2 Acceptance — Kernel / Release Milestone 0.1A

This is the executable Phase 2 gate, not a completion assertion. The milestone passes only when all mandatory evidence is implementation-bound, the exact candidate commit is clean and remote-synchronized, and no mandatory test is skipped.

## Commands

```text
npm ci --include=dev
npm run phase1:verify
npm run check
npm test
npm run build
npm run phase2:unit
npm run phase2:integration
npm run phase2:failure
npm run phase2:large-output
npm run phase2:package-reproducibility
npm run phase2:nspawn
npm run phase2:host-candidate
npm run phase2:audits
npm run phase2:summarize
npm run phase2:verify -- --require-clean
```

The verifier is then run a second consecutive time and once from a fresh detached worktree at the implementation commit.

## Mandatory environments

1. ordinary unit and real Unix-socket tests with ephemeral state/keys;
2. an exact-path Ubuntu 24.04 systemd-nspawn machine with real systemd and one machine reboot;
3. an isolated candidate-only supervisor on the authorized VPS;
4. a fresh detached worktree at the tested implementation commit.

## Mandatory evidence properties

Evidence contains bounded identities, counts, exit states and digests rather than large raw streams. The large-output test reads every byte of at least 80 MiB stdout plus nonempty stderr through bounded pages and records independently computed digests. Candidate evidence binds source commit/tree, archive digest, catalog digest, schema digests, native addon digest and state schema.

Before/after Baby readback compares service definitions, sockets, installed manifests, release pointers, Caddy endpoint presence and protected configuration metadata without reading credential contents. Ordinary Baby job/log/receipt accrual is excluded from equality.

## Failure conditions

A dirty tested tree, remote mismatch, post-test implementation change, skipped mandatory suite, missing exact-path environment, failed candidate cleanup, changed Baby protected configuration, public se-z listener, secret finding, forbidden active identity or unresolved high-severity no-theater finding fails 0.1A.

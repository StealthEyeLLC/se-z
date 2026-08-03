# Phase 1 Test Plan

Phase 1 compares behavior, not filenames. All tests use temporary directories, ephemeral keys, loopback HTTP origins, and local Unix sockets. No test points at the production socket, state roots, OAuth credentials, release pointers, or public endpoint.

## Source reference

`materialize-source.mjs` fetches exact commit archives or exact Git commits, verifies commit/tree/archive digests, and places them under ignored `.phase1-sources/`. `test-source.mjs` forces development dependencies even when the host has `NODE_ENV=production`, builds the native addon and TypeScript, then runs source contract, unit, integration, acceptance, gateway check, and gateway unit suites. Results contain exit status and bounded stdout/stderr digests, not raw logs or secrets.

## Extracted implementation

The extracted TypeScript remains TypeScript, gateway JavaScript remains ES modules, and the peer-credential addon remains native C++/node-gyp. Focused extracted tests run before each component-family commit. The top-level `check`, `test`, and `build` commands continue to work.

## Parity families

- Protocol: framing, size bounds, malformed input, canonical encoding, digests, signatures, replay, request age, typed errors.
- Discovery/catalog: source operation mapping, schemas, mutation/idempotency metadata, limits, identities, determinism.
- Execution/jobs/streams: exact argv and shell, stdin/env/cwd, exit/signal, binary/large output, durable state, cancellation, wait, resume shape, offsets, idempotency.
- Files/PTY/artifacts: bytes, modes, digests, symlinks, atomic cleanup, session offsets/resize/close, resumable upload/finalization/corruption rejection.
- Skills/releases/GitHub: deterministic bundle/set identity, activation/rollback/readback, isolated stage/verify/repair metadata, ephemeral App-token handling and cleanup.
- Gateway/OAuth: initialize, exact one-tool contract, invocation correlation, request/receipt signatures, challenge, DCR, PKCE S256, numeric owner ID, resource/audience, refresh rotation, revocation, JWKS.

## Normalization

UUIDs, timestamps, temporary roots, PIDs, job/session/artifact/receipt IDs, nonces, fixture key IDs, signatures, release roots, hostnames, machine identities, and stream handles are replaced with typed placeholders. Exit status, signal, bytes, offsets, modes, digests, error type, replay/idempotency behavior, signature verification, and cleanup state are never discarded.

## Evidence rule

A skipped credential- or platform-dependent test carries an explicit reason and does not count as a pass. Source limitations such as the 64 MiB output ceiling, missing authorityGeneration, single socket, absent KVM, or non-tunnel resource identity appear as canonical deltas rather than false parity.

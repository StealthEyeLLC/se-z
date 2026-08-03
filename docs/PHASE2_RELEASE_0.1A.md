# Release Milestone 0.1A

Identity language for this artifact is: **Phase 2 kernel, release milestone 0.1A, candidate accepted, not production activated, not standalone complete**.

## Candidate contents

The digest-addressed archive contains the supervisor, local CLI, gateway test client, SEZ1 schemas and vectors, complete operation/error/state contracts, native `SO_PEERCRED` addon, exact bundled Node 24.18.0 runtime, systemd service/socket units, tmpfiles rules, installer/verifier/cleanup tools, licenses, notices and a file-digest manifest.

It excludes private keys, Baby keys, OAuth/tunnel/GitHub credentials, production state and `node_modules`. Installation generates independent se-z test/production-shaped keys at the destination; no key is committed to the archive.

## Reproducibility

`npm run phase2:package-reproducibility` builds twice from the same clean source commit and source epoch. The two compressed archives and manifests must match byte-for-byte. The release manifest records source commit/tree, Node and TypeScript versions, compiler identity, native addon digest, catalog and schema digests, state schema, runtime dependencies, artifact file digests and provenance identities.

## Acceptance boundary

Exact production paths and identities are accepted in a disposable Ubuntu 24.04 systemd-nspawn machine, including a machine reboot. An isolated candidate service with candidate-only paths and keys is accepted on the authorized VPS. Neither test activates public ingress, changes Caddy or replaces Baby.

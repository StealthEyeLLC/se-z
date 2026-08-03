# Release Contract

A product release is exact-source, immutable, digest-addressed, and contains the supervisor, gateway, CLI, runtime, operation catalog, schemas, bundled `z`, and core skill ABI.

## Lifecycle

```text
build -> stage -> verify -> physically fence -> activate -> accept
                                      | failure
                                      v
                               rollback or repair
```

Candidate supervisor, gateway, sockets, state, OAuth slot, jobs, artifacts, nspawn IDs, KVM IDs, GitHub proof resources, tunnel, and temporary ChatGPT app are isolated from production.

Activation does not require an internal second owner confirmation. The activation request authorizes the transaction.

State migration remains downgrade-readable until postactivation acceptance. Irreversible migration is a separate finalization operation only when explicitly supported by the compatibility contract.

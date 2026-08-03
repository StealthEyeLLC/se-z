# se-z

**Repository:** `StealthEyeLLC/se-z`  
**Product and local command:** `se-z`  
**Public MCP tool:** `call_sez`  
**Operation namespace:** `sez.*`  
**Protocol:** `SEZ1`

se-z is an owner-only, standalone, unrestricted UID-0 control system for the authorized StealthEye VPS. Its permanent default is the direct fast lane: authenticated ChatGPT requests execute against the host as root unless the owner explicitly selects another target or mode.

The public ChatGPT contract is permanently one generic tool with exactly three inputs: `operation`, `payload`, and `idempotencyKey`. The installed operation catalog and `catalogDigest` are published through `sez.describe`.

## Status

This repository is initialized with the canonical standalone specification, protocol contract, executable requirements, build plan, threat model, recovery model, OAuth contract, and implementation scaffold. It is not yet a completed standalone release.

The currently deployed Baby-backed app is the verified migration source and rollback path. It is not the final se-z runtime.

## Canonical precedence

1. [`CANONICAL.md`](CANONICAL.md)
2. [`docs/ENGINEERING_SPEC.md`](docs/ENGINEERING_SPEC.md)
3. [`protocol/SEZ1.md`](protocol/SEZ1.md)
4. [`contracts/requirements.yaml`](contracts/requirements.yaml)
5. [`docs/BUILD.md`](docs/BUILD.md)
6. Supporting documents under [`docs/`](docs/)

## Build entry point

```bash
npm run check
npm test
npm run build
```

The initial scaffold intentionally contains no claim that root execution, OAuth, tunnel transport, nspawn, KVM, release activation, recovery, or restore are implemented. Those capabilities become real only when their executable requirements and acceptance evidence pass.

## License

Copyright 2026 StealthEye LLC. All rights reserved. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

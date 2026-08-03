# Provenance

Phase 1 extracts proven implementation mechanics from exact deployed Baby source identities into se-z-owned component paths. It does not represent that work as newly authored from scratch.

## Source identities

- Supervisor: `StealthEyeLLC/baby-quirt` commit `b3a7119fb9321d74fee9a730517f519ed0d351c4`, tree `9ebab95f7f136c8480495f812796ac0bdc558a21`.
- Gateway: `StealthEyeLLC/baby-quirt-mcp` commit `0bfcd99757afe198151e96b18771626388914205`, tree `d0598af304c8cda8df3bb538d703d9db6c7dcb04`.

`vendor/baby-provenance/file-map.json` is the authoritative per-file lineage map. It records source path, source commit/tree, source SHA-256, destination path, transformation type, target SHA-256 after extraction, and the applicable notice.

## Transformation classes

- **exact copy** — byte-identical source content at a se-z-owned destination.
- **mechanically renamed copy** — only active product names, paths, services, users/groups, or operation identities changed.
- **mechanically adapted copy** — identity changes plus import/path relocation required by the component layout.
- **canonical adapter around source mechanics** — a narrow target layer adds a canonical field or boundary without rewriting the proven core.
- **new se-z implementation** — target-only code with no copied implementation body.
- **test fixture derived from source** — a source contract or fixture used only for comparison.
- **historical reference only** — retained through source pinning and evidence, not copied into active runtime code.

## Notices and rights

The pinned supervisor tree contains no separate license or notice file. The pinned gateway tree contains `NOTICE.md` stating Copyright 2026 StealthEye LLC, all rights reserved. Both sources and the target are owned by StealthEye LLC, and this extraction is owner-directed. Existing StealthEye notices are preserved; none is removed or replaced with a false claim of independent authorship.

## Historical names

Historical Baby names remain in evidence, provenance, migration records, source-reference tests, and legal records because removing them would make lineage false. Active target implementation uses se-z identities and is automatically scanned for forbidden runtime dependencies.

## Credential boundary

No private key, OAuth client secret, GitHub installation token, bearer token, refresh token, tunnel credential, encrypted systemd credential payload, live environment file, or production state is copied into this repository. Public keys, key IDs, credential-reference names, and paths are permitted where needed to describe or verify mechanics.

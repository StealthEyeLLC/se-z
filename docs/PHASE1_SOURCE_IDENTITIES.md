# Phase 1 Source Identities

Captured from the active installation on 2026-08-03 before implementation extraction. The authority order was the installed active-release manifest, signed runtime discovery, active pointer, exact GitHub commit/tree, then documentation and moving branch heads.

## Target start

| Field | Value |
|---|---|
| Repository | `StealthEyeLLC/se-z` |
| Branch | `build/standalone-0.1` |
| Starting commit | `4a7c0865b606958f6dca2d9e5b928f47d5e3b45c` |
| Starting tree | `d9b7cdbadbc29e79a8a2799377f276b665035155` |
| `main` comparison | Identical at capture |

## Deployed supervisor source

| Field | Value |
|---|---|
| Repository | `StealthEyeLLC/baby-quirt` |
| Active release | `/opt/baby-quirt/releases/b3a7119fb9321d74fee9a730517f519ed0d351c4` |
| Manifest | `/opt/baby-quirt/current/manifest.json` |
| Manifest SHA-256 | `315606a6e6c0738b39387cb5cccae1ec1d79834a576da6c46c0099eaa8992f1d` |
| Version | `0.1.0` |
| Commit | `b3a7119fb9321d74fee9a730517f519ed0d351c4` |
| Tree | `9ebab95f7f136c8480495f812796ac0bdc558a21` |
| Source date epoch | `1785157347` |
| Runtime catalog digest | `444356b24912f157f29057479f0a1eb5ad3bcebdf6f1a451be8e861ecbf66fb1` |
| Active skill-set digest | `1a7e8fa37ec56fe4842b598914fb784f2153d8c35ac95e938f4b8993f80491d5` |
| Receipt key ID | `supervisor-receipt-v1` |
| Host | `vps-c9f04f5e` |

The GitHub API resolved that exact commit to that exact tree. The complete tracked tree was fetched at the commit; no branch head was substituted.

## Deployed gateway source

| Field | Value |
|---|---|
| Repository | `StealthEyeLLC/baby-quirt-mcp` |
| Active release | `/opt/baby-quirt-mcp/releases/0.2.3` |
| Manifest | `/opt/baby-quirt-mcp/current/release.json` |
| Manifest SHA-256 | `f116ea7012a1bc8a4c40ca3993a02fb26544badca0c47454c47181fdb3622f4e` |
| Package version | `0.1.0` |
| Release-directory label | `0.2.3` |
| Commit | `0bfcd99757afe198151e96b18771626388914205` |
| Tree | `d0598af304c8cda8df3bb538d703d9db6c7dcb04` |
| Source date epoch | `1784784328` |
| Node | `24.18.0` |
| Public tool | `call_quirt` |
| Service | `baby-quirt-mcp.service` |
| OAuth issuer | `https://baby-quirt.stealtheye.io` |
| Protected resource | `https://baby-quirt.stealtheye.io/mcp` |
| Source authority scope | `baby.apply` |
| Gateway key ID | `gateway-authority-v1` |

The gateway identity is independent of the supervisor identity. `/etc/baby-quirt/release-manifests/0.2.3.json` is a coordinated supervisor release record, not the gateway source manifest; its older supervisor identity was preserved as a discrepancy instead of being used as gateway authority.

## Runtime evidence boundary

Signed discovery reported QRT1 `1.0.0`, 49 installed operations, the catalog and skill-set digests above, and a verified supervisor receipt. Phase 1 treats those records as migration evidence only. They do not override the se-z canonicals or convert the live system into standalone se-z.

No private key, bearer token, refresh token, GitHub installation token, OAuth client secret, encrypted credential payload, or arbitrary environment value is present in these records.

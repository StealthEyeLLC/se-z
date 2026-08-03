# Phase 1 Rename Map

Active product identity is converted mechanically from Baby to se-z only after source identity and provenance are pinned. Historical evidence is not rewritten.

## Direct conversions

| Source | Active target |
|---|---|
| Baby Quirt / `baby-quirt` | se-z / `se-z` |
| Baby Quirt MCP / `baby-quirt-mcp` | se-z gateway / `se-z-gateway` |
| `call_quirt` / `bbyquirt.call_quirt` | `call_sez` |
| `baby.*` | `sez.*` |
| QRT1 | SEZ1 |
| `baby.apply` | `sez.root` |
| `/etc/baby-quirt/` | `/etc/se-z/` |
| `/etc/baby-quirt-mcp/` | `/etc/se-z-gateway/` |
| `/var/lib/baby-quirt/` | `/var/lib/se-z/` |
| `/var/lib/baby-quirt-mcp/` | `/var/lib/se-z-gateway/` |
| `baby-quirt.service` | `se-z.service` |
| `baby-quirt-mcp.service` | `se-z-gateway.service` |
| `fix-mcp` | `se-z-gateway` |
| `horsey` | `se-z` |

## Nonmechanical adaptations

The source socket cannot be converted with a single replacement. `/run/horsey/baby-quirt.sock` maps to the canonical gateway and local peer-class sockets, `/run/se-z/gateway.sock` and `/run/se-z/local.sock`; the dual-socket boundary belongs to 0.1A.

The public endpoint, OAuth issuer, OAuth state slots, resource/audience propagation, and tunnel transport belong to 0.1B. Key classes are renamed by reference only; no secret value is copied or transformed.

The full executable map is `vendor/baby-provenance/rename-map.json`.

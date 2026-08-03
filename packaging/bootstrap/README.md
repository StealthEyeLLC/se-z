# Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
# se-z Bootstrap Lane

This directory contains only non-secret public bootstrap material used to pin the production deployment and gateway authority. Private deployment and signing material must remain outside the repository.

## Committed public material

| Asset | Path |
| --- | --- |
| CI deploy SSH public key | `ops/bootstrap/se-z-ci-deploy.pub` |
| Gateway authority public key | `ops/bootstrap/gateway-authority-public.pem` |

## Pinned fingerprints

| Asset | Fingerprint |
| --- | --- |
| Gateway authority public PEM SHA-256 | `0288179e795a801111cebfbba1b43fd3792f08b38c861974eff4a915d61b1ed7` |
| CI deploy SSH public key | `SHA256:G/canENPq2U6Ak5tb4PsCQPjtfLC1RSifjYwKycCTRA` |
| VPS SSH host key (Ed25519) | `SHA256:hTe07vTyIU1bZ6C56+58+T2PgctkQ+RYkepn/5j+aaE` |

Set repository variable `SEZ_OWNER_PRINCIPAL_FINGERPRINT` to the gateway authority public PEM SHA-256 above.

## GitHub deployment secrets

The current `.github/workflows/deploy.yml` consumes exactly these secrets:

- `SEZ_VPS_SSH_PRIVATE_KEY`
- `SEZ_VPS_SSH_KNOWN_HOSTS`

A repository secret named `SEZ_GATEWAY_SIGNING_PRIVATE_KEY` may exist from an earlier bootstrap procedure, but the se-z deploy workflow does not consume it. Gateway private-key custody belongs to the separate `StealthEyeLLC/se-z-gateway` deployment and the authorized host. Do not add that private key to a se-z release bundle.

## Supervisor receipt key

The supervisor receipt key pair is generated on the VPS during first installation:

| Material | Production path | Access |
| --- | --- | --- |
| Private key | `/etc/se-z/supervisor-receipt-private.pem` | `root:root`, `0600` |
| Public key | `/etc/se-z/supervisor-receipt-public.pem` | `root:sez`, `0640` |

Only the public key is readable by the `se-z-gateway` gateway for receipt verification.

## VPS authorization

Authorize the committed CI deploy public key for the controlled deployment account on `51.81.86.225` through the existing StealthEye host-control path. Keep strict host-key checking enabled and verify the expected hostname and normalized machine-id SHA-256 before every mutation.

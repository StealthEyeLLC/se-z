# Threat Model

## Compromised ChatGPT/GitHub owner identity

A complete compromise grants the attacker the same owner authority. se-z cannot distinguish Jamie from an attacker who fully controls Jamie’s authenticated identity. Response is revocation, gateway lockdown, and key rotation through local recovery.

## Compromised OAuth token or refresh family

Exact audience/resource, issuer, client, subject, scope, expiry, rotation, and revocation limit reuse. Refresh replay revokes the affected family.

## Compromised tunnel credential

The credential can affect tunnel connectivity. It does not replace OAuth owner authentication. Rotate it independently and preserve local CLI/recovery operation.

## Compromised gateway or gateway signing key

A valid gateway signing key can inject root requests. The gateway is unprivileged, minimal, and state-limited; compromise response is recovery lockdown, process stop, key rotation, and readback.

## Compromised GitHub source or build input

Provenance proves origin, not benevolent intent. Exact commit/tree, reviews, dependency identities, reproducibility, and independent verification are separate controls.

## Compromised builder

A builder that also signs and verifies its own output is not independent assurance. Independent claims identify distinct builder, signing trust root, verifier, and off-host append-only backup authority.

## Compromised nspawn or KVM guest

nspawn shares the host kernel and is not a hostile multi-tenant boundary. KVM has a separate guest kernel but retains QEMU/KVM host attack surface. Neither target silently becomes host execution.

## Compromised supervisor or host root

Once host root is compromised, local guarantees end. Local receipts remain useful operational records but are not independent proof against the compromised host.

## Raw output and secrets

Unrestricted root plus raw file, PTY, and stream access can expose sensitive data. se-z promises only that managed credentials are not automatically injected, indexed, or copied into routine evidence. Explicit owner-authorized raw output is private owner data and may contain anything root can read.

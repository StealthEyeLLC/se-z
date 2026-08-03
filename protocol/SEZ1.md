# SEZ1 Protocol Specification

**Status:** canonical pre-implementation specification  
**Protocol version:** `1.0.0`

## 1. Purpose

SEZ1 is the signed local protocol between the se-z gateway or native CLI and the UID-0 supervisor. It provides exact request identity, authority-generation fencing, replay handling, semantic idempotency, durable execution handles, bounded frames, complete output retrieval, restart reconciliation, and signed receipts.

## 2. Transport and framing

- Unix domain sockets.
- Four-byte unsigned big-endian frame length followed by canonical UTF-8 JSON.
- Maximum frame length: 16 MiB.
- Files, artifacts, and unrestricted command output are externalized to durable binary-safe stores and retrieved in bounded pages.
- Frame size is a transport bound, never an execution-output bound.

## 3. Socket classes

### 3.1 Gateway socket

```text
/run/se-z/gateway.sock
owner: root
 group: se-z-gateway
 mode: 0660
```

The supervisor verifies both:

1. `SO_PEERCRED` identifies the configured unprivileged gateway UID; and
2. the request contains a valid signature from the active gateway key over the canonical request digest.

A gateway request without a valid signed envelope is rejected.

### 3.2 Local socket

```text
/run/se-z/local.sock
owner: root
 group: se-z
 mode: 0660
```

The supervisor uses `SO_PEERCRED` to authorize UID 0 or a genuine member of the local `se-z` operator group. Local requests use `peerClass=local-peer` and are not required to carry a gateway signature. They remain subject to request correlation, authority generation, idempotency, and replay rules.

## 4. Canonical request

```json
{
  "protocol": "SEZ1",
  "protocolVersion": "1.0.0",
  "requestId": "018f...",
  "operation": "sez.exec",
  "payload": {},
  "idempotencyKey": "exec-20260803-001",
  "subject": "stealtheye-owner",
  "authorityClass": "unrestricted-owner",
  "authorityGeneration": 17,
  "issuedAt": "2026-08-03T10:00:00Z",
  "nonce": "base64url...",
  "peerClass": "gateway-signed",
  "gatewayId": "se-z-gateway",
  "gatewayKeyId": "gateway-v1",
  "signature": "base64..."
}
```

`authorityGeneration` is mandatory and is included in the request schema and digest. This resolves any mismatch between the signed representation and the envelope.

## 5. Canonical encoding

The request digest is SHA-256 over a deterministic serialization of these fields in this order:

```text
protocol
protocolVersion
requestId
operation
canonical payload
idempotencyKey
subject
authorityClass
authorityGeneration
issuedAt
nonce
peerClass
gatewayId or empty
gatewayKeyId or empty
```

The implementation must publish test vectors before activation. Unknown fields are rejected at the protocol envelope level.

## 6. Authority generation

- Recovery owns the authoritative generation.
- Every request carries the generation observed by the caller.
- The supervisor rejects stale or future generations.
- Generation advancement occurs only after physical old-writer fencing.
- An adopted job receives an explicit adoption record binding old and new generations.

## 7. Replay and request age

- Nonces are unique within the configured replay-retention window.
- Issued time is checked against a bounded request-age/skew policy.
- Exact request replay returns the durable existing result when available.
- A nonce replay with nonidentical content is rejected.
- Wall-clock time is not used as the sole state ordering mechanism; durable monotonic state sequences are authoritative locally.

## 8. Idempotency

The idempotency identity binds subject, operation, canonical payload, target, and authority generation.

- Same key and identical semantic input: return or resume the existing request.
- Same key and changed semantic input: `idempotency_conflict`.
- Response loss never permits blind duplicate mutation.
- `sez.request.resume` resolves a request by request ID or exact idempotency identity.

## 9. Response

Every response includes:

- request ID;
- operation;
- state and terminal flag;
- authority generation;
- `catalogDigest`;
- result or typed error;
- durable job ID when applicable;
- stdout/stderr stream descriptors;
- result digest;
- signed receipt.

`catalogDigest` is mandatory on every response, not only `sez.describe`.

## 10. Durable streams

All process output is written to durable stdout and stderr streams before or while inline data is returned.

Each stream descriptor contains:

- stable handle;
- bounded inline content;
- inline encoding;
- starting and next byte offsets;
- total size when known;
- SHA-256 digest for the bytes committed so far or final stream;
- completion flag.

The complete output is retrieved with `sez.job.stream.read`. Per-call output is bounded so the result remains below the frame limit. Output itself has no 16 MiB total ceiling.

## 11. Waiting and resumption

“ChatGPT automatically waits” is caller guidance, not protocol magic.

Deterministic server operations are:

- `sez.job.wait`: wait up to a caller-specified bound and return current or terminal state with requested stream pages;
- `sez.request.resume`: recover the exact request/job/result after response loss;
- `sez.job.get`: read current state without waiting;
- `sez.job.stream.read`: retrieve output from exact offsets.

These operations make caller behavior repeatable and resumable.

## 12. Receipts

A receipt binds request digest, result digest, authority generation, catalog digest, host identity, release identity, times, stream digests, and receipt key ID. Routine receipts bind raw stream digests rather than copying sensitive output into the receipt.

## 13. Key rotation

Gateway request keys, supervisor receipt keys, and OAuth JWT keys have independent key IDs and lifecycles. The accepted-key set and overlap window are explicit. Rotation does not change operation authority.

## 14. Restart reconciliation

After supervisor restart, the runtime discovers job scopes, process identity, output stores, PTYs, artifacts, and idempotency records. It reports actual state as running, completed, failed, cancelled, lost, ambiguous, or reconciled. It does not invent success.

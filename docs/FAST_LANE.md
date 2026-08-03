# Fast Lane

Fast lane is the permanent default.

Missing values resolve to:

```text
lane=fast target=host user=root group=root cwd=/root timeout=none
```

Fast lane has no se-z command/path/package/network allowlist, policy engine, internal approval, forced sandbox, forced rehearsal, automatic backup, mandatory evidence bundle, artificial owner quota, or automatic redaction of explicit root output.

Fast lane retains only mechanics required to preserve capability and correctness: owner authentication, exact target binding, request/result correlation, replay/idempotency, process identity, durable streams, minimal receipts, and release-handoff fencing.

Long-running work returns a durable handle. Caller instructions should invoke `sez.job.wait`, `sez.job.stream.read`, or `sez.request.resume` so Jamie receives one coherent result. The server never assumes the caller will remember or wait.

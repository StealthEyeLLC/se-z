# Phase 2 Failure Injection

The executable suite is `scripts/phase2/failure-injection.mjs`. It runs the real supervisor and state managers with explicit test-only injection points; production configuration rejects fault-injection fields.

Covered protocol and authority failures include partial/malformed frames, malformed UTF-8/JSON, handshake and version errors, unknown fields, wrong socket/class, wrong gateway identity/key/signature, stale/future generation, request age and changed-content nonce replay.

Covered execution failures include command not found, nonzero exit, signal termination, explicit timeout, cancellation, supervisor SIGKILL during a durable job, completion while the supervisor is absent, stale process identity and missing process.

Covered storage failures include simulated ENOSPC, durable stream-write failure, corrupted mandatory state, interrupted artifact upload and atomic replacement failure before rename. The suite verifies partial committed data and original-file preservation where applicable.

Clock tests move issued timestamps backward and forward while durable local sequence remains the ordering authority. Receipt tests mutate the result, stream digest, generation, catalog digest, signature and receipt ID and require verification failure.

A passing suite requires diagnosable typed state and no fabricated completion.

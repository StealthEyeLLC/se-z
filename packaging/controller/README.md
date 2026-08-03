# Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
# Fixed standalone deployment controller

This directory describes the Sez-owned controller installed outside both
active product release trees. It has no listener and no generic command,
shell, file-copy, or service-management interface. The only installed
entrypoint consumes canonical signed deployment records and executes the
finite controller actions compiled into se-z.

The guard service is wrapped by `flock` on `/run/se-z/deploy.lock` and
the persistent timer re-evaluates the exact deployment generation after boot.
All durable guard records and signed evidence live below
`/var/lib/se-z/deployments`; controller keys and policy live below
`/etc/se-z/deployment`.

A product activation transaction may call the controller but may not replace
its bytes. Controller bootstrap and A/B upgrade are distinct transactions with
an immutable target and known-good fallback. Source implementation and fixture
tests never install these files on a live host.

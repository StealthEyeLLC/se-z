# Standalone Acceptance Gate

Mandatory acceptance includes:

1. exact clean clone and passing check/test/build;
2. exactly one public tool with the frozen schema;
3. `authorityGeneration` present and digest-bound;
4. protected-resource metadata, `WWW-Authenticate`, exact resource propagation, and audience rejection;
5. `sez.root` authority plus working refresh lifecycle without reauthentication churn;
6. isolated and restorable `/var/lib/se-z-gateway` slots;
7. gateway signed-envelope socket and local SO_PEERCRED socket separation;
8. output greater than 16 MiB captured and fully retrieved by durable streams;
9. `catalogDigest` on every response;
10. deterministic request resume and job wait after response loss;
11. direct UID-0 host exec, shell, file, PTY, package, systemd, network, mount, and process operations;
12. physical fencing and stale-generation rejection;
13. separately versioned recovery upgrade and rollback;
14. independent gateway, supervisor, and recovery restart tests;
15. nspawn create/start/exec/reboot/stop/delete and host-reboot reconciliation;
16. bundled-z identity and full real KVM lifecycle with no TCG;
17. independent GitHub proofs for each enabled write family;
18. blue/green product upgrade, deliberately failed upgrade, rollback, and repair;
19. backup and clean-host restore including gateway OAuth state;
20. permanent `call_sez` app recreated after temporary-app acceptance;
21. zero Baby process, socket, route, key use, executable import, state consultation, `call_quirt`, or `baby.*` operation after cutover;
22. preserved provenance and raw migration evidence.

Failure injection includes power/reboot interruption, disk full, stale generation, surviving old descendants, corrupted state, response loss, process kill, clock change, refresh replay, failed rollback, and interrupted recovery upgrade.

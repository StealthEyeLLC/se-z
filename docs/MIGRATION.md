# Migration from the Verified Baby-backed Baseline

The deployed Baby-backed app is the proven source for UID-0 execution, jobs, files, PTYs, artifacts, releases, skills, receipts, and GitHub App verification. It remains untouched while standalone se-z is built and tested.

Migration rules:

1. Copy mechanics with provenance and notices.
2. Mechanically rename identities and add parity tests.
3. Build standalone keys, state, sockets, gateway, supervisor, protocol, and recovery.
4. Test `call_sez` through a temporary ChatGPT app.
5. Never expose `call_quirt` and `call_sez` in one catalog.
6. Activate standalone se-z only after complete candidate acceptance.
7. Recreate or republish the permanent app against the one-tool `call_sez` catalog.
8. Retain Baby as rollback until reboot, failed-upgrade rollback, restore, nspawn, KVM, and GitHub-write gates pass.

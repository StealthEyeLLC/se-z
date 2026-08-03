# No Theater

Every control, artifact, attestation, confirmation, validation, service, or document must map to a named threat, failure mode, acceptance test, implementation contract, or recovery requirement.

If it has no enforcement effect, no executable test, and no recovery value, it is removed.

Examples:

- Physical old-writer termination is real; merely incrementing a counter is insufficient.
- Durable stream handles are real; claiming unrestricted output inside one bounded frame is false.
- Independent recovery is real; rollback code inside the defective release is not independent.
- Provenance identifies source and process; a badge without verified trust boundaries is theater.
- A minimal result receipt provides correlation; permanent compliance packaging for every `pwd` is theater.

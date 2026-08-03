# Verified Live Migration Baseline

**Verification date:** 2026-08-03

The installed ChatGPT app named se-z is operational but still routes through the Baby Quirt migration source:

```text
ChatGPT app: se-z
  -> call_quirt
  -> baby-quirt MCP gateway
  -> Baby Quirt supervisor as UID 0
  -> vps-c9f04f5e
```

Verified source identity:

```text
product: baby-quirt
protocol: QRT1/1.0.0
version: 0.1.0
commit: b3a7119fb9321d74fee9a730517f519ed0d351c4
tree: 9ebab95f7f136c8480495f812796ac0bdc558a21
hostname: vps-c9f04f5e
authority subject: stealtheye-owner
authority class: unrestricted-owner
```

Direct `/usr/bin/id -u` execution completed with exit code 0 and stdout `0`. Signed discovery, health, execution, completion, and stream receipts were verified. GitHub App verification against `StealthEyeLLC/se-z` succeeded using an ephemeral token, and the immutable proof skill set was healthy.

The baseline does not prove standalone se-z, native nspawn, or KVM machine operations. It is the migration source and rollback path until the standalone acceptance gate passes.

Evidence locator IDs from the migration record:

- discovery: `15e874495842f5ecf096ae0570d9262d`
- health: `70dd80b21a7bafc756c4e17bd8189cd0`
- root execution: `3f543eab82f3ad0d9db3f34659281386`
- job completion: `c72be8f3ae1b9793d666c9cea07efc96`
- stdout: `5aac84d76b94c7ebb26009c3df394d40`
- skill status: `989f440aa301b22cdaa0ba0650ce2244`
- GitHub verification: `5d638819d4de4993c5f3adb0b4c97e32`

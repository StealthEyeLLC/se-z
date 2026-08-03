// Derived test fixture: StealthEyeLLC/baby-quirt@b3a7119fb9321d74fee9a730517f519ed0d351c4:acceptance/systemd.test.ts; exact lineage in vendor/baby-provenance/file-map.json.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getSystemdListenFd, isSocketActivated } from '../../../../src/supervisor/sockets/socket-activation.js';

describe('acceptance: systemd socket activation', () => {
  it('detects inherited listen fd when LISTEN_FDS is set', () => {
    const originalFds = process.env.LISTEN_FDS;
    const originalPid = process.env.LISTEN_PID;
    process.env.LISTEN_FDS = '1';
    process.env.LISTEN_PID = String(process.pid);
    assert.equal(getSystemdListenFd(), 3);
    assert.equal(isSocketActivated(), true);
    if (originalFds === undefined) delete process.env.LISTEN_FDS;
    else process.env.LISTEN_FDS = originalFds;
    if (originalPid === undefined) delete process.env.LISTEN_PID;
    else process.env.LISTEN_PID = originalPid;
  });

  it('returns undefined when not socket activated', () => {
    const originalFds = process.env.LISTEN_FDS;
    delete process.env.LISTEN_FDS;
    assert.equal(getSystemdListenFd(), undefined);
    if (originalFds !== undefined) process.env.LISTEN_FDS = originalFds;
  });
});

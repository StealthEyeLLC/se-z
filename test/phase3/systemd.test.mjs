import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('gateway systemd unit invokes the bundled Node runtime', () => {
  const unit = fs.readFileSync('packaging/phase3/systemd/se-z-gateway.service', 'utf8');
  const execStart = unit.split(/\r?\n/).find((line) => line.startsWith('ExecStart='));
  assert.equal(
    execStart,
    'ExecStart=/opt/se-z/current/runtime/bin/node /opt/se-z/current/libexec/phase3/gateway-entrypoint.mjs --config /etc/se-z-gateway/config.json'
  );
  assert.doesNotMatch(execStart, /^ExecStart=\/usr\/bin\/env\s+node\b/);
});

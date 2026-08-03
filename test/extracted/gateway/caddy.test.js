// Derived test fixture: StealthEyeLLC/baby-quirt-mcp@0bfcd99757afe198151e96b18771626388914205:test/caddy.test.js; exact lineage in vendor/baby-provenance/file-map.json.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const script = new URL('../../../scripts/extracted/gateway/install-caddy-site.py', import.meta.url);

function install(config, fragment) {
  const root = mkdtempSync(join(tmpdir(), 'se-z-caddy-'));
  const configPath = join(root, 'Caddyfile');
  const fragmentPath = join(root, 'fragment');
  const outputPath = join(root, 'output');
  writeFileSync(configPath, config);
  writeFileSync(fragmentPath, fragment);
  execFileSync('python3', [script.pathname, '--config', configPath, '--fragment', fragmentPath, '--output', outputPath]);
  return readFileSync(outputPath, 'utf8');
}

describe('Caddy site installer', () => {
  it('replaces exactly one existing se-z site while preserving neighbors', () => {
    const value = install(
      `mcp.stealtheye.io {\n  respond "mcp"\n}\n\nse-z.stealtheye.io {\n  respond "old"\n}\n\nshell.stealtheye.io {\n  respond "shell"\n}\n`,
      `se-z.stealtheye.io {\n  respond "new"\n}\n`,
    );
    assert.equal((value.match(/se-z\.stealtheye\.io \{/gu) ?? []).length, 1);
    assert.match(value, /respond "new"/u);
    assert.doesNotMatch(value, /respond "old"/u);
    assert.match(value, /mcp\.stealtheye\.io/u);
    assert.match(value, /shell\.stealtheye\.io/u);
  });

  it('appends the site when it is absent', () => {
    const value = install(
      `mcp.stealtheye.io {\n  respond "mcp"\n}\n`,
      `se-z.stealtheye.io {\n  respond "new"\n}\n`,
    );
    assert.match(value, /mcp\.stealtheye\.io/u);
    assert.match(value, /se-z\.stealtheye\.io/u);
  });
});

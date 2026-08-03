import path from 'node:path';

export const SOURCE_IDENTITIES = Object.freeze({
  supervisor: Object.freeze({
    repository: 'StealthEyeLLC/baby-quirt',
    commit: 'b3a7119fb9321d74fee9a730517f519ed0d351c4',
    tree: '9ebab95f7f136c8480495f812796ac0bdc558a21',
    version: '0.1.0'
  }),
  gateway: Object.freeze({
    repository: 'StealthEyeLLC/baby-quirt-mcp',
    commit: '0bfcd99757afe198151e96b18771626388914205',
    tree: 'd0598af304c8cda8df3bb538d703d9db6c7dcb04',
    version: '0.1.0'
  })
});

const supervisorSourceRules = [
  [/^src\/protocol\/(.+)$/, 'src/protocol/framing/$1'],
  [/^src\/crypto\/canonical\.ts$/, 'src/protocol/canonical/canonical.ts'],
  [/^src\/crypto\/signing\.ts$/, 'src/protocol/signatures/signing.ts'],
  [/^src\/receipts\/(.+)$/, 'src/protocol/receipts/$1'],
  [/^src\/auth\/(.+)$/, 'src/supervisor/dispatch/auth/$1'],
  [/^src\/net\/peer-cred\.ts$/, 'src/supervisor/peers/peer-cred.ts'],
  [/^src\/net\/socket-activation\.ts$/, 'src/supervisor/sockets/socket-activation.ts'],
  [/^src\/config\.ts$/, 'src/supervisor/configuration/config.ts'],
  [/^src\/server\.ts$/, 'src/supervisor/server/server.ts'],
  [/^src\/index\.ts$/, 'src/supervisor/server/index.ts'],
  [/^src\/state\/replay-store\.ts$/, 'src/state/replay/store.ts'],
  [/^src\/state\/store\.ts$/, 'src/state/store/store.ts'],
  [/^src\/process\/(.+)$/, 'src/execution/process/$1'],
  [/^src\/jobs\/(.+)$/, 'src/jobs/$1'],
  [/^src\/files\/(.+)$/, 'src/files/$1'],
  [/^src\/pty\/(.+)$/, 'src/pty/$1'],
  [/^src\/artifacts\/(.+)$/, 'src/artifacts/$1'],
  [/^src\/operations\/(.+)$/, 'src/operations/$1'],
  [/^src\/skills\/(.+)$/, 'src/skills/$1'],
  [/^src\/release\/(.+)$/, 'src/releases/$1'],
  [/^src\/deployment\/(.+)$/, 'src/releases/deployment/$1'],
  [/^src\/controller\/(.+)$/, 'src/selfhost/controller/$1'],
  [/^src\/install\/(.+)$/, 'src/selfhost/install/$1'],
  [/^src\/github\/(.+)$/, 'src/github/$1'],
  [/^src\/secrets\/(.+)$/, 'src/supervisor/configuration/credentials/$1'],
  [/^src\/rehearsal\/(.+)$/, 'src/releases/rehearsal/$1'],
  [/^src\/cli\/(.+)$/, 'src/supervisor/cli/$1']
];

const gatewaySourceMap = Object.freeze({
  'src/canonical.js': 'src/gateway/signing/canonical.js',
  'src/catalog.js': 'src/gateway/mcp/catalog.js',
  'src/client.js': 'src/gateway/transport/client.js',
  'src/config.js': 'src/gateway/configuration/config.js',
  'src/main.js': 'src/gateway/mcp/main.js',
  'src/oauth-server.js': 'src/auth/oauth/server.js',
  'src/oauth-state-durable.js': 'src/auth/oauth/state-durable.js',
  'src/oauth.js': 'src/auth/oauth/tokens.js',
  'src/protocol.js': 'src/gateway/transport/protocol.js',
  'src/server.js': 'src/gateway/mcp/server.js',
  'src/tool.js': 'src/gateway/mcp/tool.js'
});

function renamedBasename(value) {
  return value
    .replaceAll('baby-quirt-mcp', 'se-z-gateway')
    .replaceAll('baby-quirt', 'se-z')
    .replaceAll('call_quirt', 'call_sez');
}

export function destinationFor(component, sourcePath) {
  if (component === 'supervisor') {
    for (const [pattern, replacement] of supervisorSourceRules) {
      if (pattern.test(sourcePath)) return sourcePath.replace(pattern, replacement);
    }
    if (sourcePath === 'native/src/peer_cred.cc') return 'src/native/peercred/src/peer_cred.cc';
    if (sourcePath === 'binding.gyp') return 'src/native/peercred/binding.gyp';
    if (sourcePath.startsWith('ops/systemd/')) return `packaging/systemd/${renamedBasename(path.basename(sourcePath))}`;
    if (sourcePath.startsWith('ops/tmpfiles/')) return `packaging/tmpfiles/${renamedBasename(path.basename(sourcePath))}`;
    if (sourcePath.startsWith('ops/rehearsal/')) return `packaging/rehearsal/${renamedBasename(path.basename(sourcePath))}`;
    if (sourcePath.startsWith('ops/controller/')) return `packaging/controller/${renamedBasename(sourcePath.slice('ops/controller/'.length))}`;
    if (sourcePath.startsWith('ops/bootstrap/')) return `packaging/bootstrap/${renamedBasename(sourcePath.slice('ops/bootstrap/'.length))}`;
    if (sourcePath.startsWith('scripts/')) return `scripts/extracted/supervisor/${renamedBasename(sourcePath.slice('scripts/'.length))}`;
    if (sourcePath.startsWith('schemas/')) return `test/parity/fixtures/source-contracts/supervisor/${sourcePath}`;
    if (sourcePath.startsWith('contracts/')) return `test/parity/fixtures/source-contracts/supervisor/${sourcePath}`;
  }
  if (component === 'gateway') {
    if (gatewaySourceMap[sourcePath]) return gatewaySourceMap[sourcePath];
    if (sourcePath.startsWith('ops/systemd/')) return `packaging/systemd/${renamedBasename(path.basename(sourcePath))}`;
    if (sourcePath.startsWith('ops/caddy/')) return `packaging/caddy/${renamedBasename(path.basename(sourcePath))}`;
    if (sourcePath.startsWith('ops/bootstrap/')) return `packaging/bootstrap/gateway/${renamedBasename(sourcePath.slice('ops/bootstrap/'.length))}`;
    if (sourcePath.startsWith('scripts/')) return `scripts/extracted/gateway/${renamedBasename(sourcePath.slice('scripts/'.length))}`;
    if (sourcePath.startsWith('bin/')) return `src/gateway/cli/${renamedBasename(sourcePath.slice('bin/'.length))}`;
  }
  return null;
}

export function componentFamily(component, sourcePath) {
  const p = sourcePath.toLowerCase();
  if (p.includes('protocol') || p.endsWith('/frame.ts')) return 'protocol';
  if (p.includes('canonical')) return 'canonical encoding';
  if (p.includes('peer-cred') || p.includes('peer_cred')) return p.endsWith('.cc') || p.endsWith('.gyp') ? 'native addon' : 'peer authorization';
  if (p.includes('authenticator') || p.includes('/auth/')) return 'request authentication';
  if (p.includes('signing') || p.includes('key')) return 'signatures and keys';
  if (p.includes('receipt')) return 'receipts';
  if (p.includes('replay')) return 'replay';
  if (p.includes('idempot')) return 'idempotency';
  if (p.includes('/state/') || p.includes('state-store') || p.includes('database')) return 'state storage';
  if (p.includes('/process/') || p.includes('exec')) return 'raw execution';
  if (p.includes('/jobs/') || p.includes('jobs.test')) return 'jobs';
  if (p.includes('stream')) return 'streams';
  if (p.includes('/files/') || p.includes('filesystem') || p.includes('files.test')) return 'files';
  if (p.includes('/pty/') || p.includes('pty.test')) return 'PTY';
  if (p.includes('artifact')) return 'artifacts';
  if (p.includes('skill')) return 'skills';
  if (p.includes('operation')) return 'operation registry';
  if (p.includes('release') || p.includes('deployment') || p.includes('snapshot') || p.includes('rollback')) return 'release lifecycle';
  if (p.includes('controller') || p.includes('self-host')) return 'self-hosting';
  if (p.includes('recovery') || p.includes('repair')) return 'recovery source mechanics';
  if (p.includes('github')) return 'GitHub authority';
  if (component === 'gateway' && (p.includes('server') || p.includes('tool') || p.includes('catalog') || p.includes('client'))) return 'MCP gateway';
  if (p.includes('oauth') || p.includes('login')) return 'OAuth';
  if (p.includes('config') || p.includes('.env')) return 'configuration';
  if (p.endsWith('.gyp') || p.endsWith('.cc')) return 'native addon';
  if (p.includes('/cli') || p.startsWith('bin/')) return 'CLI';
  if (p.includes('package') || p.includes('archive') || p.includes('bundle')) return 'packaging';
  if (p.includes('systemd') || p.endsWith('.service') || p.endsWith('.socket') || p.endsWith('.timer')) return 'systemd';
  if (p.includes('caddy')) return 'Caddy';
  if (p.startsWith('test/') || p.startsWith('integration/') || p.startsWith('acceptance/')) return 'tests';
  if (p.startsWith('docs/') || p.endsWith('.md') || p === 'readme.md' || p === 'agents.md' || p === 'security.md') return 'documentation';
  return 'packaging';
}

export function languageFor(sourcePath) {
  const ext = path.extname(sourcePath).toLowerCase();
  return ({
    '.ts': 'TypeScript', '.js': 'JavaScript', '.mjs': 'JavaScript', '.json': 'JSON', '.md': 'Markdown',
    '.sh': 'Shell', '.py': 'Python', '.cc': 'C++', '.gyp': 'GYP', '.yml': 'YAML', '.yaml': 'YAML',
    '.service': 'systemd unit', '.socket': 'systemd unit', '.timer': 'systemd unit', '.conf': 'configuration',
    '.pem': 'PEM public material', '.pub': 'public key', '.example': 'configuration example', '.caddyfile': 'Caddy'
  })[ext] ?? (sourcePath.endsWith('Caddyfile') ? 'Caddy' : 'text');
}

export function transformationFor(component, sourcePath) {
  const destinationPath = destinationFor(component, sourcePath);
  if (!destinationPath) return sourcePath.match(/^(test|integration|acceptance|docs)\//) || sourcePath.endsWith('.md') ? 'historical reference only' : 'historical reference only';
  if (sourcePath.startsWith('src/') || sourcePath.startsWith('native/') || sourcePath === 'binding.gyp') return 'mechanically adapted copy';
  if (sourcePath.startsWith('ops/') || sourcePath.startsWith('scripts/') || sourcePath.startsWith('bin/')) return 'mechanically renamed copy';
  if (sourcePath.startsWith('schemas/') || sourcePath.startsWith('contracts/')) return 'test fixture derived from source';
  return 'exact copy';
}

export function parityExpectationFor(family) {
  if (['protocol', 'canonical encoding', 'signatures and keys', 'receipts', 'replay', 'idempotency', 'state storage', 'raw execution', 'jobs', 'streams', 'files', 'PTY', 'artifacts', 'skills', 'operation registry', 'release lifecycle', 'GitHub authority', 'MCP gateway', 'OAuth', 'native addon'].includes(family)) return 'behavioral parity required with explicit canonical normalization';
  if (['self-hosting', 'recovery source mechanics', 'packaging', 'systemd', 'Caddy', 'CLI'].includes(family)) return 'mechanic traceability and focused parity; activation deferred';
  return 'source-reference verification';
}

export function applyMechanicalIdentity(text) {
  const replacements = [
    ['bbyquirt.call_quirt', 'call_sez'],
    ['Baby Quirt MCP', 'se-z gateway'],
    ['baby-quirt-mcp', 'se-z-gateway'],
    ['BABY_QUIRT_MCP', 'SEZ_GATEWAY'],
    ['BabyQuirt', 'Sez'],
    ['BABY_QUIRT', 'SEZ'],
    ['Baby Quirt', 'se-z'],
    ['baby-quirt', 'se-z'],
    ['call_quirt', 'call_sez'],
    ['baby.apply', 'sez.root'],
    ['QRT1', 'SEZ1'],
    ['Qrt1', 'Sez1'],
    ['/etc/baby-quirt-mcp/', '/etc/se-z-gateway/'],
    ['/etc/baby-quirt/', '/etc/se-z/'],
    ['/var/lib/baby-quirt-mcp/', '/var/lib/se-z-gateway/'],
    ['/var/lib/baby-quirt/', '/var/lib/se-z/'],
    ['/opt/baby-quirt-mcp/', '/opt/se-z/'],
    ['/opt/baby-quirt/', '/opt/se-z/'],
    ['/run/horsey/baby-quirt.sock', '/run/se-z/gateway.sock'],
    ['baby-quirt-mcp.service', 'se-z-gateway.service'],
    ['baby-quirt.service', 'se-z.service'],
    ['baby-quirt.socket', 'se-z.socket'],
    ['fix-mcp', 'se-z-gateway'],
    ['horsey', 'se-z'],
    ['https://baby-quirt.stealtheye.io', 'https://auth.se-z.stealtheye.io']
  ];
  let output = text;
  for (const [from, to] of replacements) output = output.split(from).join(to);
  output = output.replace(/\bbaby\./gu, 'sez.');
  output = output.replace(/\bBABY_/gu, 'SEZ_');
  return output;
}

export function relativeImport(fromDestination, toDestination, originalSpecifier) {
  let relative = path.posix.relative(path.posix.dirname(fromDestination), toDestination);
  if (!relative.startsWith('.')) relative = `./${relative}`;
  if (originalSpecifier.endsWith('.js') && relative.endsWith('.ts')) relative = `${relative.slice(0, -3)}.js`;
  return relative;
}

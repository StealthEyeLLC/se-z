#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'evidence/phase1/production-baseline.json'), 'utf8'));
const identity = JSON.parse(fs.readFileSync(path.join(root, 'evidence/phase1/source-identity-proof.json'), 'utf8'));
const outputPath = path.join(root, 'evidence/phase1/production-readback.json');
const writeEvidence = !process.argv.includes('--no-write');
function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
}
function sha256File(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function showUnit(unit) {
  const output = run('systemctl', ['show', unit, '--no-pager',
    '--property=ActiveState', '--property=SubState', '--property=User', '--property=Group',
    '--property=ExecStart', '--property=FragmentPath', '--property=DropInPaths']);
  return Object.fromEntries(output.split('\n').filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}
function pointer(location) {
  return fs.existsSync(location) ? run('readlink', ['-f', location]) : null;
}
function configurationFiles(units) {
  const files = new Set();
  for (const unit of Object.values(units)) {
    if (unit.FragmentPath) files.add(unit.FragmentPath);
    for (const candidate of String(unit.DropInPaths ?? '').split(' ').filter(Boolean)) files.add(candidate);
  }
  if (fs.existsSync('/etc/caddy/Caddyfile')) files.add('/etc/caddy/Caddyfile');
  return [...files].filter((file) => fs.existsSync(file)).sort().map((file) => {
    const stat = fs.statSync(file);
    return { path: file, sha256: sha256File(file), modifiedAt: stat.mtime.toISOString(), mode: `0${(stat.mode & 0o777).toString(8)}` };
  });
}
const units = Object.fromEntries(Object.keys(baseline.services).map((unit) => [unit, showUnit(unit)]));
const pointers = {
  supervisorCurrent: pointer('/opt/baby-quirt/current'),
  gatewayCurrent: pointer('/opt/baby-quirt-mcp/current'),
  gatewayPrevious: pointer('/opt/baby-quirt-mcp/previous'),
};
const socketFields = run('stat', ['-c', '%a %U %G', baseline.socket.path]).split(' ');
const socket = { path: baseline.socket.path, mode: `0${socketFields[0]}`, owner: socketFields[1], group: socketFields[2] };
const manifests = {
  supervisor: { path: identity.supervisor.installedManifest.path, sha256: sha256File(identity.supervisor.installedManifest.path) },
  gateway: { path: identity.gateway.installedManifest.path, sha256: sha256File(identity.gateway.installedManifest.path) },
};
let endpointConfigured = false;
if (fs.existsSync('/etc/caddy')) {
  const files = fs.readdirSync('/etc/caddy', { recursive: true }).map((entry) => path.join('/etc/caddy', String(entry)));
  endpointConfigured = files.some((file) => {
    try { return fs.statSync(file).isFile() && fs.readFileSync(file, 'utf8').includes('baby-quirt.stealtheye.io'); }
    catch { return false; }
  });
}
const mismatches = [];
for (const [unit, expected] of Object.entries(baseline.services)) {
  const actual = units[unit];
  for (const [key, value] of Object.entries(expected)) {
    const property = ({ activeState: 'ActiveState', subState: 'SubState', user: 'User', group: 'Group', execStart: 'ExecStart' })[key];
    if (property === undefined) continue;
    if (key === 'execStart') {
      const tokens = String(value).split(' ').filter(Boolean);
      if (!tokens.every((token) => String(actual[property] ?? '').includes(token))) mismatches.push({ field: `services.${unit}.${key}`, expected: value, actual: actual[property] });
    } else if ((actual[property] ?? '') !== value) {
      mismatches.push({ field: `services.${unit}.${key}`, expected: value, actual: actual[property] ?? null });
    }
  }
}
for (const [key, expected] of Object.entries(baseline.pointers)) {
  if (pointers[key] !== expected) mismatches.push({ field: `pointers.${key}`, expected, actual: pointers[key] });
}
for (const key of ['mode', 'owner', 'group']) {
  if (socket[key] !== baseline.socket[key]) mismatches.push({ field: `socket.${key}`, expected: baseline.socket[key], actual: socket[key] });
}
if (manifests.supervisor.sha256 !== identity.supervisor.installedManifest.sha256) mismatches.push({ field: 'manifests.supervisor.sha256', expected: identity.supervisor.installedManifest.sha256, actual: manifests.supervisor.sha256 });
if (manifests.gateway.sha256 !== identity.gateway.installedManifest.sha256) mismatches.push({ field: 'manifests.gateway.sha256', expected: identity.gateway.installedManifest.sha256, actual: manifests.gateway.sha256 });
if (!endpointConfigured) mismatches.push({ field: 'publicEndpointConfiguration', expected: baseline.publicEndpoint, actual: null });
const baselineTime = new Date(baseline.capturedAt).getTime();
const configFiles = configurationFiles(units);
const modifiedAfterBaseline = configFiles.filter((file) => new Date(file.modifiedAt).getTime() > baselineTime);
if (modifiedAfterBaseline.length > 0) mismatches.push({ field: 'configurationFiles.modifiedAfterBaseline', expected: [], actual: modifiedAfterBaseline.map((file) => file.path) });
const result = {
  schemaVersion: '1.0.0', capturedAt: new Date().toISOString(), baselineCapturedAt: baseline.capturedAt,
  inspectionMode: 'read-only service, pointer, socket, manifest, and endpoint configuration comparison',
  hostname: run('hostname', []), units, pointers, socket, manifests,
  publicEndpoint: baseline.publicEndpoint, endpointConfigured,
  configurationFiles: configFiles,
  modifiedAfterBaseline,
  routineOperationalJobStreamAndReceiptRecordsExcludedFromConfigurationEquality: true,
  secretsReadOrCaptured: false,
  mismatches,
  passed: mismatches.length === 0,
};
if (writeEvidence) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify({ mismatches, passed: result.passed }, null, 2));
if (!result.passed) process.exitCode = 1;

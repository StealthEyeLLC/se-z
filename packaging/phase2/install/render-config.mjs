#!/usr/bin/env node
import fsp from 'node:fs/promises';

const values = Object.fromEntries(process.argv.slice(2).map((entry) => {
  const separator = entry.indexOf('=');
  if (separator < 1) throw new Error(`invalid render-config argument: ${entry}`);
  return [entry.slice(0, separator), entry.slice(separator + 1)];
}));
for (const name of ['output', 'releaseDir', 'releaseId', 'sourceCommit', 'sourceTree', 'gatewayUid', 'gatewayGid']) {
  if (!values[name]) throw new Error(`missing render-config argument: ${name}`);
}
const stateRoot = '/var/lib/se-z';
const config = {
  stateRoot,
  runtimeRoot: '/run/se-z',
  localSocket: '/run/se-z/local.sock',
  gatewaySocket: '/run/se-z/gateway.sock',
  localOperatorGroup: 'se-z',
  gatewayUid: Number(values.gatewayUid),
  gatewayGid: Number(values.gatewayGid),
  gatewayExecutable: `${values.releaseDir}/runtime/bin/node`,
  gatewayId: 'se-z-gateway',
  gatewayVerificationKeys: [{ id: 'gateway-v1', path: '/etc/se-z/keys/gateway.public.pem', gatewayId: 'se-z-gateway' }],
  receiptSigningCredential: '/etc/se-z/keys/receipt.private.pem',
  receiptVerificationKeys: [{ id: 'receipt-v1', path: '/etc/se-z/keys/receipt.public.pem' }],
  authorityGenerationPath: '/var/lib/se-z-recovery/authority-generation.json',
  maximumFrameSize: 16 * 1024 * 1024,
  inlineOutputLimit: 64 * 1024,
  streamPageLimit: 1024 * 1024,
  requestMaximumAgeMs: 5 * 60 * 1000,
  requestFutureSkewMs: 30 * 1000,
  replayRetentionMs: 24 * 60 * 60 * 1000,
  jobReconciliation: 'systemd-or-process-truth',
  artifactRoot: `${stateRoot}/artifacts`,
  ptyRoot: `${stateRoot}/ptys`,
  serverId: 'se-z-supervisor',
  releaseIdentity: {
    product: 'se-z',
    releaseMilestone: '0.1A',
    candidate: values.releaseId,
    sourceCommit: values.sourceCommit,
    sourceTree: values.sourceTree,
  },
  buildIdentity: { sourceCommit: values.sourceCommit, sourceTree: values.sourceTree },
  nativeAddonPath: `${values.releaseDir}/libexec/native/peer_cred.node`,
  jobRunnerPath: `${values.releaseDir}/libexec/kernel/job-runner.mjs`,
  nodePath: `${values.releaseDir}/runtime/bin/node`,
  jobUnitPrefix: 'se-z-job',
  testMode: false,
  directBind: false,
  faultInjection: {},
};
await fsp.writeFile(values.output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o640 });

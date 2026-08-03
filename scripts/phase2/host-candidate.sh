#!/bin/bash
set -euo pipefail

package=''
evidence=''
while (($#)); do
  case "$1" in
    --package) package=$(readlink -f "$2"); shift 2 ;;
    --evidence) evidence=$(readlink -m "$2"); shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done
[[ -n $package && -f $package ]] || { echo '--package is required' >&2; exit 64; }
[[ ${EUID} -eq 0 ]] || { echo 'host-candidate must run as root' >&2; exit 77; }

started=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
root=$(mktemp -d /var/tmp/se-z-host-candidate-XXXXXX)
unit="se-z-phase2-candidate-$$.service"
job_prefix="se-z-p2-host-$$"
result_file="$root/result.json"
cleanup_result='false'
cleanup() {
  set +e
  systemctl stop "$unit" >/dev/null 2>&1
  systemctl reset-failed "$unit" >/dev/null 2>&1
  rm -f "/run/systemd/system/$unit"
  systemctl daemon-reload >/dev/null 2>&1
  for u in $(systemctl list-units --all --no-legend "${job_prefix}-*.service" 2>/dev/null | awk '{print $1}'); do
    systemctl stop "$u" >/dev/null 2>&1
    systemctl reset-failed "$u" >/dev/null 2>&1
  done
  if [[ -n $evidence && -f $result_file ]]; then
    install -d -m 0755 "$(dirname "$evidence")"
    cp "$result_file" "$evidence"
  fi
  rm -rf "$root"
  if ! systemctl list-units --all --no-legend "$unit" 2>/dev/null | grep -q . && [[ ! -e /run/systemd/system/$unit ]]; then cleanup_result='true'; fi
}
trap cleanup EXIT

mkdir -p "$root/package" "$root/state" "$root/run" "$root/recovery" "$root/keys"
tar -xzf "$package" -C "$root/package"
manifest="$root/package/manifest.json"
node="$root/package/payload/runtime/bin/node"
[[ -x $node && -f $manifest ]] || { echo 'invalid candidate package' >&2; exit 65; }
"$node" --version | grep -qx 'v24.18.0'
sha256sum -c "$root/package/SHA256SUMS" --ignore-missing >/dev/null
openssl genpkey -algorithm ED25519 -out "$root/keys/receipt.private.pem" >/dev/null 2>&1
openssl pkey -in "$root/keys/receipt.private.pem" -pubout -out "$root/keys/receipt.public.pem" >/dev/null 2>&1
openssl genpkey -algorithm ED25519 -out "$root/keys/gateway.private.pem" >/dev/null 2>&1
openssl pkey -in "$root/keys/gateway.private.pem" -pubout -out "$root/keys/gateway.public.pem" >/dev/null 2>&1
chmod 0600 "$root/keys/"*.private.pem
cat > "$root/recovery/authority-generation.json" <<JSON
{"schemaVersion":1,"authorityGeneration":1,"owner":"se-z-recovery","initializedAt":"$started","bootstrapRole":"phase2-host-candidate"}
JSON
source_commit=$("$node" -e "process.stdout.write(require(process.argv[1]).sourceCommit)" "$manifest")
source_tree=$("$node" -e "process.stdout.write(require(process.argv[1]).sourceTree)" "$manifest")
release_id=$("$node" -e "process.stdout.write(require(process.argv[1]).releaseId)" "$manifest")
cat > "$root/config.json" <<JSON
{
  "stateRoot":"$root/state",
  "runtimeRoot":"$root/run",
  "localSocket":"$root/run/local.sock",
  "gatewaySocket":"$root/run/gateway.sock",
  "localOperatorGroup":"root",
  "gatewayUid":65534,
  "gatewayGid":65534,
  "gatewayExecutable":"$node",
  "gatewayId":"se-z-gateway",
  "gatewayVerificationKeys":[{"id":"gateway-v1","path":"$root/keys/gateway.public.pem","gatewayId":"se-z-gateway"}],
  "receiptSigningCredential":"$root/keys/receipt.private.pem",
  "receiptVerificationKeys":[{"id":"receipt-v1","path":"$root/keys/receipt.public.pem"}],
  "authorityGenerationPath":"$root/recovery/authority-generation.json",
  "maximumFrameSize":16777216,
  "inlineOutputLimit":65536,
  "streamPageLimit":1048576,
  "requestMaximumAgeMs":300000,
  "requestFutureSkewMs":30000,
  "replayRetentionMs":86400000,
  "jobReconciliation":"systemd-or-process-truth",
  "artifactRoot":"$root/state/artifacts",
  "ptyRoot":"$root/state/ptys",
  "serverId":"se-z-phase2-host-candidate",
  "releaseIdentity":{"product":"se-z","releaseMilestone":"0.1A","candidate":"$release_id","sourceCommit":"$source_commit","sourceTree":"$source_tree"},
  "buildIdentity":{"sourceCommit":"$source_commit","sourceTree":"$source_tree"},
  "nativeAddonPath":"$root/package/payload/libexec/native/peer_cred.node",
  "jobRunnerPath":"$root/package/payload/libexec/kernel/job-runner.mjs",
  "nodePath":"$node",
  "jobUnitPrefix":"$job_prefix",
  "testMode":false,
  "directBind":true,
  "faultInjection":{}
}
JSON
cat > "/run/systemd/system/$unit" <<UNIT
[Unit]
Description=se-z Phase 2 isolated host candidate
After=local-fs.target
[Service]
Type=simple
User=root
Group=root
Environment=SEZ_CONFIG=$root/config.json
ExecStart=$node $root/package/payload/libexec/bin/se-z-supervisor.mjs
Restart=on-failure
RestartSec=250ms
KillMode=process
TimeoutStopSec=15s
UNIT
systemctl daemon-reload
systemctl start "$unit"
for _ in $(seq 1 200); do [[ -S $root/run/local.sock ]] && break; sleep .05; done
[[ -S $root/run/local.sock ]] || { systemctl status "$unit" --no-pager >&2; exit 70; }

cat > "$root/accept.mjs" <<'NODE'
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SezClient } from './package/payload/libexec/kernel/client.mjs';
import { loadPublicKey, verifyReceipt } from './package/payload/libexec/kernel/crypto.mjs';
const execFileAsync=promisify(execFile);
const root=process.argv[2]; const unit=process.argv[3]; const packageSha=process.argv[4];
const socket=`${root}/run/local.sock`; const client=new SezClient({socketPath:socket,clientId:'phase2-host-candidate'});
const checks=[]; const check=(name,detail={})=>checks.push({name,passed:true,detail});
async function terminal(jobId,timeout=120000){const end=Date.now()+timeout; while(Date.now()<end){const r=(await client.call('sez.job.wait',{jobId,waitMs:1000})).response;if(r.terminal)return r;}throw new Error(`timeout ${jobId}`)}
async function readAll(jobId,stream){let off=0;const h=crypto.createHash('sha256');let pages=0;for(;;){const r=(await client.call('sez.job.stream.read',{jobId,stream,offset:off,length:1048576})).response;assert.equal(r.error,null);const b=Buffer.from(r.result.data,'base64');h.update(b);off=r.result.nextOffset;pages++;if(r.result.endOfStream)return {bytes:off,sha256:h.digest('hex'),pages,descriptor:r.result};if(b.length===0)throw new Error('zero page before EOF')}}
const description=(await client.call('sez.describe')).response; assert.equal(description.result.product,'se-z'); check('candidate describe',{catalogDigest:description.catalogDigest});
const launch=(await client.call('sez.exec',{argv:['/usr/bin/id','-u']},{idempotencyKey:'host-candidate-root-proof'})).response;const done=await terminal(launch.jobId);const out=await readAll(launch.jobId,'stdout');const err=await readAll(launch.jobId,'stderr');assert.equal(done.state,'completed');assert.equal(done.result.job.exitCode,0);assert.equal(out.bytes,2);assert.equal(err.bytes,0);assert.equal(out.sha256,'9a271f2a916b0b261fe3913bc911e89392a7d04d47b2140745739e6de9551fcb');const key=await loadPublicKey(`${root}/keys/receipt.public.pem`);const receiptCheck=verifyReceipt(done.receipt,new Map([['receipt-v1',key]]));assert.equal(receiptCheck.valid,true);check('uid-0 exact execution and receipt',{requestId:launch.requestId,jobId:launch.jobId,receiptId:done.receipt.receiptId,stdoutSha256:out.sha256});
const shell=(await client.call('sez.shell',{command:'printf host-shell-ok'})).response;const shellDone=await terminal(shell.jobId);const shellOut=await readAll(shell.jobId,'stdout');assert.equal(shellDone.state,'completed');assert.equal(shellOut.bytes,13);check('arbitrary shell',{jobId:shell.jobId});
const file=`${root}/host-file.bin`;const bytes=crypto.randomBytes(4096);let r=(await client.call('sez.file.write',{path:file,data:bytes.toString('base64'),encoding:'base64',truncate:true,flush:true})).response;assert.equal(r.error,null);r=(await client.call('sez.file.read',{path:file,offset:0,length:4096,encoding:'base64'})).response;assert.deepEqual(Buffer.from(r.result.data,'base64'),bytes);await client.call('sez.file.remove',{path:file});check('temporary file lifecycle',{sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
const restart=(await client.call('sez.shell',{command:'sleep 2; printf durable-after-restart'})).response;await execFileAsync('/usr/bin/systemctl',['restart',unit]);for(let i=0;i<200;i++){try{await fsp.stat(socket);break}catch{await new Promise(r=>setTimeout(r,50))}}const restartClient=new SezClient({socketPath:socket,clientId:'phase2-host-candidate-restart'});let restartDone;const end=Date.now()+120000;while(Date.now()<end){restartDone=(await restartClient.call('sez.job.wait',{jobId:restart.jobId,waitMs:1000})).response;if(restartDone.terminal)break;}assert.equal(restartDone.state,'completed');const restartOut=await (async()=>{let off=0,h=crypto.createHash('sha256'),bytes=0;for(;;){const x=(await restartClient.call('sez.job.stream.read',{jobId:restart.jobId,stream:'stdout',offset:off,length:1048576})).response.result;const b=Buffer.from(x.data,'base64');h.update(b);bytes+=b.length;off=x.nextOffset;if(x.endOfStream)return {bytes,sha256:h.digest('hex')}}})();assert.equal(restartOut.bytes,21);check('durable job across supervisor restart',{jobId:restart.jobId,sha256:restartOut.sha256});
const lostKey='host-candidate-response-loss';const disconnected=await restartClient.call('sez.exec',{argv:['/bin/bash','-lc','sleep 1; printf response-loss-ok']},{idempotencyKey:lostKey,disconnectAfterSend:true});await new Promise(r=>setTimeout(r,1500));const resume=(await restartClient.call('sez.request.resume',{operation:'sez.exec',idempotencyKey:lostKey,payload:{argv:['/bin/bash','-lc','sleep 1; printf response-loss-ok']},target:'host'})).response;assert.equal(resume.error,null);assert.equal(resume.result.originalRequestId,disconnected.request.requestId);assert.ok(resume.result.originalResponse.job.jobId);check('deterministic response-loss resume',{requestId:disconnected.request.requestId,jobId:resume.result.originalResponse.job.jobId});
const size=70*1024*1024+17;const generator=`const n=${size};const b=Buffer.alloc(1048576,0x5a);let w=0;while(w<n){const c=Math.min(b.length,n-w);process.stdout.write(b.subarray(0,c));w+=c}process.stderr.write('host-large-stderr\\n')`;const large=(await restartClient.call('sez.exec',{argv:[process.execPath,'-e',generator]})).response;const largeDone=await terminal.call(null,large.jobId,240000).catch(async()=>{const c=new SezClient({socketPath:socket});const e=Date.now()+240000;while(Date.now()<e){const q=(await c.call('sez.job.wait',{jobId:large.jobId,waitMs:1000})).response;if(q.terminal)return q}throw new Error('large timeout')});assert.equal(largeDone.state,'completed');async function readWith(c,stream){let off=0,h=crypto.createHash('sha256'),pages=0;for(;;){const q=(await c.call('sez.job.stream.read',{jobId:large.jobId,stream,offset:off,length:1048576})).response.result;const b=Buffer.from(q.data,'base64');h.update(b);off=q.nextOffset;pages++;if(q.endOfStream)return {bytes:off,sha256:h.digest('hex'),pages}}}const largeOut=await readWith(restartClient,'stdout');const largeErr=await readWith(restartClient,'stderr');assert.equal(largeOut.bytes,size);assert.ok(largeErr.bytes>0);check('large output paged and independently hashed',{jobId:large.jobId,stdout:largeOut,stderr:largeErr});
const result={schemaVersion:1,kind:'phase2-host-candidate',startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),passed:true,checks,checkCount:checks.length,packageSha256:packageSha,sourceCommit:description.result.buildSourceCommit,sourceTree:description.result.buildSourceTree,catalogDigest:description.catalogDigest,kernel:process.platform,rootProof:{command:'/usr/bin/id -u',exitCode:done.result.job.exitCode,stdout:'0\\n',stderr:'',requestId:launch.requestId,jobId:launch.jobId,receiptId:done.receipt.receiptId,receiptVerified:receiptCheck.valid},supervisorRestarts:1,largeOutputBytes:largeOut.bytes,largeOutputSha256:largeOut.sha256};await fsp.writeFile(`${root}/result.json`,`${JSON.stringify(result,null,2)}\n`);process.stdout.write(`${JSON.stringify(result)}\n`);
NODE
package_sha=$(sha256sum "$package" | awk '{print $1}')
"$node" "$root/accept.mjs" "$root" "$unit" "$package_sha"
systemctl is-active --quiet "$unit"
# copy evidence before trap removes the candidate
if [[ -n $evidence ]]; then install -d -m 0755 "$(dirname "$evidence")"; cp "$result_file" "$evidence"; fi
trap - EXIT
cleanup
[[ $cleanup_result == true ]] || { echo 'candidate cleanup failed' >&2; exit 1; }
if [[ -n $evidence ]]; then
  "$node" -e "const fs=require('fs');const p=process.argv[1];const d=JSON.parse(fs.readFileSync(p));d.cleanup={passed:true,unit:'$unit',rootRemoved:true};fs.writeFileSync(p,JSON.stringify(d,null,2)+'\\n')" "$evidence"
fi
printf '{"passed":true,"kind":"phase2-host-candidate","evidence":"%s"}\n' "$evidence"

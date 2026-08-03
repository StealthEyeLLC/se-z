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
[[ ${EUID} -eq 0 ]] || { echo 'nspawn acceptance must run as root' >&2; exit 77; }
for command in systemd-nspawn machinectl debootstrap systemd-run; do command -v "$command" >/dev/null || { echo "missing $command" >&2; exit 69; }; done

started=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
name="sez-p2-$$-$RANDOM"
rootfs="/var/lib/machines/$name"
outer_unit="se-z-nspawn-$name.service"
base=/var/cache/se-z/nspawn-noble-base
work=$(mktemp -d /var/tmp/se-z-nspawn-accept-XXXXXX)
result="$work/result.json"
cleanup_passed=false
cleanup() {
  set +e
  machinectl terminate "$name" >/dev/null 2>&1
  systemctl stop "$outer_unit" >/dev/null 2>&1
  systemctl reset-failed "$outer_unit" >/dev/null 2>&1
  rm -rf "$rootfs" "$work"
  if ! machinectl list --no-legend --no-pager 2>/dev/null | awk '{print $1}' | grep -qx "$name" && [[ ! -e $rootfs ]]; then cleanup_passed=true; fi
}
trap cleanup EXIT

if [[ ! -f $base/etc/os-release ]]; then
  mkdir -p "$(dirname "$base")"
  temp_base="${base}.tmp.$$"
  rm -rf "$temp_base"
  debootstrap --variant=minbase --include=systemd,systemd-sysv,dbus,ca-certificates,openssl,tmux,passwd,util-linux,procps,iproute2 noble "$temp_base" http://archive.ubuntu.com/ubuntu
  rm -f "$temp_base/etc/machine-id"
  : > "$temp_base/etc/machine-id"
  rm -rf "$base"
  mv "$temp_base" "$base"
fi
rm -rf "$rootfs"
mkdir -p "$rootfs"
cp -a --reflink=auto "$base/." "$rootfs/"
printf '%s\n' "$name" > "$rootfs/etc/hostname"
rm -f "$rootfs/etc/machine-id"
: > "$rootfs/etc/machine-id"
mkdir -p "$rootfs/root/candidate"
cp "$package" "$rootfs/root/candidate/candidate.tar.gz"

cat > "$rootfs/root/candidate/pre.mjs" <<'NODE'
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SezClient } from 'file:///opt/se-z/current/libexec/kernel/client.mjs';
const execFileAsync=promisify(execFile); const client=new SezClient({socketPath:'/run/se-z/local.sock',clientId:'phase2-nspawn-pre'}); const checks=[]; const check=(name,detail={})=>checks.push({name,passed:true,detail});
async function terminal(jobId,timeout=240000){const end=Date.now()+timeout;while(Date.now()<end){const r=(await client.call('sez.job.wait',{jobId,waitMs:1000})).response;if(r.terminal)return r}throw new Error(`timeout ${jobId}`)}
async function stream(jobId,which){let offset=0,h=crypto.createHash('sha256'),pages=0;for(;;){const r=(await client.call('sez.job.stream.read',{jobId,stream:which,offset,length:1048576})).response;assert.equal(r.error,null);const b=Buffer.from(r.result.data,'base64');h.update(b);offset=r.result.nextOffset;pages++;if(r.result.endOfStream)return {bytes:offset,sha256:h.digest('hex'),pages};if(!b.length)throw new Error('empty page')}}
const describe=(await client.call('sez.describe')).response;assert.equal(describe.result.product,'se-z');assert.equal(describe.result.activeOperations.length,41);check('exact installed catalog',{catalogDigest:describe.catalogDigest});
const root=(await client.call('sez.exec',{argv:['/usr/bin/id','-u']},{idempotencyKey:'nspawn-root-proof'})).response;const rootDone=await terminal(root.jobId);const rootOut=await stream(root.jobId,'stdout');const rootErr=await stream(root.jobId,'stderr');assert.equal(rootDone.result.job.exitCode,0);assert.equal(rootOut.sha256,'9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa');assert.equal(rootErr.bytes,0);check('uid-0 execution',{requestId:root.requestId,jobId:root.jobId,receiptId:rootDone.receipt.receiptId});
const fileBytes=crypto.randomBytes(8192);await client.call('sez.file.write',{path:'/root/nspawn-file.bin',data:fileBytes.toString('base64'),encoding:'base64',truncate:true,flush:true});const fileRead=(await client.call('sez.file.read',{path:'/root/nspawn-file.bin',offset:0,length:fileBytes.length,encoding:'base64'})).response;assert.deepEqual(Buffer.from(fileRead.result.data,'base64'),fileBytes);await client.call('sez.file.remove',{path:'/root/nspawn-file.bin'});check('file lifecycle',{sha256:crypto.createHash('sha256').update(fileBytes).digest('hex')});
const artifactBytes=crypto.randomBytes(1024*1024+37);const artifactHash=crypto.createHash('sha256').update(artifactBytes).digest('hex');let a=(await client.call('sez.artifact.begin',{name:'nspawn.bin',size:artifactBytes.length,sha256:artifactHash})).response.result;for(let o=0;o<artifactBytes.length;o+=262144){const b=artifactBytes.subarray(o,Math.min(o+262144,artifactBytes.length));await client.call('sez.artifact.upload',{artifactId:a.artifactId,offset:o,data:b.toString('base64'),encoding:'base64'})}a=(await client.call('sez.artifact.finalize',{artifactId:a.artifactId})).response.result;assert.equal(a.actualSha256,artifactHash);check('artifact finalized',{artifactId:a.artifactId,sha256:artifactHash});
const pty=(await client.call('sez.pty.create',{shell:'/bin/bash',shellArgs:['--noprofile','--norc'],cwd:'/root'})).response.result;await new Promise(r=>setTimeout(r,250));await client.call('sez.pty.input',{sessionId:pty.sessionId,data:Buffer.from('printf nspawn-pty-before-restart\\n').toString('base64'),encoding:'base64'});await execFileAsync('/usr/bin/systemctl',['restart','se-z.service']);await new Promise(r=>setTimeout(r,500));const client2=new SezClient({socketPath:'/run/se-z/local.sock',clientId:'phase2-nspawn-after-supervisor-restart'});const ptyRead=(await client2.call('sez.pty.read',{sessionId:pty.sessionId,offset:0,length:1048576})).response;assert.equal(ptyRead.error,null);assert.ok(Buffer.from(ptyRead.result.data,'base64').includes(Buffer.from('nspawn-pty-before-restart')));check('PTY survives supervisor restart',{sessionId:pty.sessionId});
const durable=(await client2.call('sez.shell',{command:'sleep 2; printf nspawn-durable-restart'})).response;await execFileAsync('/usr/bin/systemctl',['restart','se-z.service']);await new Promise(r=>setTimeout(r,500));const client3=new SezClient({socketPath:'/run/se-z/local.sock',clientId:'phase2-nspawn-reconcile'});let durableDone;const deadline=Date.now()+120000;while(Date.now()<deadline){durableDone=(await client3.call('sez.job.wait',{jobId:durable.jobId,waitMs:1000})).response;if(durableDone.terminal)break}assert.equal(durableDone.state,'completed');check('durable job across supervisor restart',{jobId:durable.jobId});
const lossKey='nspawn-response-loss';const lost=await client3.call('sez.exec',{argv:['/bin/bash','-lc','sleep 1; printf nspawn-response-loss']},{idempotencyKey:lossKey,disconnectAfterSend:true});await new Promise(r=>setTimeout(r,1500));const resumed=(await client3.call('sez.request.resume',{operation:'sez.exec',idempotencyKey:lossKey,payload:{argv:['/bin/bash','-lc','sleep 1; printf nspawn-response-loss']},target:'host'})).response;assert.equal(resumed.result.originalRequestId,lost.request.requestId);assert.ok(resumed.result.originalResponse.jobId);check('response loss resumes exactly',{requestId:lost.request.requestId,jobId:resumed.result.originalResponse.jobId});
const largeSize=67*1024*1024+31;const generator=`const n=${largeSize};const b=Buffer.alloc(1048576,0x4e);let w=0;while(w<n){const c=Math.min(b.length,n-w);process.stdout.write(b.subarray(0,c));w+=c}process.stderr.write('nspawn-large-stderr\\n')`;const large=(await client3.call('sez.exec',{argv:['/opt/se-z/current/runtime/bin/node','-e',generator]})).response;const largeDone=await (async()=>{const e=Date.now()+240000;while(Date.now()<e){const q=(await client3.call('sez.job.wait',{jobId:large.jobId,waitMs:1000})).response;if(q.terminal)return q}throw new Error('large timeout')})();assert.equal(largeDone.state,'completed');async function readLarge(which){let offset=0,h=crypto.createHash('sha256'),pages=0;for(;;){const q=(await client3.call('sez.job.stream.read',{jobId:large.jobId,stream:which,offset,length:1048576})).response.result;const b=Buffer.from(q.data,'base64');h.update(b);offset=q.nextOffset;pages++;if(q.endOfStream)return{bytes:offset,sha256:h.digest('hex'),pages}}}const largeOut=await readLarge('stdout');const largeErr=await readLarge('stderr');assert.equal(largeOut.bytes,largeSize);assert.ok(largeErr.bytes>0);check('more than 64 MiB output read and hashed',{jobId:large.jobId,stdout:largeOut,stderr:largeErr});
const state={schemaVersion:1,kind:'phase2-nspawn-pre',passed:true,checks,checkCount:checks.length,catalogDigest:describe.catalogDigest,sourceCommit:describe.result.buildSourceCommit,sourceTree:describe.result.buildSourceTree,rootProof:{requestId:root.requestId,jobId:root.jobId,receiptId:rootDone.receipt.receiptId,exitCode:rootDone.result.job.exitCode,stdout:'0\\n',stderr:''},artifactId:a.artifactId,artifactSha256:artifactHash,ptySessionId:pty.sessionId,completedJobId:root.jobId,completedRequestId:root.requestId,responseLossRequestId:lost.request.requestId,responseLossJobId:resumed.result.originalResponse.jobId,largeOutput:{jobId:large.jobId,stdout:largeOut,stderr:largeErr},supervisorRestarts:2};await fsp.writeFile('/var/lib/se-z/reconciliation/nspawn-acceptance-state.json',`${JSON.stringify(state,null,2)}\n`);await fsp.writeFile('/root/nspawn-pre.json',`${JSON.stringify(state,null,2)}\n`);process.stdout.write(`${JSON.stringify(state)}\n`);
NODE

cat > "$rootfs/root/candidate/post.mjs" <<'NODE'
import assert from 'node:assert/strict';import crypto from 'node:crypto';import fsp from 'node:fs/promises';import { SezClient } from 'file:///opt/se-z/current/libexec/kernel/client.mjs';
const previous=JSON.parse(await fsp.readFile('/var/lib/se-z/reconciliation/nspawn-acceptance-state.json','utf8'));const client=new SezClient({socketPath:'/run/se-z/local.sock',clientId:'phase2-nspawn-post'});const checks=[];const check=(name,detail={})=>checks.push({name,passed:true,detail});
const job=(await client.call('sez.job.get',{jobId:previous.completedJobId})).response;assert.equal(job.state,'completed');check('completed job persists across reboot',{jobId:previous.completedJobId});
const resume=(await client.call('sez.request.resume',{requestId:previous.completedRequestId})).response;assert.equal(resume.result.originalRequestId,previous.completedRequestId);assert.equal(resume.result.originalResponse.state,'completed');check('request and idempotency state persist across reboot',{requestId:previous.completedRequestId});
let offset=0,h=crypto.createHash('sha256');for(;;){const r=(await client.call('sez.artifact.download',{artifactId:previous.artifactId,offset,length:1048576})).response.result;const b=Buffer.from(r.data,'base64');h.update(b);offset=r.nextOffset;if(r.endOfArtifact)break}assert.equal(h.digest('hex'),previous.artifactSha256);check('artifact persists and independently hashes',{artifactId:previous.artifactId,sha256:previous.artifactSha256});
const pty=(await client.call('sez.pty.read',{sessionId:previous.ptySessionId,offset:0,length:1048576})).response;assert.equal(pty.error,null);assert.equal(pty.result.terminal,true);assert.ok(['lost','closed','failed'].includes(pty.result.state));check('PTY reboot boundary reconciles honestly',{sessionId:previous.ptySessionId,state:pty.result.state});
const health=(await client.call('sez.health')).response;assert.equal(health.result.healthy,true);check('service and sockets healthy after reboot');
const result={schemaVersion:1,kind:'phase2-nspawn-post-reboot',passed:true,checks,checkCount:checks.length,previous};await fsp.writeFile('/root/nspawn-post.json',`${JSON.stringify(result,null,2)}\n`);process.stdout.write(`${JSON.stringify(result)}\n`);
NODE

systemd-run --unit="$outer_unit" --property=Delegate=yes --collect /usr/bin/systemd-nspawn --quiet --boot --register=yes --settings=no --machine="$name" --directory="$rootfs"
ready=false
for _ in $(seq 1 900); do
  state=$(machinectl show "$name" -p State --value 2>/dev/null || true)
  if [[ $state == running ]] && machinectl shell --quiet "$name" /bin/test -S /run/dbus/system_bus_socket >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep .1
done
[[ $ready == true ]] || { journalctl -u "$outer_unit" --no-pager -n 200 >&2; exit 70; }
boot_before=$(machinectl shell --quiet "$name" /bin/cat /proc/sys/kernel/random/boot_id 2>/dev/null | tr -d '\r\n')
[[ $boot_before =~ ^[0-9a-f-]{36}$ ]] || { echo "invalid initial boot ID: $boot_before" >&2; exit 70; }
mkdir -p "$work/evidence"
machinectl shell --quiet "$name" /bin/bash -lc 'set -euo pipefail; rm -rf /root/candidate/unpacked; mkdir -p /root/candidate/unpacked; tar -xzf /root/candidate/candidate.tar.gz -C /root/candidate/unpacked; /root/candidate/unpacked/install/install-package'
machinectl shell --quiet "$name" /usr/local/sbin/se-z-verify-install --evidence /root/install-verify-before.json
cp "$rootfs/root/install-verify-before.json" "$work/evidence/install-verify-before.json"
if ! machinectl shell --quiet "$name" /opt/se-z/current/runtime/bin/node /root/candidate/pre.mjs >"$work/pre.stdout" 2>"$work/pre.stderr"; then
  cat "$work/pre.stdout" >&2
  cat "$work/pre.stderr" >&2
  exit 71
fi
cat "$work/pre.stdout"
test -s "$rootfs/root/nspawn-pre.json" || { echo 'pre-reboot evidence was not written' >&2; cat "$work/pre.stderr" >&2; exit 71; }
cp "$rootfs/root/nspawn-pre.json" "$work/evidence/nspawn-pre.json"
machinectl reboot "$name"
for _ in $(seq 1 900); do
  state=$(machinectl show "$name" -p State --value 2>/dev/null || true)
  boot_after=$(machinectl shell --quiet "$name" /bin/cat /proc/sys/kernel/random/boot_id 2>/dev/null | tr -d '\r\n' || true)
  [[ $state == running && $boot_after =~ ^[0-9a-f-]{36}$ && $boot_after != "$boot_before" ]] && break
  sleep .2
done
[[ -n ${boot_after:-} && $boot_after != "$boot_before" ]] || { echo 'nspawn reboot did not complete' >&2; exit 70; }
if ! machinectl shell --quiet "$name" /opt/se-z/current/runtime/bin/node /root/candidate/post.mjs >"$work/post.stdout" 2>"$work/post.stderr"; then
  cat "$work/post.stdout" >&2
  cat "$work/post.stderr" >&2
  exit 72
fi
cat "$work/post.stdout"
test -s "$rootfs/root/nspawn-post.json" || { echo 'post-reboot evidence was not written' >&2; cat "$work/post.stderr" >&2; exit 72; }
cp "$rootfs/root/nspawn-post.json" "$work/evidence/nspawn-post.json"
machinectl shell --quiet "$name" /usr/local/sbin/se-z-verify-install --evidence /root/install-verify-after.json
cp "$rootfs/root/install-verify-after.json" "$work/evidence/install-verify-after.json"
os_release=$(cat "$rootfs/etc/os-release")
systemd_version=$(machinectl shell "$name" /usr/bin/systemd --version 2>/dev/null | head -n1 | tr -d '\r')
node_version=$(machinectl shell "$name" /opt/se-z/current/runtime/bin/node --version 2>/dev/null | tr -d '\r\n')
package_sha=$(sha256sum "$package" | awk '{print $1}')
socket_meta=$(machinectl shell "$name" /usr/bin/stat -c '%n %U %G %a %F' /run/se-z/local.sock /run/se-z/gateway.sock 2>/dev/null | tr -d '\r')
unit_status=$(machinectl shell "$name" /usr/bin/systemctl is-active se-z.service se-z-local.socket se-z-gateway.socket 2>/dev/null | tr -d '\r')
python3 - "$result" "$started" "$name" "$package_sha" "$systemd_version" "$node_version" "$boot_before" "$boot_after" "$socket_meta" "$unit_status" "$os_release" "$work/evidence" <<'PY'
import json,sys,os,hashlib,platform
out,started,name,pkg,systemd,node,boot1,boot2,sockets,units,osrel,edir=sys.argv[1:]
def load(n):
 p=os.path.join(edir,n);return json.load(open(p))
components={n:load(n) for n in ['install-verify-before.json','nspawn-pre.json','nspawn-post.json','install-verify-after.json']}
result={'schemaVersion':1,'kind':'phase2-nspawn-acceptance','startedAt':started,'completedAt':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),'passed':all(v.get('passed') is True for v in components.values()) and boot1!=boot2,'machine':name,'machineImageIdentity':hashlib.sha256(osrel.encode()).hexdigest(),'osRelease':osrel,'hostKernel':platform.release(),'systemdVersion':systemd,'nodeVersion':node,'candidateSha256':pkg,'unitStatus':units.splitlines(),'socketMetadata':sockets.splitlines(),'bootBefore':boot1,'bootAfter':boot2,'reboots':1,'components':components}
open(out,'w').write(json.dumps(result,indent=2)+'\n')
PY
if [[ -n $evidence ]]; then install -d -m 0755 "$(dirname "$evidence")"; cp "$result" "$evidence"; fi
trap - EXIT
cleanup
[[ $cleanup_passed == true ]] || { echo 'nspawn cleanup failed' >&2; exit 1; }
if [[ -n $evidence ]]; then python3 - "$evidence" "$name" <<'PY'
import json,sys
p=sys.argv[1];d=json.load(open(p));d['cleanup']={'passed':True,'machine':sys.argv[2],'rootRemoved':True};open(p,'w').write(json.dumps(d,indent=2)+'\n')
PY
fi
printf '{"passed":true,"kind":"phase2-nspawn-acceptance","machine":"%s","evidence":"%s"}\n' "$name" "$evidence"

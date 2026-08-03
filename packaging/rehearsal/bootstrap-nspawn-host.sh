#!/bin/bash
# Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
# One-time, exact bootstrap for the disposable se-z host-certification pool.

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

CONFIRM='--confirm-create-sezcert-v1'
ROOT='/var/lib/se-z-nspawn'
POOL='sezcert'
VDEV="$ROOT/pool/sezcert.vdev"
BASE_DATASET="$POOL/base/noble"
BASE_SNAPSHOT="$BASE_DATASET@golden-v1"
RUNS_DATASET="$POOL/runs"
BASE_MOUNT="$ROOT/base/noble"
HOST_NODE='/opt/node-v24.18.0-linux-x64'
CONFIG_ROOT='/etc/se-z-nspawn'
RUNNER_ROOT='/usr/local/lib/se-z-nspawn'
RUNNER_BIN='/usr/local/sbin/se-z-nspawn-runner'
POOL_BYTES=12884901888
HOST_RESERVE_BYTES=15032385536
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
SOURCE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd -P)
CREATED_POOL=0
CREATED_ROOT=0
CREATED_CONFIG=0
CREATED_RUNNER=0

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_file() {
  test -f "$1" && test ! -L "$1" || fail "missing or linked bootstrap input: $1"
}

validate_payload() {
  for path in \
    "$SCRIPT_DIR/se-z-host-certification.mjs" \
    "$SCRIPT_DIR/se-z-peer-cred-probe.py" \
    "$SCRIPT_DIR/se-z-host-certification.service" \
    "$SCRIPT_DIR/se-z-nspawn-runner" \
    "$SOURCE_ROOT/dist/src/rehearsal/nspawn-cli.js" \
    "$SOURCE_ROOT/dist/src/rehearsal/nspawn-contract.js" \
    "$SOURCE_ROOT/dist/src/rehearsal/nspawn-executor.js" \
    "$SOURCE_ROOT/dist/src/rehearsal/nspawn-runner.js" \
    "$SOURCE_ROOT/dist/src/crypto/canonical.js" \
    "$SOURCE_ROOT/dist/src/crypto/signing.js"
  do
    require_file "$path"
  done
}

safe_owned_directory() {
  path=$1
  test -d "$path" && test ! -L "$path" || fail "unsafe owned directory: $path"
  test "$(readlink -f -- "$path")" = "$path" || fail "non-canonical owned directory: $path"
  test "$(stat -c %u -- "$path")" -eq 0 || fail "non-root owned directory: $path"
  mode=$(stat -c %a -- "$path")
  test "$((8#$mode & 8#22))" -eq 0 || fail "writable owned directory: $path"
}

owned_marker() {
  marker=$1
  test -f "$marker" && test ! -L "$marker" || fail "missing ownership marker: $marker"
  test "$(cat -- "$marker")" = 'se-z-nspawn-v1' || fail "invalid ownership marker: $marker"
}

atomic_install() {
  mode=$1
  source=$2
  target=$3
  temporary="$target.new.$$"
  rm -f -- "$temporary"
  install -o root -g root -m "$mode" "$source" "$temporary"
  mv -fT -- "$temporary" "$target"
}

install_runner_payload() {
  install -d -o root -g root -m 0755 \
    "$RUNNER_ROOT" \
    "$RUNNER_ROOT/dist" \
    "$RUNNER_ROOT/dist/src" \
    "$RUNNER_ROOT/dist/src/rehearsal" \
    "$RUNNER_ROOT/dist/src/crypto" \
    "$RUNNER_ROOT/ops" \
    "$RUNNER_ROOT/ops/rehearsal"
  printf 'se-z-nspawn-v1\n' > "$RUNNER_ROOT/.bootstrap-owned"
  chmod 0644 "$RUNNER_ROOT/.bootstrap-owned"
  for name in nspawn-cli nspawn-contract nspawn-executor nspawn-runner; do
    atomic_install 0644 \
      "$SOURCE_ROOT/dist/src/rehearsal/$name.js" \
      "$RUNNER_ROOT/dist/src/rehearsal/$name.js"
  done
  for name in canonical signing; do
    atomic_install 0644 \
      "$SOURCE_ROOT/dist/src/crypto/$name.js" \
      "$RUNNER_ROOT/dist/src/crypto/$name.js"
  done
  atomic_install 0755 \
    "$SCRIPT_DIR/se-z-host-certification.mjs" \
    "$RUNNER_ROOT/ops/rehearsal/se-z-host-certification.mjs"
  atomic_install 0755 "$SCRIPT_DIR/se-z-nspawn-runner" "$RUNNER_BIN"
}

already_bootstrapped() {
  test -f "$CONFIG_ROOT/bootstrap.json" || return 1
  command -v zpool >/dev/null 2>&1 || fail 'bootstrap marker exists but zpool is unavailable'
  command -v systemd-nspawn >/dev/null 2>&1 || fail 'bootstrap marker exists but systemd-nspawn is unavailable'
  test "$(zpool list -H -o health "$POOL")" = 'ONLINE' || fail 'existing sezcert pool is not ONLINE'
  test "$(zfs list -H -o type "$BASE_SNAPSHOT")" = 'snapshot' || fail 'golden snapshot is missing'
  test "$(zfs get -H -o value readonly "$BASE_DATASET")" = 'on' || fail 'golden base is not read-only'
  test -x "$RUNNER_BIN" || fail 'fixed nspawn runner is missing'
  test -s "$CONFIG_ROOT/evidence-private.pem" || fail 'nspawn evidence private key is missing'
  test -s "$CONFIG_ROOT/evidence-public.pem" || fail 'nspawn evidence public key is missing'
  return 0
}

refresh_existing_runner() {
  for path in "$ROOT" "$CONFIG_ROOT" "$RUNNER_ROOT" "$RUNNER_ROOT/dist" "$RUNNER_ROOT/dist/src"; do
    safe_owned_directory "$path"
  done
  owned_marker "$ROOT/.bootstrap-owned"
  owned_marker "$CONFIG_ROOT/.bootstrap-owned"
  owned_marker "$RUNNER_ROOT/.bootstrap-owned"
  test ! -e "$ROOT/runner.lock" || fail 'nspawn runner is active or has an unreconciled lock'
  test ! -e /run/lock/se-z-nspawn.lock || fail 'legacy nspawn runner lock requires recovery'

  fields=$(python3 - "$CONFIG_ROOT/bootstrap.json" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding='utf-8') as handle:
    record = json.load(handle)
expected = {
    'recordVersion', 'recordType', 'pool', 'snapshot', 'snapshotGuid',
    'harnessDigest', 'runnerDigest', 'nodeVersion', 'poolBytes',
}
assert set(record) == expected
assert record['recordVersion'] == '1.0.0'
assert record['recordType'] == 'se-z-nspawn-bootstrap'
assert record['pool'] == 'sezcert'
assert record['snapshot'] == 'sezcert/base/noble@golden-v1'
assert re.fullmatch(r'[1-9][0-9]{0,19}', record['snapshotGuid'])
assert re.fullmatch(r'[a-f0-9]{64}', record['harnessDigest'])
assert re.fullmatch(r'[a-f0-9]{64}', record['runnerDigest'])
assert record['nodeVersion'] == '24.18.0'
assert record['poolBytes'] == 12884901888
print(record['snapshotGuid'], record['harnessDigest'], sep='\t')
PY
)
  IFS=$'\t' read -r SNAPSHOT_GUID EXPECTED_HARNESS_DIGEST <<< "$fields"
  test "$(zfs get -H -p -o value guid "$BASE_SNAPSHOT")" = "$SNAPSHOT_GUID" ||
    fail 'golden snapshot GUID differs from the bootstrap record'
  PAYLOAD_HARNESS_DIGEST=$(sha256sum "$SCRIPT_DIR/se-z-host-certification.mjs" | awk '{print $1}')

  install_runner_payload
  RUNNER_DIGEST=$(sha256sum "$SOURCE_ROOT/dist/src/rehearsal/nspawn-runner.js" | awk '{print $1}')
  record_tmp="$CONFIG_ROOT/bootstrap.json.new.$$"
  printf '{"recordVersion":"1.0.0","recordType":"se-z-nspawn-bootstrap","pool":"%s","snapshot":"%s","snapshotGuid":"%s","harnessDigest":"%s","runnerDigest":"%s","nodeVersion":"24.18.0","poolBytes":%s}\n' \
    "$POOL" "$BASE_SNAPSHOT" "$SNAPSHOT_GUID" "$PAYLOAD_HARNESS_DIGEST" "$RUNNER_DIGEST" "$POOL_BYTES" \
    > "$record_tmp"
  chmod 0600 "$record_tmp"
  sync -f "$record_tmp"
  mv -fT -- "$record_tmp" "$CONFIG_ROOT/bootstrap.json"
  sync -f "$CONFIG_ROOT"
  printf '{"ok":true,"status":"runner_reconciled","pool":"%s","snapshot":"%s","snapshotGuid":"%s","harnessDigest":"%s","runnerDigest":"%s"}\n' \
    "$POOL" "$BASE_SNAPSHOT" "$SNAPSHOT_GUID" "$PAYLOAD_HARNESS_DIGEST" "$RUNNER_DIGEST"
}

rollback_new_bootstrap() {
  status=$?
  pool_removed=1
  trap - ERR INT TERM
  if test "$status" -ne 0; then
    printf 'ERROR: nspawn bootstrap failed; rolling back only resources created by this invocation\n' >&2
    if test "$CREATED_POOL" -eq 1 && command -v zpool >/dev/null 2>&1; then
      if test "$(zpool get -H -o value comment "$POOL" 2>/dev/null || true)" = 'se-z-nspawn-v1'; then
        zpool destroy -f "$POOL" || pool_removed=0
      else
        pool_removed=0
      fi
    fi
    if test "$CREATED_RUNNER" -eq 1; then
      rm -f -- "$RUNNER_BIN"
      rm -rf -- "$RUNNER_ROOT"
    fi
    if test "$CREATED_CONFIG" -eq 1; then rm -rf -- "$CONFIG_ROOT"; fi
    if test "$CREATED_ROOT" -eq 1 && test "$pool_removed" -eq 1; then rm -rf -- "$ROOT"; fi
    if test "$pool_removed" -ne 1; then
      printf 'ERROR: owned pool could not be removed; preserving %s for exact manual recovery\n' "$ROOT" >&2
    fi
  fi
  exit "$status"
}

test "$#" -eq 1 && test "$1" = "$CONFIRM" || fail "exact confirmation required: $CONFIRM"
test "$(id -u)" -eq 0 || fail 'bootstrap must run as root'

exec 9>'/run/lock/se-z-nspawn-bootstrap.lock'
flock --exclusive --nonblock 9 || fail 'another nspawn bootstrap is active'

validate_payload
if already_bootstrapped; then
  refresh_existing_runner
  exit 0
fi

# Complete the read-only gate before the first durable mutation.
. /etc/os-release
test "$ID" = 'ubuntu' && test "$VERSION_ID" = '24.04' || fail 'Ubuntu 24.04 is required'
test "$(uname -m)" = 'x86_64' || fail 'x86_64 is required'
test "$(ps -p 1 -o comm= | tr -d ' ')" = 'systemd' || fail 'host PID 1 must be systemd'
test "$(stat -fc %T /sys/fs/cgroup)" = 'cgroup2fs' || fail 'host cgroup v2 is required'
test -x "$HOST_NODE/bin/node" || fail 'pinned host Node runtime is missing'
test "$($HOST_NODE/bin/node --version)" = 'v24.18.0' || fail 'host Node runtime is not v24.18.0'
test ! -e "$ROOT" || fail "unowned bootstrap path already exists: $ROOT"
test ! -e "$CONFIG_ROOT" || fail "unowned bootstrap path already exists: $CONFIG_ROOT"
test ! -e "$RUNNER_ROOT" || fail "unowned bootstrap path already exists: $RUNNER_ROOT"
test ! -e "$RUNNER_BIN" || fail "unowned bootstrap path already exists: $RUNNER_BIN"
if command -v zpool >/dev/null 2>&1; then
  ! zpool list -H "$POOL" >/dev/null 2>&1 || fail 'an unowned sezcert pool already exists'
fi
AVAILABLE=$(df -B1 --output=avail / | awk 'NR==2 {print $1}')
test "$AVAILABLE" -ge "$((POOL_BYTES + HOST_RESERVE_BYTES))" || fail 'at least 26 GiB of host disk must be available'
MEMORY=$(awk '/^MemTotal:/ {printf "%.0f\n", $2 * 1024}' /proc/meminfo)
test "$MEMORY" -ge 8589934592 || fail 'at least 8 GiB of host RAM is required'

trap rollback_new_bootstrap ERR INT TERM

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends zfsutils-linux systemd-container debootstrap
modprobe zfs
test "$(systemd-nspawn --version | awk 'NR==1 {print $2}')" -ge 255 || fail 'systemd-nspawn 255 or newer is required'

install -d -m 0700 "$ROOT" "$ROOT/pool" "$ROOT/inputs" "$ROOT/machines" "$ROOT/evidence"
install -d -m 0755 "$ROOT/base"
printf 'se-z-nspawn-v1\n' > "$ROOT/.bootstrap-owned"
CREATED_ROOT=1
fallocate --length "$POOL_BYTES" "$VDEV"
chmod 0600 "$VDEV"

zpool create -f \
  -o ashift=12 \
  -o autotrim=on \
  -o cachefile=/etc/zfs/zpool.cache \
  -O mountpoint=none \
  -O canmount=off \
  -O compression=zstd \
  -O atime=off \
  -O xattr=sa \
  -O acltype=posixacl \
  -O dedup=off \
  -O primarycache=metadata \
  -O secondarycache=none \
  "$POOL" "$VDEV"
CREATED_POOL=1
zpool set comment='se-z-nspawn-v1' "$POOL"
zfs create -o canmount=off -o mountpoint=none "$POOL/base"
zfs create -o canmount=on -o mountpoint="$BASE_MOUNT" -o refquota=8589934592 "$BASE_DATASET"
zfs create -o canmount=off -o mountpoint=none "$RUNS_DATASET"

debootstrap \
  --arch=amd64 \
  --variant=minbase \
  --include=systemd-sysv,dbus,ca-certificates,git,build-essential,python3,python3-dev,pkg-config,tmux,acl,attr,util-linux,bash,curl,xz-utils,openssl \
  noble "$BASE_MOUNT" http://archive.ubuntu.com/ubuntu

printf '#!/bin/sh\nexit 101\n' > "$BASE_MOUNT/usr/sbin/policy-rc.d"
chmod 0755 "$BASE_MOUNT/usr/sbin/policy-rc.d"
printf 'deb http://archive.ubuntu.com/ubuntu noble main universe\ndeb http://archive.ubuntu.com/ubuntu noble-updates main universe\ndeb http://security.ubuntu.com/ubuntu noble-security main universe\n' \
  > "$BASE_MOUNT/etc/apt/sources.list"
systemd-nspawn --quiet --directory="$BASE_MOUNT" --register=no \
  --private-users=no --capability=all --no-new-privileges=no --system-call-filter='@known' \
  --resolv-conf=copy-host --setenv=DEBIAN_FRONTEND=noninteractive \
  /usr/bin/apt-get update
systemd-nspawn --quiet --directory="$BASE_MOUNT" --register=no \
  --private-users=no --capability=all --no-new-privileges=no --system-call-filter='@known' \
  --resolv-conf=copy-host --setenv=DEBIAN_FRONTEND=noninteractive \
  /usr/bin/apt-get -y --no-install-recommends dist-upgrade
rm -f -- "$BASE_MOUNT/usr/sbin/policy-rc.d"

install -d -m 0755 "$BASE_MOUNT/opt" "$BASE_MOUNT/usr/local/libexec" "$BASE_MOUNT/etc/systemd/system"
cp -a --reflink=auto "$HOST_NODE" "$BASE_MOUNT/opt/"
install -m 0755 "$SCRIPT_DIR/se-z-host-certification.mjs" \
  "$BASE_MOUNT/usr/local/libexec/se-z-host-certification.mjs"
install -m 0755 "$SCRIPT_DIR/se-z-peer-cred-probe.py" \
  "$BASE_MOUNT/usr/local/libexec/se-z-peer-cred-probe.py"
install -m 0644 "$SCRIPT_DIR/se-z-host-certification.service" \
  "$BASE_MOUNT/etc/systemd/system/se-z-host-certification.service"

install -d -m 0755 "$BASE_MOUNT/var/log/journal"
: > "$BASE_MOUNT/etc/machine-id"
systemctl --root="$BASE_MOUNT" enable se-z-host-certification.service

test "$(chroot "$BASE_MOUNT" "$HOST_NODE/bin/node" --version)" = 'v24.18.0'
chroot "$BASE_MOUNT" "$HOST_NODE/bin/node" --check /usr/local/libexec/se-z-host-certification.mjs
PYTHONPYCACHEPREFIX=/tmp/se-z-nspawn-bootstrap-pycache \
  python3 -m py_compile "$BASE_MOUNT/usr/local/libexec/se-z-peer-cred-probe.py"
rm -rf -- /tmp/se-z-nspawn-bootstrap-pycache
systemd-analyze --root="$BASE_MOUNT" verify se-z-host-certification.service
test "$(sha256sum "$BASE_MOUNT/usr/local/libexec/se-z-host-certification.mjs" | awk '{print $1}')" = \
  "$(sha256sum "$SCRIPT_DIR/se-z-host-certification.mjs" | awk '{print $1}')"

rm -rf -- "$BASE_MOUNT/var/lib/apt/lists"/* "$BASE_MOUNT/var/cache/apt/archives"/*
sync -f "$BASE_MOUNT"
zfs set readonly=on "$BASE_DATASET"
zfs snapshot "$BASE_SNAPSHOT"
SNAPSHOT_GUID=$(zfs get -H -p -o value guid "$BASE_SNAPSHOT")
zfs unmount "$BASE_DATASET"

install -d -m 0700 "$CONFIG_ROOT"
printf 'se-z-nspawn-v1\n' > "$CONFIG_ROOT/.bootstrap-owned"
CREATED_CONFIG=1
openssl genpkey -algorithm ED25519 -out "$CONFIG_ROOT/evidence-private.pem"
openssl pkey -in "$CONFIG_ROOT/evidence-private.pem" -pubout -out "$CONFIG_ROOT/evidence-public.pem"
chmod 0600 "$CONFIG_ROOT/evidence-private.pem"
chmod 0644 "$CONFIG_ROOT/evidence-public.pem"

CREATED_RUNNER=1
install_runner_payload

HARNESS_DIGEST=$(sha256sum "$SCRIPT_DIR/se-z-host-certification.mjs" | awk '{print $1}')
RUNNER_DIGEST=$(sha256sum "$SOURCE_ROOT/dist/src/rehearsal/nspawn-runner.js" | awk '{print $1}')
printf '{"recordVersion":"1.0.0","recordType":"se-z-nspawn-bootstrap","pool":"%s","snapshot":"%s","snapshotGuid":"%s","harnessDigest":"%s","runnerDigest":"%s","nodeVersion":"24.18.0","poolBytes":%s}\n' \
  "$POOL" "$BASE_SNAPSHOT" "$SNAPSHOT_GUID" "$HARNESS_DIGEST" "$RUNNER_DIGEST" "$POOL_BYTES" \
  > "$CONFIG_ROOT/bootstrap.json"
chmod 0600 "$CONFIG_ROOT/bootstrap.json"
sync -f "$CONFIG_ROOT"

test "$(zpool list -H -o health "$POOL")" = 'ONLINE'
test "$(zfs get -H -o value readonly "$BASE_DATASET")" = 'on'
test "$(zfs get -H -p -o value guid "$BASE_SNAPSHOT")" = "$SNAPSHOT_GUID"
test -x "$RUNNER_BIN"

trap - ERR INT TERM
printf '{"ok":true,"status":"created","pool":"%s","poolBytes":%s,"snapshot":"%s","snapshotGuid":"%s","harnessDigest":"%s","runnerDigest":"%s"}\n' \
  "$POOL" "$POOL_BYTES" "$BASE_SNAPSHOT" "$SNAPSHOT_GUID" "$HARNESS_DIGEST" "$RUNNER_DIGEST"

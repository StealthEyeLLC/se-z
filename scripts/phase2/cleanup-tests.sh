#!/bin/bash
set -euo pipefail

# Only Phase 2 test resources use these exact prefixes and roots.
for unit in $(systemctl list-units --all --no-legend 'se-z-p2-it-*.service' 2>/dev/null | awk '{print $1}'); do
  systemctl stop "$unit" 2>/dev/null || true
  systemctl reset-failed "$unit" 2>/dev/null || true
done
for root in /var/tmp/se-z-p2-integration-*; do
  [[ -d $root ]] || continue
  if [[ -d $root/state/ptys/tmux ]]; then
    while IFS= read -r -d '' socket; do tmux -S "$socket" kill-server 2>/dev/null || true; done < <(find "$root/state/ptys/tmux" -maxdepth 1 -type s -print0 2>/dev/null)
  fi
  rm -rf "$root"
done
for name in $(machinectl list --no-legend --no-pager 2>/dev/null | awk '$1 ~ /^sez-p2/ {print $1}'); do
  machinectl terminate "$name" 2>/dev/null || true
done
for root in /var/lib/machines/sez-p2*; do [[ -e $root ]] && rm -rf "$root"; done
systemctl daemon-reload >/dev/null 2>&1 || true
remaining_units=$(systemctl list-units --all --no-legend 'se-z-p2-it-*.service' 2>/dev/null | wc -l || true)
remaining_processes=$({ ps -eo cmd | grep -E 'tmux -S /var/tmp/se-z-p2-integration-' | grep -v grep || true; } | wc -l)
remaining_machines=$(machinectl list --no-legend --no-pager 2>/dev/null | awk '$1 ~ /^sez-p2/ {count++} END {print count+0}')
printf '{"cleaned":true,"remainingTestUnits":%s,"remainingTestProcesses":%s,"remainingMachines":%s}\n' \
  "$remaining_units" "$remaining_processes" "$remaining_machines"
test "$remaining_units" -eq 0
test "$remaining_processes" -eq 0
test "$remaining_machines" -eq 0

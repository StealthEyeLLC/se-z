// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** systemd socket activation helpers. */

const SD_LISTEN_FDS_START = 3;

export function getSystemdListenFd(): number | undefined {
  const listenFds = process.env.LISTEN_FDS;
  const listenPid = process.env.LISTEN_PID;
  if (listenFds === '1' && listenPid === String(process.pid)) {
    return SD_LISTEN_FDS_START;
  }
  return undefined;
}

export function isSocketActivated(): boolean {
  return getSystemdListenFd() !== undefined;
}

export function clearSocketActivationEnv(): void {
  delete process.env.LISTEN_FDS;
  delete process.env.LISTEN_PID;
}

#!/usr/bin/python3
# Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
"""Prove that a real UID 997 peer is visible through Linux SO_PEERCRED."""

import os
import socket
import struct
import tempfile


def main() -> None:
    root = tempfile.mkdtemp(prefix="se-z-peer-cred-")
    os.chmod(root, 0o711)
    path = os.path.join(root, "probe.sock")
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    os.chmod(path, 0o777)
    server.listen(1)
    pid = os.fork()
    if pid == 0:
        try:
            os.setgroups([])
            os.setgid(997)
            os.setuid(997)
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.connect(path)
            client.sendall(b"probe")
            client.close()
            os._exit(0)
        except BaseException:
            os._exit(1)
    connection, _ = server.accept()
    credentials = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
    _, uid, gid = struct.unpack("3i", credentials)
    payload = connection.recv(5)
    connection.close()
    server.close()
    _, status = os.waitpid(pid, 0)
    if status != 0 or uid != 997 or gid != 997 or payload != b"probe":
        raise SystemExit("SO_PEERCRED UID 997 verification failed")
    print("so-peercred-uid-997-ok")


if __name__ == "__main__":
    main()

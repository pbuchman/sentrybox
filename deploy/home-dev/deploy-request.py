"""Accept a single SHA on an already-authorized systemd socket."""

import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time

REQUEST = Path("/var/lib/sentrybox-deploy/deploy-request.json")


def read_sha(connection):
    """Require exactly one 40-byte hexadecimal SHA, LF and EOF."""
    payload = bytearray()
    deadline = time.monotonic() + 5
    while len(payload) < 42:
        connection.settimeout(max(0.001, deadline - time.monotonic()))
        chunk = connection.recv(42 - len(payload))
        if not chunk:
            break
        payload.extend(chunk)
    if not re.fullmatch(rb"[a-f0-9]{40}\n", payload):
        raise ValueError("invalid deploy request")
    return payload[:40].decode("ascii")


def dispatch(sha):
    body = {
        "version": 1,
        "repository": "pbuchman/sentrybox",
        "workflow": "Release SentryBox Image",
        "headSha": sha,
    }
    # Deploy is started only after the complete request is durable. The
    # exclusive file also serializes manual/bootstrap submissions.
    with REQUEST.open("x", encoding="utf8") as request:
        metadata = os.fstat(request.fileno())
        try:
            request.write(json.dumps(body) + "\n")
            request.flush()
            os.fsync(request.fileno())
            subprocess.run(
                ["/usr/bin/systemctl", "--wait", "start", "sentrybox-deploy.service"],
                check=True,
                stdin=subprocess.DEVNULL,
                stdout=sys.stderr,
                timeout=20 * 60 + 30,
            )
            if REQUEST.exists():
                raise RuntimeError("deployment did not consume its request")
        finally:
            try:
                candidate = REQUEST.lstat()
                if (candidate.st_dev, candidate.st_ino) == (metadata.st_dev, metadata.st_ino):
                    REQUEST.unlink()
            except FileNotFoundError:
                pass


def main():
    with socket.socket(fileno=0) as connection:
        try:
            sha = read_sha(connection)
            dispatch(sha)
            connection.sendall(b"OK\n")
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
            print("SentryBox fixed deployment request failed.", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

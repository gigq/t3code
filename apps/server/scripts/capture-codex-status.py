#!/usr/bin/env python3
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from fcntl import ioctl

ROWS = int(os.environ.get("CODEX_STATUS_ROWS", "60"))
COLS = int(os.environ.get("CODEX_STATUS_COLS", "200"))
TIMEOUT_SECONDS = float(os.environ.get("CODEX_STATUS_TIMEOUT_SECONDS", "12"))
BOOT_DELAY_SECONDS = float(os.environ.get("CODEX_STATUS_BOOT_DELAY_SECONDS", "0.6"))
EXECUTE_DELAY_SECONDS = float(os.environ.get("CODEX_STATUS_EXECUTE_DELAY_SECONDS", "0.5"))
SETTLE_DELAY_SECONDS = float(os.environ.get("CODEX_STATUS_SETTLE_DELAY_SECONDS", "2.0"))


def main() -> int:
    master_fd, slave_fd = pty.openpty()
    ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    child_env = os.environ.copy()
    child_env["TERM"] = child_env.get("TERM") or "xterm-256color"

    proc = subprocess.Popen(
        ["codex", "-s", "read-only", "-a", "untrusted"],
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
        env=child_env,
        cwd=os.getcwd(),
    )
    os.close(slave_fd)

    output = bytearray()
    start = time.time()
    sent_status = False
    acknowledged_prompt = False
    sent_execute_enter = False
    settle_deadline = None
    sent_status_at = None

    try:
        while time.time() - start < TIMEOUT_SECONDS:
            readable, _, _ = select.select([master_fd], [], [], 0.2)
            if master_fd in readable:
                try:
                    chunk = os.read(master_fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output.extend(chunk)

                if (not acknowledged_prompt) and b"Continue anyway? [y/N]:" in output:
                    os.write(master_fd, b"y\r")
                    acknowledged_prompt = True

                if b"\x1b[6n" in chunk:
                    os.write(master_fd, b"\x1b[1;1R")

                decoded = output.decode("utf-8", "ignore")
                has_primary = "5h limit" in decoded and "Weekly limit" in decoded
                has_spark = "GPT-5.3-Codex-Spark limit:" in decoded
                if has_primary and (has_spark or settle_deadline is not None):
                    if settle_deadline is None:
                        settle_deadline = time.time() + SETTLE_DELAY_SECONDS
                    elif time.time() >= settle_deadline:
                        break
                elif has_primary:
                    settle_deadline = time.time() + SETTLE_DELAY_SECONDS

            decoded = output.decode("utf-8", "ignore")
            prompt_ready = "100% left" in decoded and "›" in decoded
            if prompt_ready and not sent_status:
                os.write(master_fd, b"/status\r")
                sent_status = True
                sent_status_at = time.time()
                continue

            if sent_status and (not sent_execute_enter) and sent_status_at is not None and time.time() >= sent_status_at + EXECUTE_DELAY_SECONDS and "/status" in decoded:
                os.write(master_fd, b"\r")
                sent_execute_enter = True

        sys.stdout.write(output.decode("utf-8", "ignore"))
        return 0
    finally:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except Exception:
            try:
                proc.terminate()
            except Exception:
                pass
        try:
            proc.wait(timeout=1)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        try:
            os.close(master_fd)
        except OSError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())

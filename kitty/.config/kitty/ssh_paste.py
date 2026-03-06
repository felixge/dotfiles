"""Custom paste kitten: transfers clipboard images to remote over SSH."""
import subprocess
import os
import time


def main(args):
    pass


from kittens.tui.handler import result_handler


@result_handler(no_ui=True)
def handle_result(args, answer, target_window_id, boss):
    w = boss.window_id_map.get(target_window_id)
    if w is None:
        return

    # Check if clipboard has image (macOS)
    has_image = False
    try:
        r = subprocess.run(
            ["osascript", "-e", "clipboard info"],
            capture_output=True, text=True, timeout=2,
        )
        has_image = "«class PNGf»" in r.stdout or "«class TIFF»" in r.stdout
    except Exception:
        pass

    if not has_image:
        w.paste_from_clipboard()
        return

    # Check if in SSH session
    try:
        cp = w.child.foreground_processes
        in_ssh = any("ssh" in " ".join(p.get("cmdline", [])) for p in cp)
    except Exception:
        in_ssh = False

    if not in_ssh:
        w.paste_from_clipboard()
        return

    # Save clipboard image to local temp file
    ts = int(time.time() * 1000)
    local_path = f"/tmp/kitty-clipboard-{ts}.png"
    remote_path = f"/tmp/kitty-clipboard-{ts}.png"

    try:
        subprocess.run(
            [
                "osascript", "-e",
                "set png to (the clipboard as «class PNGf»)\n"
                f'set f to open for access POSIX file "{local_path}" with write permission\n'
                "write png to f\n"
                "close access f",
            ],
            timeout=5, check=True,
        )
    except Exception:
        w.paste_from_clipboard()
        return

    if not os.path.exists(local_path):
        w.paste_from_clipboard()
        return

    # Transfer to remote via kitten transfer (works over kitten ssh)
    try:
        subprocess.run(
            ["kitten", "transfer", "--transmit-deltas", local_path, remote_path],
            timeout=10, check=True,
        )
        w.paste_text(remote_path)
    except Exception:
        # Fallback to normal paste if transfer fails
        w.paste_from_clipboard()
    finally:
        try:
            os.unlink(local_path)
        except OSError:
            pass

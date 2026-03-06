from kittens.tui.handler import result_handler


def main(args):
    pass


@result_handler()
def handle_result(args, answer, target_window_id, boss):
    window = boss.window_id_map.get(target_window_id)
    if window is None:
        return
    fp = window.child.foreground_processes
    is_ssh = any(
        "ssh" in " ".join(p.get("cmdline") or [])
        for p in fp
    )
    if is_ssh:
        window.paste_bytes(b"cpaste\r")
    else:
        boss.paste_from_clipboard()

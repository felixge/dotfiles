---
name: jj-split
description: Interactively split a jj commit into multiple commits using the builtin TUI diff editor via tmux.
---

# jj split via tmux

Split a commit into N commits by running `jj split -m "<message>"` repeatedly (N-1 times), using tmux to drive the builtin TUI diff editor for file selection.

## Steps

1. Find the existing bash pane in the current tmux session: `tmux list-panes -t <session> -F "#{pane_index} #{pane_current_command}"`
2. For each split, send: `tmux send-keys -t <session>:<window>.<pane> 'jj split -m "<message>"' Enter`
3. Wait for the TUI to appear, then capture: `tmux capture-pane -t <target> -p`
4. Navigate with `j`/`k`, select files with `Space`, confirm with `c`
5. After the last split, describe the remaining commit: `jj describe -m "<message>"`

## TUI keybindings

- `j`/`k` — navigate down/up between files
- `Space` — toggle selection on focused item
- `c` — confirm and finish split
- `h`/`l` — collapse/expand file to see hunks

## Key details

- `-m` sets the description for the selected (first) commit, so vim never opens.
- The remaining commit keeps the original description (usually empty).
- All files start unselected — select only what goes into the first commit.
- Always `sleep` between `send-keys` and `capture-pane` to let the TUI render.
- Format all commit messages (`-m` and `jj describe`) using the [conventional-commits](../conventional-commits/SKILL.md) skill.

## Related Skills

- [jj](../jj/SKILL.md) — Full jj command reference (split, describe, squash, etc.)
- [conventional-commits](../conventional-commits/SKILL.md) — Commit message format for `-m` flags and `jj describe`

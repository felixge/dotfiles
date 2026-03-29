# dotfiles

Personal dotfiles for macOS and Linux, managed with [GNU Stow](https://www.gnu.org/software/stow/) and Homebrew.

## Installation

```bash
git clone https://github.com/felixge/dotfiles.git ~/dotfiles
source dotfiles/install.bash
```

`install.bash` handles the full bootstrap: Homebrew, packages, shell config, stow, neovim plugins, mise tools, and Go packages. Testing is done via Docker (`make test-ubuntu`).

## Repo Layout

Each top-level directory is a "stow package" — its contents mirror `$HOME` structure and are symlinked by `stow --adopt -t $HOME`. The stowed packages are: `jj`, `jjui`, `neovim`, `mise`, `claude`, `codex`, `idea`, `kitty`.

```
bash/               - Shell config
  .bashrc                      Homebrew, mise, zoxide (j alias), direnv, nvim as vim, prompt, tmux helpers (tn, ts)
  .git.bash, .go.bash, ...     Topic-specific shell config
claude/             - Claude Code settings, permissions, skills, hooks
  .claude/CLAUDE.md            Global instructions (use jj not git)
  .claude/settings.json        Permissions (jj allowed, git denied), model (opus), plugins, hooks, ntfy notifications
  .claude/skills/              Custom skills: jj (VCS reference), conventional-commits (commit format with Prompts section)
codex/              - OpenAI Codex agent config (AGENTS.md)
git/                - Git config
  .gitconfig                   Delta pager (side-by-side, light, Cursor hyperlinks), SSH GitHub URLs, LFS, rerere
  .gitconfig.datadog           DataDog/OTel email, SSH commit signing via dd-gitsign
jj/                 - Jujutsu (jj) version control config (used instead of git)
  .config/jj/config.toml      Delta pager, SSH signing, watchman fsmonitor, emoji log templates,
                               auto push bookmark names, aliases (wip, e, tug, pr, stack),
                               revset aliases (mine, stack, megamerge), scoped DataDog/OTel email
  .config/jj/repos/           Per-repo overrides (by repo hash)
jjui/               - jjui TUI config and base16 themes
  .config/jjui/config.toml    Leader key shortcuts (d=diff, e=edit, p=open PR)
kitty/              - Kitty terminal config
  .config/kitty/kitty.conf    SauceCodePro Nerd Font 18pt, light theme, fat/tall/stack layouts,
                               powerline tab bar, Cmd+D split, Cmd+T tab, Cmd+Enter fullscreen
  .config/kitty/zoom.py       Zoom kitten (Cmd+Shift+Enter)
mise/               - mise tool version manager (Go, Node)
neovim/             - Neovim config (LazyVim-based)
  .config/nvim/init.lua        Bootstraps lazy.nvim + LazyVim
  .config/nvim/lua/config/     LazyVim config (lazy.lua bootstrap)
  .config/nvim/lua/plugins/    Plugin overrides/extras (colorscheme, snacks)
  .bak/config-2026-03-29/nvim/ Backup of the old vim config (referred to as "old vim config")
ripgrep/            - Ripgrep config (.ripgreprc)
tmux/               - tmux config
  .tmux.conf                   Light theme, mouse, 1-based windows, kitty passthrough,
                               bind r=reload, bind s=fzf session picker
```

Root files: `install.bash` (bootstrap script), `Makefile` (test targets), `mise.toml` (tool versions), `.ripgreprc`, `.nvimrc` (legacy).

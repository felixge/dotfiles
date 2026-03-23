#!/usr/bin/env bash

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

main() {
    set -eu
    install_basics
    install_homebrew
    install_homebrew_packages
    trust_github
    setup_bashrc
    setup_gitconfig
    setup_tmux
    unminimize_ubuntu
    mise_install
    stow_dotfiles
    install_neovim_plugins
    install_go_packages
    install_npm_packages
    setup_claude_mcp
    symlink_go
    exec bash
}

install_basics() {
    local commands=(curl git make ping clang)
    if is_macos; then
        for command in "${commands[@]}"; do
            if ! command_exists "$command"; then
                echo "command $command not found, please install it manually"
                return 1
            fi
        done
    elif ! command_exists "${commands[@]}"; then
        echo "-> install basics"
        sudo apt-get -y update
        sudo apt-get -y install \
            build-essential \
            clang\
            curl \
            file \
            git \
            iproute2 \
            iputils-ping \
            man-db
    fi
}

install_homebrew() {
    if is_macos; then
        export HOMEBREW_PREFIX="/opt/homebrew"
    else
        export HOMEBREW_PREFIX="/home/linuxbrew/.linuxbrew"
    fi

    if [ ! -x "$HOMEBREW_PREFIX/bin/brew" ]; then
        echo "-> install homebrew"
        NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    fi
    eval "$($HOMEBREW_PREFIX/bin/brew shellenv)"
}

install_homebrew_packages() {
    echo "-> install homebrew packages"
    local brew_packages=(
	    protobuf
        atlassian-labs/acli/acli
        bash-completion@2
        bat
        black
        btop
        claude-code
        cloc
        codex
        curl
        direnv
        fd
        fzf
        gawk
        gdb
        gh
        git
        git-delta
        glow
        grpcurl
        htop
        hyperfine
        isort
        jj
        jjui
        jq
        kubectx
        less
        llm
        magic-wormhole
        mise
        neovim
        pyright
        ripgrep
        rsync
        socat
        stow
        tmux
        tree
        tree-sitter-cli
        unzip
        uv
        vhs
        watchman
        yq
        zoxide
    )
    brew install -q "${brew_packages[@]}"
    if is_macos; then
        brew install -q --cask keycastr snowflake-snowsql
    else
        brew install -q bubblewrap
    fi
    if is_datadog; then
        brew install -q datadog/tap/dd-auth
        if is_macos; then
            brew install -q --cask datadog/tap/datadog-workspaces
        fi
    fi
}

trust_github() {
    echo "-> trust github"
    mkdir -pm700 ~/.ssh
    ssh-keyscan -t rsa,ecdsa,ed25519 github.com >> ~/.ssh/known_hosts
}

is_macos() {
    if [[ "$OSTYPE" =~ ^darwin ]]; then
        return 0
    else
        return 1
    fi
}

is_datadog() {
    [ -e "$HOME/dd" ]
}

quiet_run() {
    local output
    if ! output=$("$@" 2>&1); then
        echo "$output"
        return 1
    fi
}

command_exists() {
    local commands=("$@")
    local missing=0
    for command in "${commands[@]}"; do
        if ! command -v "$command" > /dev/null 2>&1; then
            missing=1
            break
        fi
    done
    return $missing
}

setup_bashrc() {
    if ! grep "$DOTFILES_DIR" "$HOME/.bashrc" > /dev/null; then
        echo "-> setup bashrc"
        echo "export DOTFILES_DIR=\"$DOTFILES_DIR\"" >> "$HOME/.bashrc"
        echo ". $DOTFILES_DIR/bash/.bashrc" >> "$HOME/.bashrc"
    fi
}

setup_gitconfig() {
    # Ensure .gitconfig exists to avoid grep warnings
    touch "$HOME/.gitconfig"

    if ! grep "$DOTFILES_DIR" "$HOME/.gitconfig" > /dev/null; then
        echo "-> add .gitconfig include to $HOME/.gitconfig"
        echo "[include]" >> "$HOME/.gitconfig"
        echo "  path = \"$DOTFILES_DIR/git/.gitconfig\"" >> "$HOME/.gitconfig"
    fi
    if ! grep -E 'includeIf.+DataDog' "$HOME/.gitconfig" > /dev/null; then
        echo "-> add .gitconfig.datadog include to $HOME/.gitconfig for DataDog"
        echo "[includeIf \"gitdir:~/go/src/github.com/DataDog/**\"]" >> "$HOME/.gitconfig"
        echo "  path = \"$DOTFILES_DIR/git/.gitconfig.datadog\"" >> "$HOME/.gitconfig"
    fi
    if ! grep -E 'includeIf.+open-telemetry' "$HOME/.gitconfig" > /dev/null; then
        echo "-> add .gitconfig.open-telemetry include to $HOME/.gitconfig for OpenTelemetry"
        echo "[includeIf \"gitdir:~/go/src/github.com/open-telemetry/**\"]" >> "$HOME/.gitconfig"
        echo "  path = \"$DOTFILES_DIR/git/.gitconfig.datadog\"" >> "$HOME/.gitconfig"
    fi
    if [[ "${USER:-}" == "bits" ]] && ! grep '# workspace config' "$HOME/.gitconfig" > /dev/null; then
        echo "-> add workspace config to $HOME/.gitconfig"
        echo "# workspace config" >> "$HOME/.gitconfig"
        echo "[delta]" >> "$HOME/.gitconfig"
        echo "  hyperlinks-file-link-format = "cursor://vscode-remote/ssh-remote+workspace-${HOSTNAME}/{path}:{line}"
" >> "$HOME/.gitconfig"
    fi
}

setup_tmux() {
    # Ensure .tmux.conf exists to avoid grep warnings
    touch "$HOME/.tmux.conf"

    if ! grep "$DOTFILES_DIR" "$HOME/.tmux.conf" > /dev/null; then
        echo "-> setup tmux config"
        echo "source-file \"$DOTFILES_DIR/tmux/.tmux.conf\"" >> "$HOME/.tmux.conf"
    fi
}

unminimize_ubuntu() {
    if grep "minimized" "$(which man)" > /dev/null; then
        echo "-> unminimizing ubuntu install"
        yes | DEBIAN_FRONTEND=noninteractive unminimize
    fi
}

stow_dotfiles() {
    echo "-> stow dotfiles"
    mkdir -p "$HOME/.claude" "$HOME/.pi/agent"
    stow_file_adopt git/.gitignore
    stow --adopt -t "$HOME" jj jjui neovim mise claude codex idea kitty pi
}

stow_file_adopt() {
    local rel_path="$1"
    local src="$DOTFILES_DIR/$rel_path"
    local dst="$HOME/${rel_path#*/}"

    if [ -L "$dst" ]; then
        return
    fi

    mkdir -p "$(dirname "$dst")"
    if [ -e "$dst" ]; then
        cp "$dst" "$src"
    fi
    ln -sf "$src" "$dst"
}

install_neovim_plugins() {
    echo "-> install neovim plugins"
    quiet_run nvim --headless  "+Lazy! restore" "+Lazy! clean" "+Lazy! install" +qa
    quiet_run nvim --headless "+MasonToolsUpdateSync" +qa
}

mise_install() {
    echo "-> install mise tools"
    mise trust -q
    mise install -q
    mise upgrade -q
    eval "$(mise activate bash)"
}

install_go_packages() {
    echo "-> install go packages"
    export GOPROXY="https://proxy.golang.org,direct"
    local go_packages=(
        github.com/bokwoon95/wgo@latest
        github.com/go-delve/delve/cmd/dlv@latest
        github.com/maruel/panicparse/v2/cmd/pp@latest
        golang.org/x/perf/cmd/benchstat@latest
        golang.org/x/pkgsite/cmd/pkgsite@latest
        golang.org/x/tools/cmd/stress@latest
    )
    for package in "${go_packages[@]}"; do
        go install "$package" &
    done
    wait
}

install_npm_packages() {
    echo "-> install npm packages"
    quiet_run npm install -g markserv @mariozechner/pi-coding-agent
}

setup_claude_mcp() {
    echo "-> setup claude mcp servers"

    # datadog
    claude_mcp_add datadog -t http \
        'https://mcp.datad0g.com/api/unstable/mcp-server/mcp?toolsets=core,profiling'
    claude_mcp_add datadog-staging -t http \
        'https://mcp.datad0g.com/api/unstable/mcp-server/mcp?toolsets=core,profiling'

    # chrome-devtools (local npx, no auth)
    claude_mcp_add chrome-devtools -- npx -y chrome-devtools-mcp@latest

    # snowflake (see Confluence: "Snowflake for MCP")
    if [ -z "${SNOWFLAKE_ACCOUNT:-}" ] || [ ! -f "$HOME/.config/mcp/snowflake-config.yaml" ]; then
        echo "   skipping snowflake mcp (see Confluence: 'Snowflake for MCP')"
    else
        claude_mcp_add snowflake -t stdio \
            -e SNOWFLAKE_ACCOUNT="$SNOWFLAKE_ACCOUNT" \
            -e SNOWFLAKE_USER="$(whoami)@datadoghq.com" \
            -e SNOWFLAKE_DATABASE=REPORTING \
            -- \
            uvx \
                --python 3.12 \
                --python-preference=managed \
                --from git+https://github.com/Snowflake-Labs/mcp \
                mcp-server-snowflake \
                    --service-config-file "~/.config/mcp/snowflake-config.yaml" \
                    --authenticator externalbrowser \
                    --transport stdio \
                    --user "${USER}@datadoghq.com"
    fi
}

claude_mcp_add() {
    # Usage: claude_mcp_add <name> <add-flags...>
    # Removes existing server first to ensure config is up to date.
    local name="$1"
    claude mcp remove --scope user "$name" &>/dev/null || true
    claude mcp add --scope user "$@" &>/dev/null
}

symlink_go() {
    # Hack: Make sure the VS Code Go extension can always find the go binary
    echo "-> symlink go to /usr/local/bin"
    local target="/usr/local/bin/go"
    local go_bin
    go_bin="$(mise which go)"
    if [ "$(readlink "$target" 2>/dev/null)" = "$go_bin" ]; then
        return
    fi
    sudo ln -sf "$go_bin" "$target"
}

# Only run main when executed directly, not when sourced.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi

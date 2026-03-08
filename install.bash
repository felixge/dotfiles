#!/usr/bin/env bash
set -eu

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

main() {
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
        brew install -q --cask keycastr
    else
        brew install -q bubblewrap
    fi
    if is_datadog; then
        brew install -q datadog/tap/dd-auth
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
    stow --adopt -t "$HOME" jj jjui neovim mise claude codex idea kitty
}

install_neovim_plugins() {
    echo "-> install neovim plugins"
    nvim --headless "+Lazy! install" +qa
    nvim --headless "+MasonToolsUpdateSync" +qa
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
    npm install -g markserv --silent 2>&1 | grep -v "^Reshimming "
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

main "$@"

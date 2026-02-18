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
    install_go_packages
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
        btop
        claude-code
        cloc
        codex
        curl
        direnv
        fd
        gawk
        gdb
        gh
        git
        git-delta
        glow
        grpcurl
        htop
        jj
        jjui
        jq
        kubectx
        less
        llm
        magic-wormhole
        mise
        neovim
        ripgrep
        rsync
        socat
        stow
        tmux
        tree
        unzip
        uv
        vhs
        yq
        zoxide
    )
    brew install -q "${brew_packages[@]}"
    if is_macos; then
        brew install -q --cask keycastr
    else
        brew install -q bubblewrap
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
    stow --adopt -t "$HOME" jj jjui neovim mise claude codex idea
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

symlink_go() {
    # Hack: Make sure the VS Code Go extension can always find the go binary
    echo "-> symlink go to /usr/local/bin"
    sudo ln -sf "$(mise which go)" /usr/local/bin/go
}

main "$@"

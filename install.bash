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
    unminimize_ubuntu
    stow_dotfiles
    mise_install
    exec bash
}

install_basics() {
    local commands=(curl git make)
    if is_macos; then
        for command in "${commands[@]}"; do
            if ! command_exists "$command"; then
                echo "command $command not found, please install it manually"
                return 1
            fi
        done
    elif ! command_exists "${commands[@]}"; then
        echo "-> install basics"
        apt-get -y update
        apt-get -y install \
            curl \
            git \
            build-essential \
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
        jj
        stow
        curl
        git
        htop
        tmux
        zoxide
        neovim
        codex
        ripgrep
        btop
        git-delta
        tree
        fd
        gh
        jjui
        jq
        yq
        llm
        cloc
        gawk
        unzip
        less
        mise
        uv
        rsync
        kubectx
        magic-wormhole
        bash-completion@2
    )
    brew install "${brew_packages[@]}"
    brew install --cask claude-code
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
    if [[ "$USER" == "bits" ]] && ! grep '# workspace config' "$HOME/.gitconfig" > /dev/null; then
        echo "-> add workspace config to $HOME/.gitconfig"
        echo "# workspace config" >> "$HOME/.gitconfig"
        echo "[delta]" >> "$HOME/.gitconfig"
        echo "  hyperlinks-file-link-format = "cursor://vscode-remote/ssh-remote+workspace-${HOSTNAME}/{path}:{line}"
" >> "$HOME/.gitconfig"
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
    stow -t "$HOME" jj neovim mise claude
}

mise_install() {
    echo "-> install mise tools"
    mise trust
    mise install
}

main "$@"
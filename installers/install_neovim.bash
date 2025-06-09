#!/usr/bin/env bash

# check if neovim is already installed
if grep 'EDITOR=nvim' ~/.bashrc > /dev/null; then
    echo "neovim is already installed, skipping"
    exit 0
fi

# check if we support this platform
if [[ $(uname -s) != "Linux" || ! -x "$(command -v apt)" ]]; then
    echo "Error: only Linux and apt are supported"
    exit 1
fi

# install neovim
sudo apt-get -y update
sudo apt-get -y install neovim

# set default editor to neovim
echo "export EDITOR=nvim" >> ~/.bashrc
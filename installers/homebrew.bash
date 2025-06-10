#!/usr/bin/env bash

if grep 'linuxbrew' ~/.bashrc > /dev/null; then
    echo "homebrew is already installed, skipping"
    exit 0
fi


NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

echo >> ~/.bashrc
# shellcheck disable=SC2016
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.bashrc
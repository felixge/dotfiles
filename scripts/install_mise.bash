#!/usr/bin/env bash

if grep 'mise activate' ~/.bashrc > /dev/null; then
    echo "mise is already installed, skipping"
    return
fi

curl https://mise.run | sh
echo "eval \"\$(/home/bits/.local/bin/mise activate bash)\"" >> ~/.bashrc
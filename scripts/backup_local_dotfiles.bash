#!/usr/bin/env bash
set -eu

files=("$HOME/.gitconfig" "$HOME/.bash_profile" "$HOME/.bashrc")

for file in "${files[@]}"; do
    if [ -e "$file" ] && [ ! -L "$file" ]; then
        echo "$file exists and is not a symlink, backing up to $file.local"
        mv -n "$file" "$file.local"
    fi
done

# if [ -e ~/.gitconfig ] && [ ! -L ~/.gitconfig ]; then
#     echo "$HOME/.gitconfig exists and is not a symlink, backing up to $HOME/.gitconfig.local"
#     mv -n ~/.gitconfig ~/.gitconfig.local
# fi




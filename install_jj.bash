#!/usr/bin/env bash

# check if jj command is already installed
if command -v jj > /dev/null; then
    echo "jj is already installed, skipping"
    exit 0
fi

# check if we support this platform
if [[ $(uname -s) != "Linux" || $(uname -m) != "aarch64" ]]; then
    echo "Error: only Linux aarch64 install has been tested"
    exit 1
fi

# install from binary release
version="0.29.0"
url="https://github.com/jj-vcs/jj/releases/download/v${version}/jj-v${version}-aarch64-unknown-linux-musl.tar.gz"
tmp_dir=$(mktemp -d)
tar_file="${tmp_dir}/jj.tar.gz"
install_dir="/usr/local/bin"
curl -L -o "${tar_file}" "${url}"
tar -xzf "${tar_file}" -C "${tmp_dir}"
sudo mv "${tmp_dir}/jj" "${install_dir}/jj"
rm -rf "${tmp_dir}"

# create symlink to jj config
rm -f "$HOME/.config/jj"
ln -s "$(pwd)/.config/jj/" "$HOME/.config/jj"

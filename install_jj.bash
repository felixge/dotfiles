#!/usr/bin/env bash

version="0.29.0"
url="https://github.com/jj-vcs/jj/releases/download/v${version}/jj-v${version}-aarch64-unknown-linux-musl.tar.gz"
tmp_dir=$(mktemp -d)
tar_file="${tmp_dir}/jj.tar.gz"
install_dir="/usr/local/bin"

if [[ $(uname -s) != "Linux" || $(uname -m) != "aarch64" ]]; then
    echo "Error: only Linux aarch64 install has been tested"
    exit 1
fi

curl -L -o "${tar_file}" "${url}"
tar -xzf "${tar_file}" -C "${tmp_dir}"
sudo mv "${tmp_dir}/jj" "${install_dir}/jj"
rm -rf "${tmp_dir}"
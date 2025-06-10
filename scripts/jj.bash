#!/usr/bin/env bash

# get the latest version from GitHub
version="$(curl -s 'https://api.github.com/repos/jj-vcs/jj/releases/latest' | jq -r .tag_name)"

# check if jj command is already installed
if command -v jj > /dev/null; then
    # Extract installed version (strip commit hash) and latest version (strip leading 'v')
    installed_version="$(jj --version | gawk '{print $2}' | cut -d'-' -f1)"  # e.g. "0.30.0"
    latest_version="${version#v}"                                            # e.g. "0.30.0"

    if [[ "${installed_version}" == "${latest_version}" ]]; then
        echo "jj ${installed_version} is already installed, skipping"
        exit 0
    fi
fi

url="https://github.com/jj-vcs/jj/releases/download/${version}/jj-${version}-$(uname -m)-unknown-linux-musl.tar.gz"
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

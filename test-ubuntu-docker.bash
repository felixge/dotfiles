#!/usr/bin/env bash
set -eu

docker build -t ubuntu-dotfiles .

# see https://docs.orbstack.dev/docker/#ssh-agent-forwarding
docker run \
    --rm \
    -it \
    -v "$(pwd)":/opt/dotfiles \
    -v /run/host-services/ssh-auth.sock:/agent.sock \
    -e SSH_AUTH_SOCK=/agent.sock \
    ubuntu-dotfiles

# to take snapshots
docker commit 986398c395bc dotfiles:2
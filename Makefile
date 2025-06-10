.PHONY: packages dotfiles

all: packages dotfiles

dotfiles:
	stow -t $$HOME $$(echo */ | xargs -n1 basename)

ifeq ($(shell uname),Linux)
# apt-get
ifneq (,$(shell command -v apt-get))
.PHONY: apt-update apt-packages
apt-update:
	sudo apt-get -y update

apt-packages:
	sudo apt-get -y install \
		htop \
		tmux \
		jq \
		curl \
		neovim \
		gawk \
		stow

packages: apt-packages jj
endif

.PHONY: jj
jj: apt-packages
	./installers/jj.bash
else ifeq ($(shell uname),Darwin)
packages:
	brew install \
		htop \
		tmux \
		jq \
		neovim \
		gawk \
		stow \
		jj
endif
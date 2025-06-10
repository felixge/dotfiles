BREW_PACKAGES := \
	htop \
	tmux \
	jq \
	neovim \
	gawk \
	stow \
	jj \
	fd \
	tree \
	ripgrep \
	git

.PHONY: all
all: packages dotfiles

.PHONY: dotfiles
dotfiles:
	stow -t $$HOME neovim macos linux kitty i3 git bash borders aerospace ripgrep skhdrc yabairc jj

ifeq ($(shell uname),Linux)
# apt-get
ifneq (,$(shell command -v apt-get))
.PHONY: packages
packages: apt-packages homebrew brew-packages

.PHONY: apt-packages
apt-packages:
	sudo apt-get -y update
	sudo apt-get -y install \
		curl \
		build-essential

.PHONY: homebrew
homebrew:
	./installers/homebrew.bash

.PHONY: brew-packages
brew-packages:
	eval "$$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)" && brew install $(BREW_PACKAGES)
endif

else ifeq ($(shell uname),Darwin)
.PHONY: packages
packages:
	brew install $(BREW_PACKAGES)
endif
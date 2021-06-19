# location of dotfiles
export DOTFILES="$(dirname $( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd ))"

# typora command line alias: https://support.typora.io/Use-Typora-From-Shell-or-cmd/
alias typora="open -a typora"

# custom scripts
export PATH="$PATH:$HOME/bin"

# == GO ==
# Go bin path
export PATH="$PATH:$HOME/go/bin"
# Tell go to not cache my tests, it's annoying!
export GOFLAGS="-count=1"
# Local go compiled from source
alias sgo="$HOME/go/src/github.com/golang/go/bin/go"
# docker run in go container
alias dgo='docker run -it --rm -v "$PWD":/usr/src/myapp -w /usr/src/myapp golang:${VERSION:-latest} bash'
# list go versions
alias goversions='find ${PATH//:/ } -maxdepth 1  | grep go1. | xargs -n1 basename | sort -r'
# quick godoc alias
alias gdoc=godoc -http=:6060

# == BASH ==
# infinite history
export HISTFILESIZE=
export HISTSIZE=
# edit this config
alias bc="vim ~/.bash_config && source ~/.bash_config"
# the one true editor
alias vim="$(which nvim)"
alias vimr="vim -u NONE"
export EDITOR="$(which nvim)"
# no zsh nagging plz: https://apple.stackexchange.com/questions/371997/suppressing-the-default-interactive-shell-is-now-zsh-message-in-macos-catalina
export BASH_SILENCE_DEPRECATION_WARNING=1
# prompt
export GIT_PS1_SHOWDIRTYSTATE=true
export GIT_PS1_SHOWCOLORHINTS=true
export GIT_PS1_SHOWUPSTREAM=verbose
export GIT_PS1_SHOWUNTRACKEDFILES=true
PROMPT_COMMAND='__git_ps1 "" "\W \[\e[0;31m\]⌁\[\e[0m\]\[\e[0m\] " "(%s) "'
# other aliases
alias h='sudo nvim /etc/hosts'
alias cdr='cd $(git rev-parse --show-toplevel)'
alias ubuntu='docker run -it --rm -v "$PWD":/root -w /root ubuntu bash'
# direnv hook: https://direnv.net/docs/hook.html#bash (MUST BE executed after PROMPT_COMMAND changes above)
eval "$(direnv hook bash)"

# == GIT ==
gr() {
  git rev-parse --show-toplevel
}
alias gb='git co $(git branch | fzf)'
[[ $- == *i* ]] && source /usr/local/etc/bash_completion.d/git-completion.bash
[[ $- == *i* ]] && source /usr/local/etc/bash_completion.d/git-prompt.sh

# == KITTY ==
# aliases
alias kdiff="kitty +kitten diff"
alias icat="kitty icat --align=left"
alias isvg="rsvg-convert | icat"
alias idot="dot -Tpng -Efontsize=18 -Nfontsize=18 -Efontname='Source Code Pro' -Nfontname='Source Code Pro' | icat"
alias pcat="open -a Preview.app -f"
alias pdot="dot -Tpdf | pcat"
# kitty ssh
[[ "$TERM" == 'xterm-kitty' ]] && alias ssh='kitty +kitten ssh'
# find kitty binary
export PATH="/Applications/kitty.app/Contents/MacOS/:$PATH"

# fasd
eval "$(fasd --init auto)"
alias j='fasd_cd -d'
alias jo='fasd -e open -d'

# fzf
[ -f ~/.fzf.bash ] && source ~/.fzf.bash

# avoids wrong locale setting due to using german regional setting
export LANG="en_US.UTF-8"

# extended globbing, see https://stackoverflow.com/a/4381121
shopt -s extglob

# rust
source "$HOME/.cargo/env"

# fzf key bindings
[ -f ~/.fzf.bash ] && source ~/.fzf.bash

# bat theme, see https://github.com/sharkdp/bat
export BAT_THEME=OneHalfLight

# devbox
alias db='docker run -it --rm --privileged -v /etc/localtime:/etc/localtime:ro -v `pwd`:/proftest --pid=host -v "$PWD":/work felixge/devbox:latest'

# checkout git repository and cd into it
cl() {
  path=$(command cl -dir "$GOPATH/src" "$1")
  cd "$path"
}

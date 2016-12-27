# infinite history
export HISTFILESIZE=
export HISTSIZE=

# editor
export EDITOR='vim'

# git
[[ $- == *i* ]] && source /usr/local/etc/bash_completion.d/git-completion.bash
[[ $- == *i* ]] && source /usr/local/etc/bash_completion.d/git-prompt.sh

# golang
export GOPATH="$HOME/code/go"
export PATH="$HOME/code/go/bin:$PATH"

# deal with apple bug causing annoying direnv effects, see
# http://www.openradar.me/22807197
export _LD_LIBRARY_PATH=$LD_LIBRARY_PATH
export _DYLD_LIBRARY_PATH=$DYLD_LIBRARY_PATH

# prompt
export GIT_PS1_SHOWDIRTYSTATE=true
export GIT_PS1_SHOWCOLORHINTS=true
export GIT_PS1_SHOWUPSTREAM=verbose
export GIT_PS1_SHOWUNTRACKEDFILES=true
PROMPT_COMMAND='__git_ps1 "" "\W \[\e[0;31m\]⌁\[\e[0m\]\[\e[0m\] " "(%s) "'

# direnv
eval "$(direnv hook bash)"

# postgres app cli tools
#export PATH="$PATH:/Applications/Postgres.app/Contents/Versions/latest/bin"

export LANG="en_US.UTF-8"

# secrets
[[ -s "$HOME/.profile_secret" ]] && source "$HOME/.profile_secret"

# homebrew
export PATH="/usr/local/sbin:$PATH"

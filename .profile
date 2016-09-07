# infinite history
export HISTFILESIZE=
export HISTSIZE=

# golang
[[ -s "$HOME/.gvm/scripts/gvm" ]] && source "$HOME/.gvm/scripts/gvm"
export GOPATH="$HOME/code/go:$GOPATH"
export PATH="$HOME/code/go/bin:$PATH"

# git
[[ $- == *i* ]] && source /usr/local/etc/bash_completion.d/git-completion.bash
[[ $- == *i* ]] && source /usr/local/etc/bash_completion.d/git-prompt.sh

# prompt
export GIT_PS1_SHOWDIRTYSTATE=true
export GIT_PS1_SHOWCOLORHINTS=true
PROMPT_COMMAND='__git_ps1 "" "\W \[\e[0;31m\]⌁\[\e[0m\]\[\e[0m\] " "(%s) "'

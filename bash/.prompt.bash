export GIT_PS1_SHOWDIRTYSTATE=true
export GIT_PS1_SHOWCOLORHINTS=true
export GIT_PS1_SHOWUPSTREAM=verbose
export GIT_PS1_SHOWUNTRACKEDFILES=true

# curl -o ~/.git-prompt.sh https://raw.githubusercontent.com/git/git/master/contrib/completion/git-prompt.sh
source ~/.git-prompt.sh
PROMPT_COMMAND='pwd > /tmp/whereami && __git_ps1 "" "\W \[\e[0;31m\]⌁\[\e[0m\]\[\e[0m\] " "(%s) "'

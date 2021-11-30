export GIT_PS1_SHOWDIRTYSTATE=true
export GIT_PS1_SHOWCOLORHINTS=true
export GIT_PS1_SHOWUPSTREAM=verbose
export GIT_PS1_SHOWUNTRACKEDFILES=true
PROMPT_COMMAND='pwd > /tmp/whereami && __git_ps1 "" "\W \[\e[0;31m\]⌁\[\e[0m\]\[\e[0m\] " "(%s) "'

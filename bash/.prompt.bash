# shellcheck disable=all
export GIT_PS1_SHOWDIRTYSTATE=true
export GIT_PS1_SHOWCOLORHINTS=true
export GIT_PS1_SHOWUPSTREAM=verbose
export GIT_PS1_SHOWUNTRACKEDFILES=true

[ ! -f ~/.git-prompt.sh ] && curl -o ~/.git-prompt.sh https://raw.githubusercontent.com/git/git/master/contrib/completion/git-prompt.sh
source ~/.git-prompt.sh

my_prompt() {
  local ssh_indicator="\[\e[31m\]⌁\[\e[0m\]" # red fg
  if [ -n "$SSH_CONNECTION" ]; then
    ssh_indicator="\[\e[37;41m\]⌁\[\e[0m\]" # white fg on red bg
  fi
  __git_ps1 "" "\W ${ssh_indicator} " "(%s) "
}
PROMPT_COMMAND=my_prompt
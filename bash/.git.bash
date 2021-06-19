gr() {
  git rev-parse --show-toplevel
}
alias gb='git co $(git branch | fzf)'
[[ $- == *i* ]] && source /usr/local/etc/bash_completion.d/git-completion.bash
[[ $- == *i* ]] && source /usr/local/etc/bash_completion.d/git-prompt.sh
alias cdr='cd $(git rev-parse --show-toplevel)'

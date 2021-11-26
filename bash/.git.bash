gr() {
  git rev-parse --show-toplevel
}
alias gb='git co $(git branch | fzf)'
[ -f /usr/local/etc/bash_completion.d/git-completion.bash ] && source /usr/local/etc/bash_completion.d/git-completion.bash
[ -f /usr/local/etc/bash_completion.d/git-prompt.sh ] && source /usr/local/etc/bash_completion.d/git-prompt.sh
alias cdr='cd $(git rev-parse --show-toplevel)'

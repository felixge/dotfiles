gr() {
  git rev-parse --show-toplevel
}
alias gb='git co $(git branch | fzf)'
alias cdr='cd $(git rev-parse --show-toplevel)'

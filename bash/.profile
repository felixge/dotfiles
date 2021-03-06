# directory that includes this file
CWD="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

# Anything that's not core bash config or has more than 3 lines of config gets
# its own file.
source "${CWD}/.git.bash"
source "${CWD}/.prompt.bash"
source "${CWD}/.go.bash"
source "${CWD}/.kitty.bash"
source "${CWD}/.docker.bash"
source "${CWD}/.vim.bash"
source "${CWD}/.fasd.bash"

# infinite history
export HISTFILESIZE=
export HISTSIZE=
# no zsh nagging plz: https://apple.stackexchange.com/questions/371997/suppressing-the-default-interactive-shell-is-now-zsh-message-in-macos-catalina
export BASH_SILENCE_DEPRECATION_WARNING=1
# avoids wrong locale setting due to using german regional setting
export LANG="en_US.UTF-8"
# extended globbing, see https://stackoverflow.com/a/4381121
shopt -s extglob

# custom scripts
export PATH="$PATH:$HOME/bin"

# direnv hook: https://direnv.net/docs/hook.html#bash (MUST BE executed after PROMPT_COMMAND changes above)
eval "$(direnv hook bash)"

# typora command line alias: https://support.typora.io/Use-Typora-From-Shell-or-cmd/
alias typora="open -a typora"

# fzf
[ -f ~/.fzf.bash ] && source ~/.fzf.bash

# rust
source "$HOME/.cargo/env"

# ssh into current directory mounted into the linux vm
alias vm="ssh vm \"bash -c 'cd \"$(pwd)\" && bash -il'\""

# fzf key bindings
[ -f ~/.fzf.bash ] && source ~/.fzf.bash

# bat theme, see https://github.com/sharkdp/bat
export BAT_THEME=OneHalfLight

# checkout git repository and cd into it
cl() {
  path=$(command cl -dir "$GOPATH/src" "$1")
  cd "$path"
}

until_fail() {
  local i=0
  while $@; do
    echo "attempt $i did not fail, running again"
    let "i+=1"
  done
}

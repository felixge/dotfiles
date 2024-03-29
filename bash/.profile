# directory that includes this file
CWD="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

# cd into most recent directory (see prompt.bash)
[[ -r "/opt/homebrew/etc/profile.d/bash_completion.sh" ]] && . "/opt/homebrew/etc/profile.d/bash_completion.sh"

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

# java11
export PATH="/opt/homebrew/opt/openjdk@11/bin:$PATH"
export CPPFLAGS="-I/opt/homebrew/opt/openjdk@11/include"

# direnv hook: https://direnv.net/docs/hook.html#bash (MUST BE executed after PROMPT_COMMAND changes above)
eval "$(direnv hook bash)"

# colima
#export DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"

# fzf
[ -f ~/.fzf.bash ] && source ~/.fzf.bash
#$(brew --prefix)/opt/fzf/install

# ripgrep
export RIPGREP_CONFIG_PATH=$HOME/.ripgreprc

# rust
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
# ssh into current directory mounted into the linux vm
alias vm="ssh -tt vm \"bash -c 'cd \"$(pwd)\" && bash -il'\""

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
###-begin-gt-completions-###
#
# yargs command completion script
#
# Installation: /opt/homebrew/Cellar/graphite/0.20.18/bin/gt completion >> ~/.bashrc
#    or /opt/homebrew/Cellar/graphite/0.20.18/bin/gt completion >> ~/.bash_profile on OSX.
#
_gt_yargs_completions()
{
    local cur_word args type_list

    cur_word="${COMP_WORDS[COMP_CWORD]}"
    args=("${COMP_WORDS[@]}")

    # ask yargs to generate completions.
    type_list=$(/opt/homebrew/Cellar/graphite/0.20.18/bin/gt --get-yargs-completions "${args[@]}")

    COMPREPLY=( $(compgen -W "${type_list}" -- ${cur_word}) )

    # if no match was found, fall back to filename completion
    if [ ${#COMPREPLY[@]} -eq 0 ]; then
      COMPREPLY=()
    fi

    return 0
}
complete -o bashdefault -o default -F _gt_yargs_completions gt
###-end-gt-completions-###

export VOLTA_HOME="$HOME/.volta"
export PATH="$VOLTA_HOME/bin:$PATH"

# Added by OrbStack: command-line tools and integration
source ~/.orbstack/shell/init.bash 2>/dev/null || :

# source homebrew env, including completions
if ! command -v brew >/dev/null 2>&1; then
    for prefix in "/opt/homebrew" "/home/linuxbrew/.linuxbrew"; do
    if [ -d "$prefix" ]; then
        export HOMEBREW_PREFIX="$prefix"
        eval "$($HOMEBREW_PREFIX/bin/brew shellenv)"
        break
    fi
    done
fi
[[ -r "$HOMEBREW_PREFIX/etc/profile.d/bash_completion.sh" ]] && . "$HOMEBREW_PREFIX/etc/profile.d/bash_completion.sh"

# set editors
alias vim="nvim"
export EDITOR="nvim"
if [[ "$OSTYPE" =~ ^linux ]]; then
    alias dot="$EDITOR $DOTFILES_DIR"
elif [[ "$OSTYPE" =~ ^darwin ]]; then
    alias dot="cursor $DOTFILES_DIR"
fi

# setup a simple prompt
generate_prompt() {
    local exit_code=$?
    local reset='\[\e[0m\]'
    local red='\[\e[1;31m\]'
    local blue='\[\e[1;34m\]'


    local prompt_symbol=""
    if [[ "$OSTYPE" =~ ^linux ]]; then
        prompt_symbol+="🐧"
    elif [[ "$OSTYPE" =~ ^darwin ]]; then
        prompt_symbol+=""
    fi

    if [ -f "/.dockerenv" ]; then
        prompt_symbol+="🐳"
    fi
    if [ -n "$SSH_CONNECTION" ] ; then
        prompt_symbol+="⚡"
    fi

    local exit_color="${reset}"
    if [ $exit_code -ne 0 ]; then
        exit_color="${red}"
    fi

    PS1="${exit_color}\W${reset} ${blue}${prompt_symbol}${reset} "
}
export PROMPT_COMMAND=generate_prompt

# kitty
if [[ "$TERM" == 'xterm-kitty' ]]; then
    alias ssh="kitten ssh"
fi

# zoxide
eval "$(zoxide init bash)"
alias j="z" # used to be my alias for fasd

# mise
eval "$(mise activate bash)"

# direnv
eval "$(direnv hook bash)"

# timewarrior
alias tw="timew"
# rename tag: use as timew-tagrename <oldtag> <newtag>
function tw-tagrename() {
  oldtag=$1; shift
  newtag=$1; shift
  idlist=$(timew summary "$oldtag" :ids :all | sed -nr 's/.* (@[0-9]+) .*/\1/p')

  timew tag $idlist "$newtag"
  timew untag $idlist "$oldtag"
} 
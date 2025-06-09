if [[ "$TERM" == 'xterm-kitty' ]]; then
  export PATH="/Applications/kitty.app/Contents/MacOS/:$PATH"
  alias kdiff="kitty +kitten diff"
  alias icat="kitty icat --align=left"
  alias isvg="rsvg-convert | icat"
  alias idot="dot -Tpng -Efontsize=18 -Nfontsize=18 -Efontname='Source Code Pro' -Nfontname='Source Code Pro' | icat"
  alias pcat="open -a Preview.app -f"
  alias pdot="dot -Tpdf | pcat"
  #alias ssh='kitty +kitten ssh'
  tab() {
    local default="$(basename ${PWD})"
    kitty @ set-tab-title ${1:-${default}}
  }
fi

if command -v fasd &> /dev/null
then
  eval "$(fasd --init auto)"

  function j() {
    fasd_cd -d $1
    local dirname=${PWD##*/}          # to assign to a variable
    dirname=${dirname:-/}
    tab "${dirname}"
  }
  alias jo='fasd -e open -d'
fi

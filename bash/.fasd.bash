if command -v fasd &> /dev/null
then
  eval "$(fasd --init auto)"

  function j() {
    fasd_cd -d $1
  }
  alias jo='fasd -e open -d'
fi

if command -v fasd &> /dev/null
then
  eval "$(fasd --init auto)"
  alias j='fasd_cd -d'
  alias jo='fasd -e open -d'
fi

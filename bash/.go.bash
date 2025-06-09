# Go bin path
export PATH="$PATH:$(go env GOPATH)/go/bin"
# Go path
export GOPATH="$HOME/go"
# Tell go to not cache my tests, it's annoying!
export GOFLAGS="-count=1"
# Local go compiled from source
alias sgo="$HOME/go/src/github.com/golang/go/bin/go"
# docker run in go container
alias dgo='docker run -it --rm -v "$PWD":/usr/src/myapp -w /usr/src/myapp golang:${VERSION:-latest} bash'
# list go versions
alias goversions='find ${PATH//:/ } -maxdepth 1  | grep go1. | xargs -n1 basename | sort -r'
# quick godoc alias
alias gdoc=godoc -http=:6060

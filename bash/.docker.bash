# run in ubuntu container
alias ubuntu='docker run -it --rm -v "$PWD":/root -w /root ubuntu bash'
# devbox
alias db='docker run -it --rm --privileged -v /etc/localtime:/etc/localtime:ro -v `pwd`:/proftest --pid=host -v "$PWD":/work felixge/devbox:latest'

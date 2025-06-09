# check if cloc is already installed
if grep 'cloc' ~/.bashrc > /dev/null; then
    echo "cloc is already installed, skipping"
    exit 0
fi

# install cloc
sudo apt-get -y update
sudo apt-get -y install cloc
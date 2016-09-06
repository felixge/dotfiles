#!/bin/bash
# based on http://blog.smalleycreative.com/tutorials/using-git-and-github-to-manage-your-dotfiles/

dir=~/dotfiles                    # dotfiles directory
olddir=~/dotfiles_old             # old dotfiles backup directory
files=$(git ls-tree --name-only HEAD | grep -v 'install.bash')

# create dotfiles_old in homedir
echo "Creating $olddir for backup of any existing dotfiles in ~"
mkdir -p $olddir
echo "...done"

# change to the dotfiles directory
echo "Changing to the $dir directory"
cd $dir
echo "...done"

# move any existing dotfiles in homedir to dotfiles_old directory, then create symlinks 
for file in ${files}; do
    echo "file: $file"
    #echo "Moving any existing dotfiles from ~ to $olddir"
    #mv ~/.$file ~/dotfiles_old/
    #echo "Creating symlink to $file in home directory."
    #ln -s $dir/$file ~/.$file
done

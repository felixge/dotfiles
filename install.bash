#!/bin/bash
# based on http://blog.smalleycreative.com/tutorials/using-git-and-github-to-manage-your-dotfiles/

dir=~/dotfiles                    # dotfiles directory
olddir=~/dotfiles_old             # old dotfiles backup directory
files=$(git ls-tree --name-only HEAD | grep -v 'install.bash')

mkdir -p $olddir

for file in ${files}; do
  if [[ -f ~/"${file}" && ( ! -L ~/"${file}" ) ]]; then
    echo "Creating backup in $olddir/$file"
    mv ~/"$file" "$olddir/$file"
  fi

  echo "Symlinking ~/$file"
  rm -f ~/$file
  ln -fs $dir/$file ~/$file
done

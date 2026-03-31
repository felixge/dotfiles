" Return the root of the current repository (git/jj).
" Used by link.vim to resolve /-prefixed markdown links as repo-relative.
function! linkvim#get_root() abort
  let l:git_dir = finddir('.git', expand('%:p:h') . ';')
  if !empty(l:git_dir)
    return fnamemodify(l:git_dir, ':p:h:h')
  endif
  return getcwd()
endfunction

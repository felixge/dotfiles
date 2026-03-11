" This config has settings for editing the dotfiles repo itself.

" show hidden files in NERDTree
let g:NERDTreeShowHidden = 1
" show hidden files in Telescope
lua vim.keymap.set('n', '<leader>sf', function() require('telescope.builtin').find_files { hidden = true } end, { desc = '[S]earch [F]iles (hidden)' })

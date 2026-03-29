" This config has settings for editing the dotfiles repo itself.
" show hidden files in Snacks picker (LazyVim default)
lua vim.keymap.set('n', '<leader><space>', function() Snacks.picker.smart({ hidden = true }) end, { desc = 'Smart Find Files (hidden)' })

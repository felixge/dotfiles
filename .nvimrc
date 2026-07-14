" This config has settings for editing the dotfiles repo itself.
" Show hidden files in Snacks pickers and the file explorer.
lua Snacks.config.picker.sources = vim.tbl_deep_extend('force', Snacks.config.picker.sources or {}, { explorer = { hidden = true } })

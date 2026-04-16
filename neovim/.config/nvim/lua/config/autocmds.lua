-- Autocmds are automatically loaded on the VeryLazy event
-- Default autocmds that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/autocmds.lua
--
-- Add any additional autocmds here
-- with `vim.api.nvim_create_autocmd`
--
-- Or remove existing autocmds by their group name (which is prefixed with `lazyvim_` for the defaults)
-- e.g. vim.api.nvim_del_augroup_by_name("lazyvim_wrap_spell")

-- Commit message line length: 72 cols for the body (subject line handled visually)
vim.api.nvim_create_autocmd('FileType', {
  pattern = { 'gitcommit', 'jjdescription' },
  callback = function()
    vim.opt_local.textwidth = 72
    vim.opt_local.colorcolumn = '51,73'
    vim.opt_local.spell = true
    -- Let `gq` use Vim's built-in wrapper, not LSP formatexpr
    vim.opt_local.formatexpr = ''
  end,
})


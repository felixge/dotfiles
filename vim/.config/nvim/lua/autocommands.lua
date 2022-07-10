vim.api.nvim_create_autocmd({"FocusLost", "TabLeave"}, {
  pattern = '*',
  callback = function() print('cool') end,
})

-- Toggle markdown checkboxes with Enter
vim.keymap.set('n', '<CR>', function()
  local line = vim.api.nvim_get_current_line()
  local new_line = line:gsub('%- %[([%s xX])%]', function(state)
    return state:match '[xX]' and '- [ ]' or '- [x]'
  end)
  if new_line ~= line then
    vim.api.nvim_set_current_line(new_line)
  end
end, { buffer = 0, desc = 'Toggle markdown checkbox' })

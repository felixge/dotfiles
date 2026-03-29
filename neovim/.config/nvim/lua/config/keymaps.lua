-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua
-- Add any additional keymaps here

-- Yank file paths to clipboard
local function yank_path(modifier)
  return function()
    local path = vim.fn.expand('%' .. modifier)
    if vim.fn.mode():find '[vV\22]' then
      local lo = math.min(vim.fn.line '.', vim.fn.line 'v')
      local hi = math.max(vim.fn.line '.', vim.fn.line 'v')
      path = lo == hi and path .. ':' .. lo or path .. ':' .. lo .. '-' .. hi
    end
    vim.fn.setreg('+', path)
    vim.notify(path, vim.log.levels.INFO)
  end
end

vim.keymap.set({ 'n', 'v' }, '<leader>yr', yank_path ':.', { desc = '[Y]ank [R]elative path' })
vim.keymap.set({ 'n', 'v' }, '<leader>yp', yank_path ':p', { desc = '[Y]ank absolute [P]ath' })

-- Toggle markdown checkboxes with Enter
vim.api.nvim_create_autocmd('FileType', {
  pattern = 'markdown',
  callback = function(ev)
    vim.keymap.set('n', '<CR>', function()
      local line = vim.api.nvim_get_current_line()
      local new_line = line:gsub('%- %[([%s xX])%]', function(state)
        return state:match '[xX]' and '- [ ]' or '- [x]'
      end)
      if new_line ~= line then
        vim.api.nvim_set_current_line(new_line)
      end
    end, { buffer = ev.buf, desc = 'Toggle markdown checkbox' })
  end,
})

-- Close any open floating windows (e.g. LSP hover docs)
vim.keymap.set('n', '<Esc>', function()
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    local ok, cfg = pcall(vim.api.nvim_win_get_config, win)
    if ok and cfg.relative ~= '' then
      pcall(vim.api.nvim_win_close, win, false)
    end
  end
end, { desc = 'Close floating windows' })

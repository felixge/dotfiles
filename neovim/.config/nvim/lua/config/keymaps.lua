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

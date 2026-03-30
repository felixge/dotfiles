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

-- Move lines up/down with Cmd+Opt+Arrow (Kitty remaps to Ctrl+Arrow)
vim.keymap.set('n', '<C-Up>', ':m .-2<CR>==', { desc = 'Move line up', silent = true })
vim.keymap.set('n', '<C-Down>', ':m .+1<CR>==', { desc = 'Move line down', silent = true })
vim.keymap.set('v', '<C-Up>', ":m '<-2<CR>gv=gv", { desc = 'Move selection up', silent = true })
vim.keymap.set('v', '<C-Down>', ":m '>+1<CR>gv=gv", { desc = 'Move selection down', silent = true })

-- Open file under cursor in Finder (macOS)
vim.keymap.set('n', 'gF', function()
  local file = vim.fn.expand '<cfile>'
  local abs
  if file:sub(1, 1) == '/' then
    abs = file
  else
    abs = vim.fn.fnamemodify(vim.fn.expand '%:p:h' .. '/' .. file, ':p')
  end
  if vim.fn.filereadable(abs) == 0 and vim.fn.isdirectory(abs) == 0 then
    vim.notify('gF: not found: ' .. abs, vim.log.levels.WARN)
    return
  end
  vim.fn.jobstart({ 'open', '-R', abs }, { detach = true })
end, { desc = 'Open file under cursor in Finder' })
vim.keymap.set('n', '<Esc>', function()
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    local ok, cfg = pcall(vim.api.nvim_win_get_config, win)
    if ok and cfg.relative ~= '' then
      pcall(vim.api.nvim_win_close, win, false)
    end
  end
end, { desc = 'Close floating windows' })

vim.cmd("packadd cfilter") -- for filtering quickfix window

local o = {
  clipboard = 'unnamed,unnamedplus', -- use system clipboard, see https://stackoverflow.com/a/30691754/62383
  nocompatible = true, -- behave like vim, not vi
  mouse = 'a', -- allow mouse usage in terminal
  laststatus = 2, -- status line
  title = true, -- set title in shell
  t_Co = 256, -- lots of colors
  termguicolors = true, -- colors
  cursorline = true, -- line
  background = 'light', -- light colors
  number = true, -- line numbers
  cursorline = true, -- highlight current line
  colorcolumn = 80, -- highlight 80 char limit
  completeopt = "menu,menuone,noselect",
  relativenumber = true, -- relative line numbers

  expandtab = true, -- insert spaces for tabs
  autoindent = true, -- auto indent
  tabstop = 2, -- 2 spaces per tab
  shiftwidth = 2, -- 2 spaces per tab
  softtabstop = 2, -- 2 spaces per tab
  wrap = true, -- better wrapping
  breakindent = true, -- better wrapping
  list = true, -- show tabs and newlines
  listchars = 'tab:▸  ,eol:¬', -- show tabs and newlines
  showbreak = '⌙', -- indicate wrapped lines

  undofile = true, -- remember undo chains between sessions
  udir = '~/.vimundo//,/var/tmp//,/tmp//,.', -- undo dir
  nobackup = true, -- no swap file
  nowritebackup = true, -- no swap file
  noswapfile = true, -- no swap file
  autowriteall = true, -- automatically save

  splitbelow = true, -- focus on bottom split after vertical splitting
}

for key, val in pairs(o) do
  vim.o[key] = val
end

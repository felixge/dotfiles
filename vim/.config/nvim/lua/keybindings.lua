-- see help vim.keymap

vim.g.mapleader = " "

function nmap(key, action) vim.keymap.set('n', key, action) end

-- misc
nmap('<space>', ':nohlsearch<Bar>:echo<cr>') -- clear search results when hitting space
nmap('<leader>lua', function() print("real lua function") end) -- just an example
nmap('h', ':e ~/.config/nvim/README.md<cr>') -- open readme

-- tab controls (linux, macos)
nmap('<A-t>', ':tab split<CR>')
nmap('†', ':tab split<CR>')
nmap('<A-w>', ':tabclose<CR>')
nmap('∑', ':tabclose<CR>')
nmap('<A-[>', ':tabprev<CR>')
nmap('“', ':tabprev<CR>')
nmap('<A-]>', ':tabnext<CR>')
nmap('‘', ':tabnext<CR>')
nmap('<A-}>', ':+tabmove<CR>')
nmap('’', ':+tabmove<CR>')
nmap('<A-{>', ':-tabmove<CR>')
nmap('”', ':-tabmove<CR>')

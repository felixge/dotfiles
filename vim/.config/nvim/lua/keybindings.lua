-- see help vim.keymap

vim.g.mapleader = " "

local function nmap(keys, action)
  if type(keys) == 'string' then
    keys = {keys}
  end
  for _, key in pairs(keys) do
    vim.keymap.set('n', key, action)
  end
end

-- misc
nmap('<space>', ':nohlsearch<Bar>:echo<cr>') -- clear search results when hitting space
nmap('<leader>lua', function() print("real lua function") end) -- just an example
nmap('<c-,>', ':e ~/dotfiles/vim/.config/nvim/lua<cr>') -- open readme
nmap('<leader>cp', ':let @+=expand("%:p")<CR>') -- copy path to current buffer into clipboard
nmap('<leader>cl', ':let @+=expand("%:p") . \':\' . line(".")<CR>') -- " https://stackoverflow.com/questions/17498144/yank-file-path-with-line-no-from-vim-to-system-clipboard

-- tab controls (linux, macos)
nmap({'<A-t>', '†'}, ':tab split<CR>')
nmap({'<A-w>', '∑'}, ':tabclose<CR>')
nmap({'<A-[>', '“'}, ':tabprev<CR>')
nmap({'<A-]>', '‘'}, ':tabnext<CR>')
nmap({'<A-}>', '’'}, ':+tabmove<CR>')
nmap({'<A-{>', '”'}, ':-tabmove<CR>')

-- quick fix
nmap('<C-j>', '<cmd>cnext<cr>')
nmap('<C-k>', '<cmd>cprevious<cr>')

-- lsp stuff
nmap('<Leader>r', vim.lsp.buf.rename)
nmap('gD', vim.lsp.buf.declaration)
nmap('gd', vim.lsp.buf.definition)
nmap('gt', vim.lsp.buf.type_definition)
nmap('<Leader>a', vim.lsp.buf.code_action)
nmap('lc', vim.lsp.buf.incoming_calls)
nmap('ll', vim.lsp.codelens.run)
nmap('lo', vim.lsp.buf.outgoing_calls)
nmap('li', vim.lsp.buf.implementation)
nmap('lw', vim.lsp.buf.workspace_symbol)
nmap('lb', vim.lsp.buf.document_symbol)
nmap('h', vim.lsp.buf.hover)
nmap('[c', vim.diagnostic.goto_prev)
nmap(']c', vim.diagnostic.goto_next)

-- telescope
local telescope = require('telescope.builtin')
nmap('<leader><leader>', function() telescope.oldfiles({only_cwd = true}) end)
nmap('<leader>f', telescope.find_files)
nmap('<leader>g', telescope.live_grep)
--nmap('lr', telescope.lsp_references)
nmap('lr', vim.lsp.buf.references)
nmap('<leader>h', telescope.help_tags)
nmap('<leader>b', telescope.buffers)
nmap('<leader>d', telescope.diagnostics)
nmap('<leader>c', telescope.command_history)
nmap('<leader>s', function()
  telescope.lsp_dynamic_workspace_symbols({show_line=true})
end)
nmap('<leader>t', '<cmd>Telescope<cr>')

-- symbol outline
nmap('<leader>o', ':SymbolsOutline<CR>')

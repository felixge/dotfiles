" ========== KEY BINDINGS ==========
" set leader key
let mapleader = " "
" clear search results when hitting space
nmap <silent> <Space> :nohlsearch<Bar>:echo<CR>
" copy path to current buffer into clipboard
nmap <leader><space> :!echo -n % \| pbcopy<CR><CR>
" toggle tagbar
nmap <Leader>t :TagbarToggle<CR>
" close quickfix window
nmap <Leader>t :ccl<CR>
" next quickfix
nnoremap <C-j> <cmd>cnext<cr>
" prev quickfix
nnoremap <C-k> <cmd>cprevious<cr>
" open file path in new tab
nmap gF <C-w>gf
" show godoc
au FileType go nmap <Leader>h <Plug>(go-doc)
nmap <Leader>e :ll<CR>
" toggle nerd tree
nnoremap <Leader>n :NERDTreeToggle<CR>
" reveal current file in nerdtree
nnoremap <Leader>f :NERDTreeFind<CR>
" jump to current location list entry (errror)
nmap <Leader>e :ll<CR>
au FileType asm set expandtab
  "nmap <A-t> :tab split<CR>
  "nmap <A-w> :tabclose<CR>
  "nmap <A-[> :tabprev<CR>
  "nmap <A-]> :tabnext<CR>
  "nmap <A-}> :+tabmove<CR>
  "nmap <A-{> :-tabmove<CR>
"else
" alt+t
nmap ˇ :tab split<CR>
" alt+T
nmap † :tabnew<CR>
" alt+w
nmap ∑ :tabclose<CR>
" alt+[
nmap “ :tabprev<CR>
" alt+]
nmap ‘ :tabnext<CR>
" alt+shift+[
nmap ’ :+tabmove<CR>
" alt+shift+]
nmap ” :-tabmove<CR>
" typing % in select mode while using snipMate is interpreted as a movement
" comment in neovim rather than inserting the % character. This fixes it.
" For some reason it only works with the VimEnter auto command.
au VimEnter * snoremap % %
" shift+tab reduce indent in normal/insert mode
nnoremap <S-Tab> <<
inoremap <S-Tab> <C-d>
"nnoremap <leader>V <cmd>e ~/.config/nvim<cr>

" LSP
nnoremap <Leader>r <cmd>lua vim.lsp.buf.rename()<CR>
nnoremap gD <cmd>lua vim.lsp.buf.declaration()<CR>
nnoremap gd <cmd>lua vim.lsp.buf.definition()<CR>
nnoremap gt <cmd>lua vim.lsp.buf.type_definition()<CR>
nnoremap <Leader>a <cmd>lua vim.lsp.buf.code_action()<CR>
nnoremap lc <cmd>lua vim.lsp.buf.incoming_calls()<CR>
nnoremap lr <cmd>lua vim.lsp.buf.references()<CR>
nnoremap lo <cmd>lua vim.lsp.buf.outgoing_calls()<CR>
nnoremap li <cmd>lua vim.lsp.buf.implementation()<CR>
nnoremap lw <cmd>lua vim.lsp.buf.workspace_symbol()<CR>
nnoremap lb <cmd>lua vim.lsp.buf.document_symbol()<CR>
nnoremap <S-k> <cmd>lua vim.lsp.buf.hover()<CR>
nnoremap <A-k> <cmd>lua vim.lsp.buf.signature_help()<CR>
inoremap <A-k> <cmd>lua vim.lsp.buf.signature_help()<CR>
nnoremap [c <cmd>lua vim.lsp.diagnostic.goto_prev()<CR>
nnoremap ]c <cmd>lua vim.lsp.diagnostic.goto_next()<CR>

" Telescope
nnoremap <leader>V <cmd>lua require('telescope.builtin').find_files{cwd='~/dotfiles/vim/.config/nvim', hidden = true, prompt_title = "vim config"}<cr>
nnoremap <leader><leader> <cmd>Telescope find_files<cr>
nnoremap <leader>D <cmd>Telescope lsp_workspace_diagnostics<cr>
nnoremap <leader>d <cmd>Telescope lsp_document_diagnostics<cr>
nnoremap <leader>S <cmd>Telescope lsp_dynamic_workspace_symbols<cr>
nnoremap <leader>s <cmd>Telescope lsp_document_symbols<cr>
nnoremap <leader>m <cmd>Telescope marks<cr>
nnoremap <leader>k <cmd>Telescope keymaps<cr>
"nnoremap <leader>fg <cmd>Telescope live_grep<cr>
"nnoremap <leader>fb <cmd>Telescope buffers<cr>
"nnoremap <leader>fh <cmd>Telescope help_tags<cr>
"nnoremap <leader>fo <cmd>Telescope oldfiles<cr>

" Edit File
nnoremap E :e<cr>

" Git Gutter
nnoremap ]h <cmd>GitGutterNextHunk<cr>
nnoremap [h <cmd>GitGutterPrevHunk<cr>
" hunk (p)review
nnoremap hp <cmd>GitGutterPreviewHunk<cr>
" hunk (s)tage
nnoremap hs <cmd>GitGutterStageHunk<cr><cmd>e<cr>
" hunk (s)undo
nnoremap hu <cmd>GitGutterUndoHunk<cr><cmd>e<cr>
nnoremap hh <cmd>GitGutterQuickFix<cr><cmd>cc 1<cr><cmd>e<cr>

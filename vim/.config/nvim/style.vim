" ========= STYLE =========
" enable syntax highlighting
syntax on
" use colorscheme
colorscheme summerfruit256
" tell theme we're using a light background
set background=light
" highlight active line
set cursorline
hi CursorLine cterm=none
" visual line marking 80 characters (vim 7.3)
set colorcolumn=80
" show Line numbers
set number
" highlight search results
set hlsearch

" airline
let g:airline_theme='light'
let g:airline_powerline_fonts = 1

" treesiter syntax highlight
lua require'nvim-treesitter.configs'.setup { highlight = { enable = true } }

lua << EOF
vim.fn.sign_define("LspDiagnosticsSignError", {text = "", numhl = "LspDiagnosticsDefaultError"})
vim.fn.sign_define("LspDiagnosticsSignWarning", {text = "", numhl = "LspDiagnosticsDefaultWarning"})
vim.fn.sign_define("LspDiagnosticsSignInformation", {text = "", numhl = "LspDiagnosticsDefaultInformation"})
vim.fn.sign_define("LspDiagnosticsSignHint", {text = "", numhl = "LspDiagnosticsDefaultHint"})
EOF

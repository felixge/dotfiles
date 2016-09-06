" ========== GENERAL ==========
" enable pathogen plugin manager
execute pathogen#infect()
" set leader key
let mapleader = ","
" make vim behave like vim, not vi
set nocompatible
" recognize file types and set indent mode accordingly
filetype plugin indent on
" use system clipboard
set clipboard+=unnamed
" make backspace work normally in insert mode
set backspace=indent,eol,start

" ========= COLORS =========
" enable syntax highlighting
syntax on
" use solarized
colorscheme summerfruit256
" tell theme we're using a light background
set background=light

" ========= TABS VS SPACES =========
set expandtab
" 2 spaces for each tab
set tabstop=2
" 2 spaces for indention
set shiftwidth=2

" ========== POWERLINE PLUGIN =========
" load powerline
python from powerline.vim import setup as powerline_setup
python powerline_setup()
python del powerline_setup
" enable status line
set laststatus=2

" ========== CTRLP PLUGIN =========
nmap <Leader>p :CtrlPMRU<CR>

" ========== VIM-GO PLUGIN ==========
nmap <Leader>d :GoDecls<CR>
let g:go_fmt_command = "goimports"
let g:go_highlight_functions = 1
let g:go_highlight_methods = 1
let g:go_highlight_structs = 1
let g:go_highlight_interfaces = 1
let g:go_highlight_operators = 1
let g:go_highlight_build_constraints = 1

" ========= SYNTASTIC PLUGIN ======
let g:syntastic_always_populate_loc_list = 1
let g:syntastic_go_go_build_args="-o /tmp"


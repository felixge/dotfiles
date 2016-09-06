"""""""""""
" general "
"""""""""""
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

"""""""""""""
" powerline "
"""""""""""""
" load powerline
python from powerline.vim import setup as powerline_setup
python powerline_setup()
python del powerline_setup
" enable status line
set laststatus=2

"""""""""
" ctrpl "
"""""""""
nmap <Leader>p :CtrlPMRU<CR>

""""""""""
" vim-go "
""""""""""
nmap <Leader>d :GoDecls<CR>

""""""""""
" colors "
""""""""""
" enable syntax highlighting
syntax on
" use solarized
colorscheme solarized
" tell theme we're using a light background
set background=dark

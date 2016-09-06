" general
execute pathogen#infect()
let mapleader = ","
set nocompatible
filetype plugin indent on

" powerline
set laststatus=2
python from powerline.vim import setup as powerline_setup
python powerline_setup()
python del powerline_setup

" ctrpl
nmap <Leader>p :CtrlPMRU<CR>

" vim-go
nmap <Leader>d :GoDecls<CR>

" colors
syntax on
set background=light
colorscheme solarized

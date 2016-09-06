" general
execute pathogen#infect()
set nocompatible
filetype plugin indent on

" keyboard shortcuts
let mapleader = ","
nmap <Leader>p :CtrlPMRU<CR>
nmap <Leader>d :GoDecls<CR>

" colors
syntax on
set background=light
colorscheme solarized

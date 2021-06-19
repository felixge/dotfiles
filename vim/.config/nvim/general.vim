" == GENERAL
" use system clipboard
set clipboard+=unnamed
" make vim behave like vim, not vi
set nocompatible
" recognize file types and set indent mode accordingly
filetype plugin indent on
" make backspace work normally in insert mode
set backspace=indent,eol,start
" remember undo chains between sessions
set undofile
" do not create swap files
set nobackup
set nowritebackup
set noswapfile
" allow mouse usage in terminal vim
set mouse=a
" use bash because plugins expect it
set shell=bash
" enable status line
set laststatus=2
" indention
set autoindent
" focus on bottom split when splitting vertically
set splitbelow
" disable folding
set nofoldenable
" automatically safe files when switchin between them / leaving vim
set autowriteall
autocmd FocusLost * silent! :wa
autocmd TabLeave * silent! :wa
" per project vimrc
set exrc
" better wrapping with indention
set wrap
set breakindent
set showbreak=⌙
" put undo files somewhere else
set udir=~/.vimundo//,/var/tmp//,/tmp//,.
" for some reason neovim needs this to behave like vim when searching
set noincsearch
" set window title in shell
set title

" ========= TABS VS SPACES =========
set expandtab
" 2 spaces for each tab
set tabstop=2
" 2 spaces for indention
set shiftwidth=2
" shows tabs vs spaces
set list
au BufEnter * set listchars=tab:▸\ ,eol:¬

" use new snipmate parser, don't warn about it
let g:snipMate = { 'snippet_version' : 1 }

" telescope
lua << EOF
require('telescope').load_extension('fzy_native')
EOF

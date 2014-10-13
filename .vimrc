" ------------------------------------------------------------------------------
" Basics
" ------------------------------------------------------------------------------
" Be IMproved
set nocompatible
" Leader key
let mapleader = ","
" Enable pathogen bundle loader
call pathogen#infect()
" Recognize file types / set indent mode
filetype plugin indent on
" Share OS clipboard
set clipboard=unnamed
" Allow mouse usage in terminal vim
set mouse=a
" Always show status line
set laststatus=2
" Syntastic highlight
set statusline+=%#warningmsg#
set statusline+=%{SyntasticStatuslineFlag()}
set statusline+=%*
" Per project vimrc
set exrc
" Source vimrc files after editing
autocmd bufwritepost .vimrc source <afile>
" Indention
set autoindent
" Automatically safe files when switchin between them / leaving vim
set autowriteall
autocmd FocusLost * silent! :wa
autocmd TabLeave * silent! :wa
" Do not create swap files, we're using git after all
set nobackup
set nowritebackup
set noswapfile
" Enable vim to remember undo chains between sessions (vim 7.3)
if v:version >= 703
  set undofile
endif
set completeopt=menuone,longest
" Ignore certain things
set wildignore+=.git,*/node_modules/*
" Fix mouse clicks in terminal
" see http://stackoverflow.com/questions/7000960/vim-mouse-problem
if has("mouse_sgr")
    set ttymouse=sgr
else
    set ttymouse=xterm2
end
set foldlevel=9999

" ------------------------------------------------------------------------------
" Syntastic
" ------------------------------------------------------------------------------
let g:syntastic_always_populate_loc_list = 1

" ------------------------------------------------------------------------------
" Powerline
" ------------------------------------------------------------------------------
set rtp+=/Users/felix/Library/Python/2.7/lib/python/site-packages/powerline/bindings/vim

" ------------------------------------------------------------------------------
" TypeScript Plugin
" ------------------------------------------------------------------------------
au BufRead,BufNewFile *.ts        setlocal filetype=typescript
set rtp+=/Users/felix/code/typescript-tools/

" ------------------------------------------------------------------------------
" Styling
" ------------------------------------------------------------------------------
" Syntax highlighting
syntax on
" Color Scheme
colorscheme summerfruit256
" Show Line numbers
set number
" Visual line marking 80 characters (vim 7.3)
if v:version >= 703
  set colorcolumn=80
endif
set list
" Highlight active line
set cursorline
hi CursorLine cterm=none
" Highlight search results
set hlsearch
" Invisible characters
autocmd BufEnter * set listchars=tab:▸\ ,eol:¬

" ------------------------------------------------------------------------------
" Tabs vs. Spaces
" ------------------------------------------------------------------------------
" Spaces instead of tabs
set expandtab
" 2 spaces for each tab
set tabstop=2
" 2 spaces for indention
set shiftwidth=2


" ------------------------------------------------------------------------------
" godef
" ------------------------------------------------------------------------------
" open go definitions in same window
let g:godef_split=0
"
" ------------------------------------------------------------------------------
" snipmate
" ------------------------------------------------------------------------------
" Configure snipmate dir
let g:snippets_dir="~/.vim/snippets"

" ------------------------------------------------------------------------------
" CtrlP
" ------------------------------------------------------------------------------
let g:ctrlp_dont_split = 'NERD_tree_2'
let g:ctrlp_working_path_mode = ''
let g:ctrlp_mruf_relative = 1
nmap <Leader>p :CtrlPMRU<CR>

" ------------------------------------------------------------------------------
" NERDTree
" ------------------------------------------------------------------------------
" Nerd Tree (toggle)
nnoremap <Leader>n :NERDTreeToggle<CR>
" Nerd Tree (reveal current file)
nnoremap <Leader>f :NERDTreeFind<CR>
" Close NERDtree when selecting a file
let NERDTreeQuitOnOpen=1

" ------------------------------------------------------------------------------
" Key bindings
" ------------------------------------------------------------------------------
" Edit user .vimrc
nmap <Leader>v :e ~/.vimrc<CR>
" Edit project .vimrc
map <Leader>V :e .vimrc<CR>
" Generate ctags
nmap <Leader>c :!ctags -R .<CR>

" Clear search results when hitting space
nnoremap <silent> <Space> :nohlsearch<Bar>:echo<CR>

" Copy path to current buffer into clipboard
nnoremap <leader><space> :!echo -n % \| pbcopy<CR><CR>
nnoremap <leader>o :!echo `git url`/blob/`git rev-parse --abbrev-ref HEAD`/%\#L<C-R>=line('.')<CR> \| xargs open<CR><CR>

" Show current file as HTML (to paste into Keynote)
nmap <Leader>h :TOhtml<CR>:w<cr>:!open %<CR>:q<CR>

" ------------------------------------------------------------------------------
" File type specifics *
" ------------------------------------------------------------------------------
" Go
au FileType go nmap gd <Plug>(go-def)
au FileType go nmap <Leader>i <Plug>(go-info)
au FileType go nmap <Leader>gd <Plug>(go-doc)
au FileType go nmap <Leader>gv <Plug>(go-doc-vertical)
au FileType go nmap <Leader>gb <Plug>(go-doc-browser)
au FileType go nmap <leader>r <Plug>(go-run)
au FileType go nmap <leader>b <Plug>(go-build)
au FileType go nmap <leader>t <Plug>(go-test)
au FileType go nmap <Leader>ds <Plug>(go-def-split)
au FileType go nmap <Leader>dv <Plug>(go-def-vertical)
au FileType go nmap <Leader>dt <Plug>(go-def-tab)

" Execute current file with node.js
autocmd BufEnter *.js nmap <Leader><Leader> :w<CR>:!node %:p<CR>
" Execute current file with coffee-script node.js
autocmd BufEnter *.coffee nmap <Leader><Leader> :w<CR>:!coffee %:p<CR>

" Recognise file by extension
autocmd BufEnter *.ctp set filetype=php
autocmd BufEnter *.less set filetype=less
autocmd BufEnter *.ds set filetype=javascript
autocmd BufEnter *.json set filetype=javascript
autocmd BufEnter *.isml set filetype=html
autocmd BufEnter *.ejs set filetype=html

" Super replace
command! -nargs=* Argdo noautocmd silent argdo <args>

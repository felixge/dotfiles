call plug#begin()
" lsp / auto-complete
Plug 'neovim/nvim-lspconfig'
"Plug 'nvim-lua/completion-nvim'
Plug 'hrsh7th/nvim-compe'
" theme
Plug 'felixge/summerfruit256.vim', {}
" nerdtree
Plug 'preservim/nerdtree'
" telescope & deps
Plug 'nvim-lua/popup.nvim'
Plug 'nvim-lua/plenary.nvim'
Plug 'nvim-telescope/telescope.nvim'
Plug 'nvim-telescope/telescope-fzy-native.nvim'
" ripgrep
Plug 'jremmen/vim-ripgrep'
" git plugin
Plug 'tpope/vim-fugitive'
Plug 'tpope/vim-rhubarb'
" vim surround
Plug 'tpope/vim-surround'
" comment
Plug 'scrooloose/nerdcommenter'
" airline
Plug 'vim-airline/vim-airline'
Plug 'vim-airline/vim-airline-themes'
" treesitter
Plug 'nvim-treesitter/nvim-treesitter', {'do': ':TSUpdate'}
" snipmate & deps
Plug 'MarcWeber/vim-addon-mw-utils' " dep of vim-snipmate
Plug 'tomtom/tlib_vim' " dep of vim-snipmate
Plug 'garbas/vim-snipmate'
" signature help
Plug 'ray-x/lsp_signature.nvim'
call plug#end()

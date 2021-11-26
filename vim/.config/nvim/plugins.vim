call plug#begin()
" lsp / auto-complete
Plug 'neovim/nvim-lspconfig'
"Plug 'nvim-lua/completion-nvim'
Plug 'hrsh7th/nvim-compe'
" debugging
Plug 'mfussenegger/nvim-dap'
Plug 'rcarriga/nvim-dap-ui'
" snippets
Plug 'hrsh7th/vim-vsnip'
Plug 'hrsh7th/vim-vsnip-integ'
Plug 'golang/vscode-go'
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
Plug 'tacahiroy/vim-ripgrep', {'commit': '84d148676e3649fce4db94424937df54b536addb'} " https://github.com/jremmen/vim-ripgrep/pull/56
" git plugins
Plug 'tpope/vim-fugitive'
Plug 'tpope/vim-rhubarb'
Plug 'airblade/vim-gitgutter'
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
"Plug 'MarcWeber/vim-addon-mw-utils' " dep of vim-snipmate
"Plug 'tomtom/tlib_vim' " dep of vim-snipmate
"Plug 'garbas/vim-snipmate'
" signature help
Plug 'ray-x/lsp_signature.nvim'
" typescript
Plug 'jose-elias-alvarez/nvim-lsp-ts-utils'
call plug#end()

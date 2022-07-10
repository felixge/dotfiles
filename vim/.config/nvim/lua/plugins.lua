return require('packer').startup(function(use)
  use {"wbthomason/packer.nvim"} -- plugin manager
  use {"tpope/vim-vinegar"} -- netrw enhancement
  use {'nvim-treesitter/nvim-treesitter', run = ':TSUpdate'} -- syntax highlighting
  use {'ray-x/go.nvim'} -- go support
  use {'ray-x/guihua.lua'} -- floating window support

  -- lsp and auto complete stuff
  use {"neovim/nvim-lspconfig"} -- lsp configs
  use {"williamboman/nvim-lsp-installer"} -- lsp installer
  use {"hrsh7th/cmp-nvim-lsp"} -- auto complete
  use {"hrsh7th/cmp-buffer"} -- auto complete
  use {"hrsh7th/cmp-path"} -- auto complete
  use {"hrsh7th/cmp-cmdline"} -- auto complete
  use {"hrsh7th/nvim-cmp"} -- auto complete

  -- color schemes
  use {'tjdevries/colorbuddy.vim'}
  use {'Th3Whit3Wolf/onebuddy'}
  use {'olimorris/onedarkpro.nvim'}
  use {'sainnhe/edge'}
end)

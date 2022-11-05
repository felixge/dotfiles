return require('packer').startup(function(use)
  use {"wbthomason/packer.nvim"} -- plugin manager
  use {"tpope/vim-vinegar"} -- netrw enhancement
  use {'nvim-treesitter/nvim-treesitter', run = ':TSUpdate'} -- syntax highlighting
  use {'nvim-treesitter/nvim-treesitter-textobjects', run = ':TSUpdate'} -- syntax highlighting
  use {'ray-x/go.nvim'} -- go support
  use {'ray-x/guihua.lua', run = 'cd lua/fzy && make'} -- floating window support
  use {'jremmen/vim-ripgrep'} -- ripgrep
  use {"tpope/vim-surround"} -- editing pairs of quotes, etc.
  use {
    --'nvim-telescope/telescope.nvim',
    --tag = '0.1.0',
    -- TODO: switch back to official version once PR is merged:
    -- https://github.com/nvim-telescope/telescope.nvim/pull/2151
    'felixge/telescope.nvim',
    branch = 'fname_direction',
    requires = { {'nvim-lua/plenary.nvim'} },
  } -- awesome fuzzy finder
  use {'nvim-telescope/telescope-fzf-native.nvim', run = 'cmake -S. -Bbuild -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release && cmake --install build --prefix build' }
  use {'nvim-telescope/telescope-ui-select.nvim' } -- use telescope for lsp code actions
  use {
    "windwp/nvim-autopairs",
    config = function() require("nvim-autopairs").setup {} end
  } -- auto pairing
  use {'tpope/vim-fugitive'} -- git
  use {'tpope/vim-commentary'} -- comments

  -- lsp and auto complete stuff
  use {"neovim/nvim-lspconfig"} -- lsp configs
  use {"williamboman/nvim-lsp-installer"} -- lsp installer
  use {"hrsh7th/cmp-nvim-lsp"} -- auto complete
  use {"hrsh7th/cmp-buffer"} -- auto complete
  use {"hrsh7th/cmp-path"} -- auto complete
  use {"hrsh7th/cmp-cmdline"} -- auto complete
  use {"hrsh7th/nvim-cmp"} -- auto complete
  use {"ray-x/lsp_signature.nvim"} -- auto complete
  use {"L3MON4D3/LuaSnip"} -- snippet engine
  use {'saadparwaiz1/cmp_luasnip'} -- luasnip support for cmp
  use {"rafamadriz/friendly-snippets"} -- default snippets
  use {
    'simrat39/symbols-outline.nvim',
    config = function() require("symbols-outline").setup({
      auto_preview = true,
    }) end,
  } -- symbol outline

  -- color schemes
  --use {'tjdevries/colorbuddy.vim'}
  --use {'Th3Whit3Wolf/onebuddy'}
  --use {'olimorris/onedarkpro.nvim'}
  use {'sainnhe/edge'}
end)

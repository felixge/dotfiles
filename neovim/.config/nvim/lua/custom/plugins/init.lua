-- You can add your own plugins here or in other files in this directory!
--  I promise not to create any merge conflicts in this directory :)
--
-- See the kickstart.nvim README for more information

---@module 'lazy'
---@type LazySpec
return {
  {
    'OXY2DEV/markview.nvim',
    lazy = false,
    dependencies = { 'nvim-treesitter/nvim-treesitter' },
    opts = {},
    config = function(_, opts)
      require('markview').setup(opts)

      local checkboxes = require('markview.extras.checkboxes')
      checkboxes.setup {}

      vim.keymap.set({ 'n', 'v' }, '<CR>', '<cmd>Checkbox toggle<cr>', { desc = 'Checkbox Toggle' })
    end,
  },
  { 'tpope/vim-fugitive' },
  { 'tpope/vim-rhubarb' },
  { 'tpope/vim-surround' },

  -- {
  --   'preservim/vim-markdown',
  --   ft = 'markdown',
  --   init = function()
  --     vim.g.vim_markdown_folding_disabled = 1
  --     vim.g.vim_markdown_fenced_languages = {
  --       'bash',
  --       'c',
  --       'go',
  --       'html',
  --       'javascript',
  --       'lua',
  --       'python',
  --       'rust',
  --       'tsx',
  --       'typescript',
  --     }
  --   end,
  --   config = function() vim.opt.conceallevel = 2 end,
  -- },
}

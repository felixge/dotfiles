-- You can add your own plugins here or in other files in this directory!
--  I promise not to create any merge conflicts in this directory :)
--
-- See the kickstart.nvim README for more information

---@module 'lazy'
---@type LazySpec
return {
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

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
  {
    'qadzek/link.vim',
    ft = 'markdown',
    init = function() vim.g.link_heading = '' end,
    config = function()
      vim.api.nvim_create_autocmd('BufWritePre', {
        pattern = '*.md',
        callback = function() vim.cmd 'LinkConvertAll' end,
      })
      vim.api.nvim_create_autocmd('FileType', {
        pattern = 'markdown',
        callback = function(ev)
          vim.b.link_skip_line = '!\\['
          vim.keymap.set('n', 'gx', '<cmd>LinkOpen<cr>', { buffer = ev.buf, desc = 'Open link under cursor' })
        end,
      })
    end,
  },
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

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
        callback = function(ev) vim.keymap.set('n', 'gx', '<cmd>LinkOpen<cr>', { buffer = ev.buf, desc = 'Open link under cursor' }) end,
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
  {
    'epwalsh/obsidian.nvim',
    version = '*',
    lazy = true,
    ft = 'markdown',
    dependencies = {
      'nvim-lua/plenary.nvim',
      {
        'hrsh7th/nvim-cmp',
        config = function()
          local cmp = require 'cmp'
          cmp.setup {
            mapping = cmp.mapping.preset.insert {
              ['<C-y>'] = cmp.mapping.confirm { select = true },
              ['<C-n>'] = cmp.mapping.select_next_item(),
              ['<C-p>'] = cmp.mapping.select_prev_item(),
              ['<C-e>'] = cmp.mapping.abort(),
            },
          }
        end,
      },
    },
    config = function(_, opts)
      vim.opt.conceallevel = 2
      require('obsidian').setup(opts)
    end,
    opts = {
      note_id_func = function(title) return title end,
      ui = {
        checkboxes = {
          [' '] = { char = '󰄱', hl_group = 'ObsidianTodo', order = 1 },
          ['x'] = { char = '', hl_group = 'ObsidianDone', order = 2 },
          ['~'] = { char = '󰰱', hl_group = 'ObsidianTilde', order = 3 },
          ['!'] = { char = '', hl_group = 'ObsidianImportant', order = 4 },
        },
      },
      workspaces = {
        {
          name = 'no-vault',
          path = function() return assert(vim.fs.dirname(vim.api.nvim_buf_get_name(0))) end,
          overrides = {
            notes_subdir = vim.NIL,
            new_notes_location = 'current_dir',
            templates = { folder = vim.NIL },
            disable_frontmatter = true,
          },
        },
      },
    },
  },
}

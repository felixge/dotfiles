require('nvim-treesitter.configs').setup({
  ensure_installed = {
    "c",
    "cpp",
    "go",
    "gomod",
    "javascript",
    "json",
    "lua",
    "make",
    "markdown",
    "python",
    "ruby",
    "rust",
  },
  sync_install = false, -- Install parsers synchronously (only applied to `ensure_installed`)
  highlight = {
    enable = true,
  },

  -- Available text objects for e.g. Go can be found here:
  -- https://github.com/nvim-treesitter/nvim-treesitter-textobjects/blob/master/queries/go/textobjects.scm
  textobjects = {
    select = {
      enable = true,

      -- Automatically jump forward to textobj, similar to targets.vim
      lookahead = true,

      keymaps = {
        -- You can use the capture groups defined in textobjects.scm
        ["aa"] = "@parameter.outer",
        ["ab"] = "@block.outer",
        ["ac"] = "@class.outer",
        ["af"] = "@function.outer",
        ["as"] = "@statement.outer",

        ["ia"] = "@parameter.inner",
        ["ib"] = "@block.inner",
        ["ic"] = "@class.inner",
        ["if"] = "@function.inner",
        ["is"] = "@statement.inner",
      },
      -- You can choose the select mode (default is charwise 'v')
      selection_modes = {
        ['@parameter.outer'] = 'v', -- charwise
        ['@function.outer'] = 'V', -- linewise
        ['@class.outer'] = '<c-v>', -- blockwise
      },
      -- If you set this to `true` (default is `false`) then any textobject is
      -- extended to include preceding xor succeeding whitespace. Succeeding
      -- whitespace has priority in order to act similarly to eg the built-in
      -- `ap`.
      include_surrounding_whitespace = true,
    },

    move = {
      enable = true,
      set_jumps = true, -- whether to set jumps in the jumplist
      goto_next_start = {
        ["]]"] = "@class.outer",
        ["]a"] = "@parameter.outer",
        ["]b"] = "@block.outer",
        ["]f"] = "@function.outer",
        ["]s"] = "@statement.outer",
      },
      goto_previous_start = {
        ["[["] = "@class.outer",
        ["[a"] = "@parameter.outer",
        ["[b"] = "@block.outer",
        ["[f"] = "@function.outer",
        ["[s"] = "@statement.outer",
      },
      goto_next_end = {
        ["]A"] = "@parameter.outer",
        ["]B"] = "@block.outer",
        ["]F"] = "@function.outer",
        ["]["] = "@class.outer",
        ["]S"] = "@statement.outer",
      },
      goto_previous_end = {
        ["[A"] = "@parameter.outer",
        ["[B"] = "@block.outer",
        ["[F"] = "@function.outer",
        ["[S"] = "@statement.outer",
        ["[]"] = "@class.outer",
      },
    },

    swap = {
      enable = true,
      swap_next = {
        ["<C-n>"] = "@parameter.inner",
      },
      swap_previous = {
        ["<C-p>"] = "@parameter.inner",
      },
    },

    lsp_interop = {
      enable = true,
      border = 'none',
      peek_definition_code = {
        ["<leader>p"] = "@function.outer",
        ["<leader>P"] = "@class.outer",
      },
    },
  },
})



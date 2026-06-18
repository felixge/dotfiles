local function goto_declaration_current_window()
  vim.lsp.buf.declaration({ reuse_win = false })
end

local function goto_definition_current_window()
  vim.lsp.buf.definition({ reuse_win = false })
end

local function goto_implementation_current_window()
  vim.lsp.buf.implementation({ reuse_win = false })
end

local function goto_type_definition_current_window()
  vim.lsp.buf.type_definition({ reuse_win = false })
end

return {
  {
    "neovim/nvim-lspconfig",
    opts = {
      inlay_hints = {
        enabled = false,
      },
      servers = {
        ["*"] = {
          keys = {
            {
              "gd",
              goto_definition_current_window,
              desc = "Goto Definition",
              has = "definition",
            },
            {
              "gD",
              goto_declaration_current_window,
              desc = "Goto Declaration",
              has = "declaration",
            },
            {
              "gI",
              goto_implementation_current_window,
              desc = "Goto Implementation",
              has = "implementation",
            },
            {
              "gy",
              goto_type_definition_current_window,
              desc = "Goto T[y]pe Definition",
              has = "typeDefinition",
            },
          },
        },
      },
    },
  },
}

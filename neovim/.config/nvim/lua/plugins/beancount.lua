-- Beancount ledger support: filetype detection, LSP, and Treesitter highlighting.
vim.filetype.add({
  extension = {
    bean = "beancount",
  },
})

return {
  {
    "neovim/nvim-lspconfig",
    opts = {
      servers = {
        -- Installed automatically by mason-lspconfig as beancount-language-server.
        beancount = {},
      },
    },
  },
  {
    "nvim-treesitter/nvim-treesitter",
    opts = {
      ensure_installed = { "beancount" },
    },
  },
}

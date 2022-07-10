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
})

-- Protobuf syntax highlighting in markdown fenced code blocks (```proto, ```protobuf)
vim.treesitter.language.register("proto", "protobuf")
return {
  { "nvim-treesitter/nvim-treesitter", opts = { ensure_installed = { "proto" } } },
}

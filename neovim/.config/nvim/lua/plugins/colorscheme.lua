return {
  {
    "navarasu/onedark.nvim",
    priority = 1000,
    config = function()
      require("onedark").setup({
        highlights = {
          ["Whitespace"] = { fg = "#eaeaea" },
          ["ColorColumn"] = { bg = "#ff0000" },
        },
      })
      require("onedark").load()
    end,
  },
  {
    "LazyVim/LazyVim",
    opts = {
      colorscheme = "onedark",
    },
  },
}

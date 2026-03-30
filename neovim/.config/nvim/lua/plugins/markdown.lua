return {
  {
    "MeanderingProgrammer/render-markdown.nvim",
    enabled = false,
  },
  {
    "qadzek/link.vim",
    ft = "markdown",
    init = function()
      vim.g.link_heading = ""
      vim.g.link_use_default_mappings = 1
    end,
    config = function()
      vim.api.nvim_create_autocmd("FileType", {
        pattern = "markdown",
        callback = function(ev)
          vim.b.link_skip_line = "!\\["
          vim.keymap.set("n", "gx", "<cmd>LinkOpen<cr>", { buffer = ev.buf, desc = "Open link under cursor" })
        end,
      })
    end,
  },
  {
    "iamcco/markdown-preview.nvim",
    keys = {
      { "<localleader>p", "<cmd>MarkdownPreview<cr>", ft = "markdown", desc = "Markdown preview" },
    },
  },
  {
    "HakonHarnes/img-clip.nvim",
    event = "VeryLazy",
    opts = {},
    keys = {
      { "<leader>p", "<cmd>PasteImage<cr>", desc = "Paste image from system clipboard" },
      {
        "<leader>P",
        function()
          Snacks.picker.files({
            ft = { "jpg", "jpeg", "png", "webp" },
            confirm = function(self, item, _)
              self:close()
              require("img-clip").paste_image({}, "./" .. item.file)
            end,
          })
        end,
        desc = "Pick image from files",
      },
    },
  },
  {
    "mfussenegger/nvim-lint",
    opts = {
      linters = {
        ["markdownlint-cli2"] = {
          args = { "--config", vim.fn.expand("~/.markdownlint-cli2.jsonc"), "-" },
        },
      },
    },
  },
}

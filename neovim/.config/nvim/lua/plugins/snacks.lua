return {
  "folke/snacks.nvim",
  opts = {
    scroll = { enabled = false },
    image = {
      doc = {
        inline = true, -- don't render images automatically inline
        float = false, -- show float on CursorMoved over an image
      },
    },
  },
  keys = {
    {
      "<leader><space>",
      function()
        Snacks.picker.smart()
      end,
      desc = "Smart Find Files",
    },
  },
}

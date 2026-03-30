return {
  "folke/snacks.nvim",
  opts = {
    image = {
      doc = {
        inline = false, -- don't render images automatically inline
        float = true, -- show float on CursorMoved over an image
      },
    },
  },
  keys = {
    { "<leader><space>", function() Snacks.picker.smart() end, desc = "Smart Find Files" },
  },
}

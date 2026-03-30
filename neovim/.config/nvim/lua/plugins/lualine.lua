return {
  "nvim-lualine/lualine.nvim",
  opts = function(_, opts)
    table.insert(opts.sections.lualine_y, {
      function()
        local wc = vim.fn.wordcount()
        return wc.visual_chars .. " chars / " .. wc.visual_words .. " words"
      end,
      cond = function()
        local mode = vim.fn.mode()
        return mode == "v" or mode == "V" or mode == "\22" -- \22 = Ctrl-V
      end,
    })
  end,
}

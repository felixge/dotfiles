-- Fix which-key not recognizing grug-far's <localleader> keymaps.
-- Race condition: which-key scans buffer keymaps on BufEnter, but grug-far
-- sets its keymaps (\r, \s, etc.) after the buffer is displayed. By the time
-- grug-far calls setupBuffer(), which-key has already cached an empty tree
-- for the \ prefix. Clearing the cache on FileType lets which-key rescan
-- after the keymaps are in place.
--
-- Known upstream issue:
-- https://github.com/folke/which-key.nvim/issues/1029
return {
  {
    "MagicDuck/grug-far.nvim",
    config = function(_, opts)
      require("grug-far").setup(opts)
      vim.api.nvim_create_autocmd("FileType", {
        pattern = "grug-far",
        callback = function(ev)
          vim.defer_fn(function()
            local ok, wk_buf = pcall(require, "which-key.buf")
            if ok and wk_buf.bufs[ev.buf] then
              wk_buf.bufs[ev.buf]:clear()
            end
          end, 0)
        end,
      })
    end,
  },
}

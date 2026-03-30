-- Custom gopls setup for DataDog dd-source and dd-go repos.
-- These repos use dd-gopls instead of the regular gopls.

local go_root_markers = { "go.work", "go.mod", ".git" }

local function is_dd_gopls_file(fname)
  return fname:find("/github%.com/DataDog/dd%-source/") ~= nil or fname:find("/github%.com/DataDog/dd%-go/") ~= nil
end

return {
  {
    "neovim/nvim-lspconfig",
    opts = {
      servers = {
        -- Override gopls to skip dd-source and dd-go files
        gopls = {
          root_dir = function(bufnr, cb)
            if is_dd_gopls_file(vim.api.nvim_buf_get_name(bufnr)) then
              return
            end
            cb(vim.fs.root(bufnr, go_root_markers))
          end,
        },
        -- Use dd-gopls for dd-source and dd-go
        dd_gopls = {
          cmd = { "dd-gopls" },
          cmd_env = {
            GOPLS_DISABLE_MODULE_LOADS = 1,
          },
          filetypes = { "go", "gomod", "gowork", "gotmpl" },
          root_dir = function(bufnr, cb)
            if is_dd_gopls_file(vim.api.nvim_buf_get_name(bufnr)) then
              cb(vim.fs.root(bufnr, go_root_markers))
            end
          end,
        },
      },
    },
  },
}

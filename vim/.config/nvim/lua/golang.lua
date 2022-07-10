require('go').setup()

-- auto gofmt
vim.api.nvim_exec([[ autocmd BufWritePre *.go :silent! lua require('go.format').goimport() ]], false)

lspconfig = require "lspconfig"
util = require "lspconfig/util"

lspconfig.gopls.setup {
  cmd = {"gopls", "serve"},
  filetypes = {"go", "gomod"},
  root_dir = util.root_pattern("go.work", "go.mod", ".git"),
  settings = {
    gopls = {
      codelenses = {
        gc_details = true,
      },
      analyses = {
        unusedparams = true,
        QF1008 = false, -- see https://staticcheck.io/docs/checks
      },
      usePlaceholders = true,
      staticcheck = true,
      experimentalPostfixCompletions = true,
      experimentalWorkspaceModule = false,
    },
  },
}

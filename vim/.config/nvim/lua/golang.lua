require('go').setup()

-- auto gofmt
vim.api.nvim_exec([[ autocmd BufWritePre *.go :silent! lua require('go.format').goimport() ]], false)

local lspconfig = require "lspconfig"
local util = require "lspconfig/util"

-- allow overwriting gopls analysis config via environment variables, e.g. to
-- disable unsafeptr when hacking on the go runtime.
function env_overwrites(prefix, env)
  for k, v in pairs(vim.fn.environ()) do
    if k:find(prefix, 1, true) == 1 then
      k = k:sub(prefix:len()+1):lower()
      env[k] = v == true
    end
  end
  return env
end

-- integrate with cmp
local capabilities = require('cmp_nvim_lsp').update_capabilities(vim.lsp.protocol.make_client_capabilities())

lspconfig.gopls.setup {
  capabilities = capabilities,
  cmd = {"gopls", "serve"},
  filetypes = {"go", "gomod"},
  root_dir = util.root_pattern("go.work", "go.mod", ".git"),
  settings = {
    gopls = {
      codelenses = {
        gc_details = true,
      },
      analyses = env_overwrites("GOPLS_ANALYSES_", {
        unusedparams = true,
        QF1008 = false, -- see https://staticcheck.io/docs/checks
      }),
      usePlaceholders = true,
      staticcheck = true,
      experimentalPostfixCompletions = true,
      experimentalWorkspaceModule = false,
    },
  },
}

-- go keybindings and other stuff
vim.api.nvim_create_autocmd({"BufEnter"}, {
  pattern = '*.go',
  callback = function()
    vim.keymap.set('n', 'ga', '<cmd>GoAlt<CR>', { buffer=true })
    vim.o.expandtab = false
  end,
})

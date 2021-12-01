lua << EOF
-- see https://github.com/golang/tools/blob/master/gopls/doc/vim.md

-- https://github.com/ray-x/lsp_signature.nvim
require "lsp_signature".on_attach()

-- see https://www.getman.io/posts/programming-go-in-neovim/
local capabilities = vim.lsp.protocol.make_client_capabilities()
capabilities.textDocument.completion.completionItem.snippetSupport = true

local on_attach = function(client, bufnr)
  local function buf_set_option(...) vim.api.nvim_buf_set_option(bufnr, ...) end

  buf_set_option('omnifunc', 'v:lua.vim.lsp.omnifunc')
end

lspconfig = require "lspconfig"
lspconfig.gopls.setup {
  capabilities = capabilities,
  settings = {
    gopls = {
      codelenses = {
        gc_details = true, -- TODO: make this work
      },
      analyses = {
        unusedparams = true,
        -- see https://staticcheck.io/docs/checks
        QF1008 = false,
      },
      usePlaceholders = true,
      staticcheck = true,
      experimentalPostfixCompletions = true,
      experimentalWorkspaceModule = false,
    },
  },
  on_attach = on_attach,
}

-- https://github.com/neovim/nvim-lspconfig/issues/115#issuecomment-849865673
function go_organize_imports_sync(timeoutms)
    local context = {source = {organizeImports = true}}
    vim.validate {context = {context, 't', true}}

    local params = vim.lsp.util.make_range_params()
    params.context = context

    local method = 'textDocument/codeAction'
    local resp = vim.lsp.buf_request_sync(0, method, params, timeoutms)

    -- imports is indexed with clientid so we cannot rely on index always is 1
    for _, v in next, resp, nil do
      local result = v.result
      if result and result[1] then
        local edit = result[1].edit
        vim.lsp.util.apply_workspace_edit(edit)
      end
    end
    -- Always do formating
    vim.lsp.buf.formatting()
end
EOF

autocmd BufWritePre *.go lua go_organize_imports_sync(1000)

augroup ft_golang
  au!
  au BufEnter,BufNewFile,BufRead *.go setlocal noexpandtab
augroup END

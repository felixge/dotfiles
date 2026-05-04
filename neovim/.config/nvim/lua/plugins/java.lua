local function jdtls_definition()
  local params = vim.lsp.util.make_position_params(0, "utf-16")
  vim.lsp.buf_request(0, "textDocument/definition", params, function(err, result, ctx)
    if err then
      vim.notify(err.message or tostring(err), vim.log.levels.ERROR)
      return
    end
    if not result or vim.tbl_isempty(result) then
      vim.notify("No locations found", vim.log.levels.INFO)
      return
    end

    local location = vim.islist(result) and result[1] or result
    local uri = location.uri or location.targetUri
    local range = location.range or location.targetSelectionRange or location.targetRange
    if not uri or not range then
      vim.lsp.buf.definition()
      return
    end

    -- Neovim 0.12's default definition handler can ask nvim-jdtls to load a
    -- jdt:// decompiled class buffer and then set the cursor past the end of
    -- that generated buffer. Clamp the cursor for these virtual class files.
    if vim.startswith(uri, "jdt://") then
      local bufnr = vim.fn.bufadd(uri)
      vim.fn.bufload(bufnr)
      vim.bo[bufnr].buflisted = true
      vim.api.nvim_win_set_buf(0, bufnr)
      local line_count = math.max(vim.api.nvim_buf_line_count(bufnr), 1)
      local line = math.min((range.start.line or 0) + 1, line_count)
      local col = range.start.character or 0
      vim.api.nvim_win_set_cursor(0, { line, col })
      pcall(vim.cmd, "normal! zv")
      return
    end

    local client = ctx.client_id and vim.lsp.get_client_by_id(ctx.client_id)
    vim.lsp.util.show_document({ uri = uri, range = range }, client and client.offset_encoding or "utf-16", {
      focus = true,
    })
  end)
end

local function command_output(cmd)
  if vim.fn.executable(cmd[1]) ~= 1 then
    return nil
  end

  local output = vim.fn.system(cmd)
  if vim.v.shell_error ~= 0 then
    return nil
  end
  return vim.trim(output)
end

local function java_home(install_path)
  local home = install_path .. "/Contents/Home"
  if vim.fn.isdirectory(home) == 1 then
    return home
  end
  return install_path
end

local function java_runtime_name(home)
  local release = home .. "/release"
  if vim.fn.filereadable(release) ~= 1 then
    return nil
  end

  for _, line in ipairs(vim.fn.readfile(release)) do
    local version = line:match('^JAVA_VERSION="([^"]+)"')
    if version then
      if version:match("^1%.8") then
        return "JavaSE-1.8"
      end
      local major = version:match("^(%d+)")
      return major and ("JavaSE-" .. major) or nil
    end
  end
end

local function mise_java_home()
  local install_path = command_output({ "mise", "where", "java" })
  return install_path and java_home(install_path) or nil
end

local function mise_java_runtimes(current_home)
  local output = command_output({ "mise", "ls", "--json", "java" })
  if not output then
    return {}
  end

  local ok, installs = pcall(vim.json.decode, output)
  if not ok or type(installs) ~= "table" then
    return {}
  end

  local runtimes = {}
  local seen = {}
  for _, install in ipairs(installs) do
    if install.installed and install.install_path then
      local home = java_home(install.install_path)
      local name = java_runtime_name(home)
      if name and not seen[name] then
        seen[name] = true
        table.insert(runtimes, {
          name = name,
          path = home,
          default = current_home == home or install.active or nil,
        })
      end
    end
  end

  table.sort(runtimes, function(a, b)
    local a_version = tonumber(a.name:match("JavaSE%-(%d+)") or "8") or 8
    local b_version = tonumber(b.name:match("JavaSE%-(%d+)") or "8") or 8
    return a_version > b_version
  end)

  return runtimes
end

return {
  {
    "mfussenegger/nvim-jdtls",
    opts = function(_, opts)
      local current_java_home = mise_java_home()
      local runtimes = mise_java_runtimes(current_java_home)

      opts.settings = vim.tbl_deep_extend("force", opts.settings or {}, {
        java = {
          configuration = {
            runtimes = runtimes,
          },
          import = {
            gradle = {
              java = {
                home = current_java_home,
              },
            },
          },
        },
      })
    end,
  },
  {
    "neovim/nvim-lspconfig",
    init = function()
      vim.api.nvim_create_autocmd("LspAttach", {
        group = vim.api.nvim_create_augroup("jdtls_definition_workaround", { clear = true }),
        callback = function(args)
          local client = vim.lsp.get_client_by_id(args.data.client_id)
          if client and client.name == "jdtls" then
            vim.keymap.set("n", "gd", jdtls_definition, { buffer = args.buf, desc = "Goto Definition" })
          end
        end,
      })
    end,
  },
}

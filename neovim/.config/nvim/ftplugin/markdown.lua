-- Resolve /-prefixed paths as repo-relative (matching GitHub behavior).
-- Used by gf and other file-navigation commands.
vim.opt_local.includeexpr = "v:lua.require'config.markdown'.includeexpr(v:fname)"

-- Rename image under cursor and update all *.md references via grug-far.
-- %:h in the input expands to the current buffer's directory.
local function rename_image_at_cursor()
  local line = vim.api.nvim_get_current_line()
  local col = vim.api.nvim_win_get_cursor(0)[2] + 1

  -- Find image reference at cursor position: ![alt](path)
  local img_path
  local search_from = 1
  while true do
    local s, e, path = line:find('!%[[^%]]*%]%(([^%)]+)%)', search_from)
    if not s then
      break
    end
    if col >= s and col <= e then
      img_path = path
      break
    end
    search_from = e + 1
  end

  if not img_path then
    vim.notify('No image reference at cursor', vim.log.levels.WARN)
    return
  end

  local buf_dir = vim.fn.expand '%:p:h'

  -- Resolve old image to absolute path
  local old_abs = img_path:sub(1, 1) == '/'
      and img_path
    or vim.fn.fnamemodify(buf_dir .. '/' .. img_path, ':p')

  if vim.fn.filereadable(old_abs) == 0 then
    vim.notify('Image not found: ' .. old_abs, vim.log.levels.WARN)
    return
  end

  vim.ui.input({ prompt = 'Rename image: ', default = img_path }, function(new_input)
    if not new_input or new_input == '' or new_input == img_path then
      return
    end

    -- Expand %:h to the buffer's directory
    new_input = new_input:gsub('%%:h', buf_dir)

    -- Resolve new image to absolute path
    local new_abs = new_input:sub(1, 1) == '/'
        and new_input
      or vim.fn.fnamemodify(buf_dir .. '/' .. new_input, ':p')

    -- Derive relative path for markdown references (relative to buf_dir)
    local new_rel
    if new_abs:sub(1, #buf_dir + 1) == buf_dir .. '/' then
      new_rel = './' .. new_abs:sub(#buf_dir + 2)
    else
      new_rel = new_abs -- outside buf_dir, keep absolute
    end

    -- Create destination directory if needed
    vim.fn.mkdir(vim.fn.fnamemodify(new_abs, ':h'), 'p')

    if vim.fn.rename(old_abs, new_abs) ~= 0 then
      vim.notify('Rename failed: ' .. old_abs, vim.log.levels.ERROR)
      return
    end

    vim.notify(img_path .. ' → ' .. new_rel)
    require('grug-far').open({
      transient = true,
      startInInsertMode = false,
      prefills = {
        search = img_path,
        replacement = new_rel,
        filesFilter = '*.md',
      },
    })
  end)
end

vim.keymap.set('n', '<leader>ri', rename_image_at_cursor, { buffer = 0, desc = 'Rename image' })
-- Toggle markdown checkboxes with Enter
vim.keymap.set('n', '<CR>', function()
  local line = vim.api.nvim_get_current_line()
  local new_line = line:gsub('%- %[([%s xX])%]', function(state)
    return state:match '[xX]' and '- [ ]' or '- [x]'
  end)
  if new_line ~= line then
    vim.api.nvim_set_current_line(new_line)
  end
end, { buffer = 0, desc = 'Toggle markdown checkbox' })

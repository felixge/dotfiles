local telescope = require('telescope')

telescope.load_extension('fzf')
telescope.load_extension('ui-select')

telescope.setup{
  defaults = {
    dynamic_preview_title = true,
  },
  pickers = {
    lsp_workspace_symbols = { fname_direction = -1 },
    lsp_dynamic_workspace_symbols = { fname_direction = -1 },
  },
}

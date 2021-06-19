local M = {}
M.search_dotfiles = function()
    require("telescope.builtin").find_files({
        prompt_title = "< VimRC >",
        cwd = "$HOME/go/src/github.com/felixge/dotfiles/vim",
    })
end

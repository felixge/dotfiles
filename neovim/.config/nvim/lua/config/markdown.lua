local M = {}

--- Find the repo root by walking up from the current file looking for .git/
local function repo_root()
  local git_dir = vim.fn.finddir(".git", vim.fn.expand("%:p:h") .. ";")
  if git_dir ~= "" then
    return vim.fn.fnamemodify(git_dir, ":p:h:h")
  end
  return vim.fn.getcwd()
end

--- Rewrite /-prefixed filenames to be repo-relative (for gf, etc.)
function M.includeexpr(fname)
  if fname:sub(1, 1) == "/" then
    return repo_root() .. fname
  end
  return fname
end

return M

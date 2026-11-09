-- Per-project LSPs. Binaries come from `devenv shell` PATH (see devenv.nix).
-- Requires `vim.opt.exrc = true` (personal options) and nvim started with
-- cwd = this directory, otherwise this file is never sourced.
-- Safe for contributors without devenv: missing binaries just skip.

local function executable(cmd)
  return vim.fn.executable(cmd) == 1
end

if executable("typescript-language-server") then
  vim.lsp.enable("ts_ls")
end

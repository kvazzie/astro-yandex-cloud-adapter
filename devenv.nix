{ pkgs, ... }:

{
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_22;
    pnpm = {
      enable = true;
      # Repo pins pnpm@10 via `packageManager`; keep Nix pnpm on v10.
      package = pkgs.pnpm_10;
      install.enable = true;
    };
  };

  languages.typescript.enable = true;

  processes.s3 = {
    exec = "bash scripts/local-s3.sh ${pkgs.seaweedfs}/bin/weed";
    shutdown.grace = 45;
  };

  enterTest = ''
    export S3_TEST_ENDPOINT="http://127.0.0.1:$((18333 + 10#''${S3_TEST_PORT_OFFSET:-0}))"
    mkdir -p .artifacts
    {
      node --version
      pnpm --version
      ${pkgs.seaweedfs}/bin/weed version
      pnpm test:s3
    } 2>&1 | tee .artifacts/local-s3.log
  '';

  # Per-project LSP binaries. Neovim picks these up via .nvim.lua
  # (vim.lsp.enable), so no Mason packages and no global
  # LazyVim lang extras are needed for these two languages.
  packages = with pkgs; [
    # TypeScript: ts_ls wraps tsserver; the `typescript` package provides
    # the libs tsserver resolves. Falls back to cwd when no
    # tsconfig/package.json exists, so single-file exercises still attach.
    typescript-language-server
  ];
}

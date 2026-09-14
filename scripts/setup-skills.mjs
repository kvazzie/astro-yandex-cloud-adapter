#!/usr/bin/env node

import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { stdout } from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

stdout.write("restoring project agent skills from skills-lock.json...\n");
execSync("npx skills experimental_install", {
  cwd: root,
  stdio: "inherit",
});

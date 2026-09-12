#!/usr/bin/env node

import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

console.log("restoring project agent skills from skills-lock.json...");
execSync("npx skills experimental_install", {
  cwd: root,
  stdio: "inherit",
});

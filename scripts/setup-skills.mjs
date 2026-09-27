#!/usr/bin/env node
// Fresh-clone and worktree bootstrap for project skills.
//
// 1. Restores external skill dependencies from skills-lock.json, one CLI
//    call per source with every skill name passed explicitly.
// 2. Re-creates harness symlinks for any project-owned skills.
// Project-owned skills are un-ignored explicitly in the root .gitignore.
//
// Usage:
// node scripts/setup-skills.mjs [--links-only]
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = join(ROOT, ".agents", "skills");
const LINK_DIRS = [join(ROOT, ".claude", "skills")];
const REQUIRED_LOCKED_SKILLS = ["triage", "wayfinder"];

const linksOnly = process.argv.includes("--links-only");
const rel = (path) => relative(ROOT, path);

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function ownSkillNames() {
  let gitignore;
  try {
    gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
  } catch {
    console.warn("warn: no root .gitignore found, nothing to link");
    return [];
  }
  const matches = gitignore.matchAll(/^!\.agents\/skills\/([^/\s]+)\/?\s*$/gm);
  // Dotfiles (like the tracked .gitignore placeholder) are infrastructure,
  // not owned skills.
  return [...matches]
    .map((match) => match[1])
    .filter((name) => !name.startsWith("."));
}

function readSkillLock() {
  return JSON.parse(readFileSync(join(ROOT, "skills-lock.json"), "utf8"));
}

function lockedSkillsBySource() {
  const lock = readSkillLock();
  const missing = REQUIRED_LOCKED_SKILLS.filter((name) => !lock.skills?.[name]);
  if (missing.length > 0) {
    throw new Error(`skills-lock.json must include: ${missing.join(", ")}`);
  }

  const bySource = new Map();
  for (const [name, entry] of Object.entries(lock.skills)) {
    if (!entry.source) {
      throw new Error(`skills-lock.json has no source for ${name}`);
    }
    const names = bySource.get(entry.source) ?? [];
    names.push(name);
    bySource.set(entry.source, names);
  }
  return bySource;
}

function restoreLockedSkills() {
  for (const [source, names] of lockedSkillsBySource()) {
    const sortedNames = [...names].sort();
    console.log(`restoring ${sortedNames.length} project skills from ${source}…`);
    execFileSync(
      "npx",
      [
        "--yes",
        "skills",
        "add",
        source,
        "--yes",
        ...sortedNames.flatMap((name) => ["--skill", name]),
      ],
      { cwd: ROOT, stdio: "inherit" },
    );
  }
}

function ensureSymlink(linkPath, sourcePath) {
  const target = relative(dirname(linkPath), sourcePath);
  if (pathExists(linkPath)) {
    if (
      lstatSync(linkPath).isSymbolicLink() &&
      readlinkSync(linkPath) === target
    ) {
      console.log(`ok: ${rel(linkPath)} already linked`);
      return;
    }
    console.warn(
      `skip: ${rel(linkPath)} exists and is not the expected link, fix manually`,
    );
    return;
  }
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath);
  console.log(`linked: ${rel(linkPath)} -> ${target}`);
}

if (!linksOnly) {
  restoreLockedSkills();
}

for (const name of ownSkillNames()) {
  const source = join(SOURCE_DIR, name);
  if (!pathExists(source)) {
    console.warn(`skip: ${rel(source)} does not exist`);
    continue;
  }
  for (const dir of LINK_DIRS) {
    ensureSymlink(join(dir, name), source);
  }
}

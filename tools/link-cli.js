#!/usr/bin/env node
/**
 * Install CLI shims next to node.exe (already on PATH).
 * Same approach as parkourBot bot/scripts/link-*.js — one registry, many commands.
 *
 * Usage (from repo root):
 *   npm run link              # install all registered CLIs
 *   npm run link -- gops      # install one
 *   npm run link -- --list
 *   npm run link -- --unlink
 *   npm run link -- --unlink gops
 *
 * Add a command: edit tools/cli-links.json
 *   { "name": { "entry": "tools/foo.js", "description": "..." } }
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = path.join(__dirname, "..");
const REGISTRY_PATH = path.join(__dirname, "cli-links.json");

function loadRegistry() {
  const raw = fs.readFileSync(REGISTRY_PATH, "utf8");
  const reg = JSON.parse(raw);
  if (!reg || typeof reg !== "object" || Array.isArray(reg)) {
    throw new Error(`Invalid registry: ${REGISTRY_PATH}`);
  }
  return reg;
}

function resolveNodeExe() {
  try {
    const lines = execSync("where node", { encoding: "utf8", windowsHide: true })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const preferred = lines.find((p) => /\\nodejs\\/i.test(p));
    if (preferred) return preferred;
    const system = lines.find((p) => !/node_modules|cursor[\\/]resources/i.test(p));
    if (system) return system;
    if (lines[0]) return lines[0];
  } catch (_) {}
  return process.execPath;
}

function shimPaths(nodeExe, name) {
  const nodeDir = path.dirname(nodeExe);
  return {
    nodeDir,
    nodeExe,
    cmdPath: path.join(nodeDir, `${name}.cmd`),
    ps1Path: path.join(nodeDir, `${name}.ps1`),
  };
}

function resolveEntry(entry) {
  const abs = path.isAbsolute(entry) ? entry : path.join(REPO_ROOT, entry);
  if (!fs.existsSync(abs)) {
    throw new Error(`Entry not found for link: ${abs}`);
  }
  return abs;
}

function writeShims(name, entryAbs, paths) {
  const { nodeExe, cmdPath, ps1Path } = paths;
  const cmdContent = `@ECHO off\r\n"${nodeExe}" "${entryAbs}" %*\r\n`;
  const ps1Content = `& "${nodeExe}" "${entryAbs}" @args\r\n`;
  fs.writeFileSync(cmdPath, cmdContent, "utf8");
  fs.writeFileSync(ps1Path, ps1Content, "utf8");
  console.log(`[link] Wrote ${cmdPath}`);
  console.log(`[link] Wrote ${ps1Path}`);
}

function removeShims(paths) {
  for (const p of [paths.cmdPath, paths.ps1Path]) {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        console.log(`[link] Removed ${p}`);
      }
    } catch (err) {
      console.warn(`[link] Could not remove ${p}: ${err.message}`);
    }
  }
}

function parseArgs(argv) {
  const flags = new Set();
  const names = [];
  for (const a of argv) {
    if (a.startsWith("--")) flags.add(a.slice(2));
    else names.push(a);
  }
  return { flags, names };
}

function main() {
  const { flags, names } = parseArgs(process.argv.slice(2));
  const registry = loadRegistry();
  const allNames = Object.keys(registry);

  if (flags.has("list") || flags.has("help") || flags.has("h")) {
    console.log("Registered CLIs (tools/cli-links.json):");
    for (const name of allNames) {
      const e = registry[name];
      console.log(`  ${name.padEnd(12)} ${e.entry}  — ${e.description || ""}`);
    }
    console.log();
    console.log("npm run link");
    console.log("npm run link -- gops");
    console.log("npm run link -- --unlink");
    return;
  }

  const selected = names.length ? names : allNames;
  for (const name of selected) {
    if (!registry[name]) {
      console.error(`[link] Unknown command "${name}". Known: ${allNames.join(", ")}`);
      process.exit(1);
    }
  }

  const nodeExe = resolveNodeExe();
  console.log(`[link] node=${nodeExe}`);

  for (const name of selected) {
    const entryAbs = resolveEntry(registry[name].entry);
    const paths = shimPaths(nodeExe, name);
    if (flags.has("unlink")) {
      removeShims(paths);
      continue;
    }
    try {
      writeShims(name, entryAbs, paths);
    } catch (err) {
      if (err.code === "EPERM" || err.code === "EACCES") {
        console.error(`[link] Permission denied writing to ${paths.nodeDir}`);
        console.error("Re-run the terminal as Administrator, or use: node tools/gops.js <N>");
        process.exit(1);
      }
      throw err;
    }
  }

  if (flags.has("unlink")) {
    console.log("[link] Done — shims removed");
    return;
  }

  console.log("[link] Done — open a new terminal and run e.g. gops 5");
}

main();

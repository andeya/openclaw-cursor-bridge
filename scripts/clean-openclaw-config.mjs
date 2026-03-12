#!/usr/bin/env node
/**
 * Remove stale openclaw-cursor-brain entries from openclaw.json so
 * "openclaw plugins install ./" can run when config references the plugin
 * but the plugin is not installed (e.g. after uninstall or failed install).
 *
 * Usage: node scripts/clean-openclaw-config.mjs
 *    or: OPENCLAW_CONFIG_PATH=/path/to/openclaw.json node scripts/clean-openclaw-config.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const PLUGIN_ID = "openclaw-cursor-brain";
const configPath =
  process.env.OPENCLAW_CONFIG_PATH ||
  join(homedir(), ".openclaw", "openclaw.json");

if (!existsSync(configPath)) {
  console.error("Config not found:", configPath);
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(configPath, "utf-8");
} catch (e) {
  console.error("Could not read config:", e.message);
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(raw);
} catch (e) {
  console.error("Invalid JSON in config:", e.message);
  process.exit(1);
}

const plugins = cfg.plugins;
if (!plugins) {
  console.log("No plugins section; nothing to clean.");
  process.exit(0);
}

let changed = false;

if (plugins.entries?.[PLUGIN_ID]) {
  delete plugins.entries[PLUGIN_ID];
  changed = true;
}
if (plugins.installs?.[PLUGIN_ID]) {
  delete plugins.installs[PLUGIN_ID];
  changed = true;
}
if (Array.isArray(plugins.allow)) {
  const idx = plugins.allow.indexOf(PLUGIN_ID);
  if (idx !== -1) {
    plugins.allow.splice(idx, 1);
    changed = true;
  }
}

if (!changed) {
  console.log("No stale entries for", PLUGIN_ID, "found.");
  process.exit(0);
}

try {
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
  console.log("Cleaned stale plugin entries from", configPath);
  console.log("You can now run: openclaw plugins install ./");
} catch (e) {
  console.error("Could not write config:", e.message);
  process.exit(1);
}

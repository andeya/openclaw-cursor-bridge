#!/usr/bin/env node
/**
 * Full uninstall: remove plugin entries from openclaw.json, extension dir,
 * MCP server entry from Cursor mcp.json, and provider/model refs from openclaw.json.
 * Reused by: npm run uninstall (standalone), openclaw cursor-brain uninstall, and upgrade (--config-only).
 *
 * Usage: node scripts/uninstall.mjs [--config-only]
 *   --config-only  Only clean openclaw.json + MCP config; do not remove extension dir (used by upgrade).
 *   OPENCLAW_CONFIG_PATH, OPENCLAW_EXTENSIONS_DIR, CURSOR_MCP_JSON override paths.
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const configOnly = process.argv.includes("--config-only");
const PLUGIN_ID = "openclaw-cursor-brain";
const MCP_SERVER_ID = "openclaw-gateway";
const PROVIDER_ID = "cursor-local";

const configPath =
  process.env.OPENCLAW_CONFIG_PATH ||
  join(homedir(), ".openclaw", "openclaw.json");
const extensionsDir =
  process.env.OPENCLAW_EXTENSIONS_DIR ||
  join(homedir(), ".openclaw", "extensions", PLUGIN_ID);
const cursorMcpPath =
  process.env.CURSOR_MCP_JSON ||
  join(homedir(), ".cursor", "mcp.json");

let hasError = false;
const log = (msg) => console.log(msg);
const logErr = (msg) => {
  console.error(msg);
  hasError = true;
};

// ── 1. OpenClaw config: plugin entries + provider + model refs ─────────────
let cfg;
if (existsSync(configPath)) {
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (e) {
    logErr("Could not read config: " + e.message);
    process.exit(1);
  }
} else {
  cfg = {};
}

let configChanged = false;
const plugins = cfg.plugins || {};

if (plugins.entries?.[PLUGIN_ID]) {
  delete plugins.entries[PLUGIN_ID];
  configChanged = true;
}
if (plugins.installs?.[PLUGIN_ID]) {
  delete plugins.installs[PLUGIN_ID];
  configChanged = true;
}
if (Array.isArray(plugins.allow)) {
  const idx = plugins.allow.indexOf(PLUGIN_ID);
  if (idx !== -1) {
    plugins.allow.splice(idx, 1);
    configChanged = true;
  }
}

const prefix = `${PROVIDER_ID}/`;
const defaults = cfg.agents?.defaults;
if (defaults?.model) {
  if ((defaults.model.primary || "").toString().startsWith(prefix)) {
    delete defaults.model.primary;
    configChanged = true;
  }
  if (defaults.model.fallbacks && Array.isArray(defaults.model.fallbacks)) {
    const cleaned = defaults.model.fallbacks.filter((f) => !f.startsWith(prefix));
    if (cleaned.length !== defaults.model.fallbacks.length) {
      defaults.model.fallbacks = cleaned.length ? cleaned : undefined;
      configChanged = true;
    }
  }
  if (!defaults.model.primary && !defaults.model.fallbacks) {
    delete defaults.model;
  }
}
if (cfg.models?.providers?.[PROVIDER_ID]) {
  delete cfg.models.providers[PROVIDER_ID];
  if (Object.keys(cfg.models.providers || {}).length === 0) delete cfg.models.providers;
  configChanged = true;
}

if (configChanged) {
  try {
    writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
    log("Cleaned openclaw.json (plugin entries + provider + model refs)");
  } catch (e) {
    logErr("Could not write config: " + e.message);
    process.exit(1);
  }
}

// ── 2. Cursor MCP config ──────────────────────────────────────────────────
let mcpRemoved = false;
if (existsSync(cursorMcpPath)) {
  try {
    const raw = JSON.parse(readFileSync(cursorMcpPath, "utf-8"));
    const servers = raw?.mcpServers;
    if (servers?.[MCP_SERVER_ID]) {
      delete servers[MCP_SERVER_ID];
      writeFileSync(cursorMcpPath, JSON.stringify(raw, null, 2) + "\n");
      mcpRemoved = true;
      log("Removed MCP server from " + cursorMcpPath);
    }
  } catch (e) {
    logErr("MCP cleanup: " + e.message);
  }
}

// ── 3. Extension dir (skip when --config-only, e.g. upgrade) ─────────────────
let extensionRemoved = false;
if (!configOnly && existsSync(extensionsDir)) {
  try {
    rmSync(extensionsDir, { recursive: true, force: true });
    extensionRemoved = true;
    log("Removed extension dir: " + extensionsDir);
  } catch (e) {
    logErr("Could not remove extension dir: " + e.message);
  }
}

if (!configChanged && !mcpRemoved && !extensionRemoved) {
  log("Nothing to remove for " + PLUGIN_ID);
}

if (hasError) process.exit(1);
log("You can now run: openclaw plugins install ./");

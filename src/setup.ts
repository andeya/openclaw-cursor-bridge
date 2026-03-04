import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { execSync } from "child_process";
import type { PluginLogger } from "openclaw/plugin-sdk";
import {
  getCursorMcpConfigPath,
  getCursorSearchPaths,
  getWhichCommand,
  MCP_SERVER_ID,
  CLI_BACKEND_ID,
  CLI_BACKEND_COMMON,
  OPENCLAW_CONFIG_PATH,
  buildShellArgs,
} from "./constants.js";

export type SetupContext = {
  pluginDir: string;
  gatewayPort: number;
  gatewayToken: string;
  workspaceDir: string;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
};

export type SetupResult = {
  cursorPath: string | null;
  mcpConfigured: boolean;
  cliBackendConfigured: boolean;
  errors: string[];
  warnings: string[];
};

export function detectCursorPath(overridePath?: string): string | null {
  if (overridePath && existsSync(overridePath)) return overridePath;

  try {
    const which = execSync(getWhichCommand(), { encoding: "utf-8" }).trim();
    const first = which.split("\n")[0]?.trim();
    if (first && existsSync(first)) return first;
  } catch { /* not on PATH */ }

  for (const p of getCursorSearchPaths()) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function configureMcpJson(ctx: SetupContext): boolean {
  const mcpServerPath = join(ctx.pluginDir, "mcp-server", "server.mjs");
  if (!existsSync(mcpServerPath)) {
    ctx.logger.warn(`MCP server not found at ${mcpServerPath}`);
    return false;
  }

  const mcpConfigPath = getCursorMcpConfigPath();
  const gatewayUrl = `http://127.0.0.1:${ctx.gatewayPort}`;

  const newEntry = {
    command: "node",
    args: [mcpServerPath],
    env: {
      OPENCLAW_GATEWAY_URL: gatewayUrl,
      OPENCLAW_GATEWAY_TOKEN: ctx.gatewayToken,
      OPENCLAW_CONFIG_PATH: OPENCLAW_CONFIG_PATH,
    },
  };

  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(mcpConfigPath)) {
      existing = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
    }
  } catch {
    existing = {};
  }

  const servers = (existing.mcpServers || {}) as Record<string, unknown>;
  const current = servers[MCP_SERVER_ID] as Record<string, unknown> | undefined;

  if (
    current &&
    JSON.stringify((current as any).args) === JSON.stringify(newEntry.args) &&
    JSON.stringify((current as any).env) === JSON.stringify(newEntry.env)
  ) {
    return true;
  }

  servers[MCP_SERVER_ID] = newEntry;
  existing.mcpServers = servers;

  mkdirSync(dirname(mcpConfigPath), { recursive: true });
  writeFileSync(mcpConfigPath, JSON.stringify(existing, null, 2) + "\n");
  ctx.logger.info(`Wrote MCP config to ${mcpConfigPath}`);
  return true;
}

export function buildCliBackendConfig(cursorPath: string, workspaceDir: string) {
  const shell = buildShellArgs(cursorPath, workspaceDir);
  return { ...CLI_BACKEND_COMMON, ...shell };
}

export function runSetup(ctx: SetupContext): SetupResult {
  const result: SetupResult = {
    cursorPath: null,
    mcpConfigured: false,
    cliBackendConfigured: false,
    errors: [],
    warnings: [],
  };

  const overridePath = ctx.pluginConfig?.cursorPath as string | undefined;
  result.cursorPath = detectCursorPath(overridePath);

  if (!result.cursorPath) {
    result.errors.push(
      "Cursor Agent CLI not found. Install it from https://cursor.sh or set plugins.entries.cursor-bridge.config.cursorPath"
    );
    return result;
  }
  ctx.logger.info(`Cursor Agent found at ${result.cursorPath}`);

  result.mcpConfigured = configureMcpJson(ctx);
  if (!result.mcpConfigured) {
    result.errors.push(`Failed to configure MCP bridge in ${getCursorMcpConfigPath()}`);
  }

  return result;
}

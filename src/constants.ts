import { homedir } from "os";
import { join } from "path";

export const PLUGIN_ID = "openclaw-cursor-brain";
export const MCP_SERVER_ID = "openclaw-gateway";
export const PROVIDER_ID = "cursor-local";
export const DEFAULT_PROXY_PORT = 18790;


const OPENCLAW_HOME = join(homedir(), ".openclaw");
export const OPENCLAW_LOGS_DIR = join(OPENCLAW_HOME, "logs");
export const OPENCLAW_CONFIG_PATH = join(OPENCLAW_HOME, "openclaw.json");
/** Persistent proxy options (file wins over env). Written by plugin when starting proxy; read by proxy on startup. */
export const CURSOR_PROXY_CONFIG_PATH = join(OPENCLAW_HOME, "cursor-proxy.json");
export const CURSOR_PROXY_LOG_PATH = join(OPENCLAW_LOGS_DIR, "cursor-proxy.log");
export const CURSOR_PROXY_STDERR_LOG_PATH = join(OPENCLAW_LOGS_DIR, "cursor-proxy.stderr.log");

export function getCursorMcpConfigPath(): string {
  return join(homedir(), ".cursor", "mcp.json");
}

export function getCursorSearchPaths(): string[] {
  const home = homedir();
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return [
      join(localAppData, "Programs", "cursor", "resources", "app", "bin", "agent.exe"),
      join(localAppData, "cursor-agent", "agent.cmd"),
      join(home, ".cursor", "bin", "agent.exe"),
      join(home, ".cursor", "bin", "agent.cmd"),
      join(home, ".local", "bin", "agent.exe"),
    ];
  }
  return [
    join(home, ".local", "bin", "agent"),
    "/usr/local/bin/agent",
    join(home, ".cursor", "bin", "agent"),
  ];
}

export function getWhichCommand(): string {
  return process.platform === "win32" ? "where agent 2>nul" : "which agent 2>/dev/null";
}

export type OutputFormat = "stream-json" | "json";

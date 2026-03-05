import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { execSync } from "child_process";
import type { PluginLogger } from "openclaw/plugin-sdk";
import {
  getCursorMcpConfigPath,
  getCursorSearchPaths,
  getWhichCommand,
  MCP_SERVER_ID,
  OPENCLAW_CONFIG_PATH,
  type OutputFormat,
} from "./constants.js";

export type SetupContext = {
  pluginDir: string;
  gatewayPort: number;
  gatewayToken: string;
  workspaceDir: string;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
};

export type CursorModel = {
  id: string;
  name: string;
  reasoning: boolean;
  isDefault: boolean;
};

export type SetupResult = {
  cursorPath: string | null;
  outputFormat: OutputFormat;
  mcpConfigured: boolean;
  cursorModels: CursorModel[];
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

function cursorSupportsStreamJson(cursorPath: string): boolean {
  try {
    const output = execSync(`"${cursorPath}" --help`, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output.includes("stream-json");
  } catch (e: any) {
    const combined = (e.stdout || "") + (e.stderr || "");
    return combined.includes("stream-json");
  }
}

export function discoverCursorModels(
  cursorPath: string,
  logger?: PluginLogger,
  { retries = 2, timeoutMs = 30000 }: { retries?: number; timeoutMs?: number } = {},
): CursorModel[] {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const output = execSync(`"${cursorPath}" --list-models`, {
        encoding: "utf-8",
        timeout: timeoutMs,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const models: CursorModel[] = [];
      for (const line of output.split("\n")) {
        const match = line.match(/^(\S+)\s+-\s+(.+?)(?:\s+\((current|default)\))?$/);
        if (!match) continue;
        const [, id, rawName, annotation] = match;
        const name = rawName.trim();
        models.push({
          id,
          name,
          reasoning: id.includes("thinking"),
          isDefault: annotation === "default",
        });
      }
      if (models.length > 0) {
        logger?.info(`Discovered ${models.length} cursor-agent models`);
        return models;
      }
      lastError = new Error("command succeeded but parsed 0 models from output");
    } catch (e: any) {
      lastError = e;
    }
    if (attempt < retries) {
      logger?.warn(`Model discovery attempt ${attempt + 1} failed (${lastError?.message}), retrying...`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
  }
  logger?.warn(`Could not list cursor-agent models after ${retries + 1} attempts: ${lastError?.message}`);
  return [];
}

export function detectOutputFormat(
  cursorPath: string,
  userOverride?: string,
  logger?: PluginLogger,
): OutputFormat {
  if (userOverride === "stream-json" || userOverride === "json") {
    logger?.info(`Output format: "${userOverride}" (explicit config)`);
    return userOverride;
  }

  const cursorOk = cursorSupportsStreamJson(cursorPath);
  if (!cursorOk) {
    logger?.info(`Output format: "json" (cursor-agent does not advertise stream-json)`);
    return "json";
  }

  logger?.info(`Output format: "stream-json" (cursor-agent supports it)`);
  return "stream-json";
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

export function runSetup(ctx: SetupContext): SetupResult {
  const result: SetupResult = {
    cursorPath: null,
    outputFormat: "json",
    mcpConfigured: false,
    cursorModels: [],
    errors: [],
    warnings: [],
  };

  const overridePath = ctx.pluginConfig?.cursorPath as string | undefined;
  result.cursorPath = detectCursorPath(overridePath);

  if (!result.cursorPath) {
    result.errors.push(
      "Cursor Agent CLI not found. Install it from https://cursor.sh or set plugins.entries.openclaw-cursor-brain.config.cursorPath"
    );
    return result;
  }
  ctx.logger.info(`Cursor Agent found at ${result.cursorPath}`);

  result.outputFormat = detectOutputFormat(
    result.cursorPath,
    ctx.pluginConfig?.outputFormat as string | undefined,
    ctx.logger,
  );

  result.cursorModels = discoverCursorModels(result.cursorPath, ctx.logger);

  result.mcpConfigured = configureMcpJson(ctx);
  if (!result.mcpConfigured) {
    result.errors.push(`Failed to configure MCP server in ${getCursorMcpConfigPath()}`);
  }

  return result;
}

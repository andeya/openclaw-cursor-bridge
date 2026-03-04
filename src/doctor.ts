import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import {
  getCursorMcpConfigPath,
  MCP_SERVER_ID,
  OPENCLAW_CONFIG_PATH,
} from "./constants.js";
import { detectCursorPath } from "./setup.js";

export type CheckResult = { ok: boolean; label: string; detail: string };

export function runDoctorChecks(opts: {
  gatewayPort: number;
  gatewayToken: string;
  pluginDir: string;
  cursorPathOverride?: string;
}): CheckResult[] {
  const checks: CheckResult[] = [];

  const cursorPath = detectCursorPath(opts.cursorPathOverride);
  checks.push(
    cursorPath
      ? { ok: true, label: "Cursor Agent CLI", detail: cursorPath }
      : { ok: false, label: "Cursor Agent CLI", detail: "Not found. Install from https://cursor.sh" },
  );

  const mcpServerPath = join(opts.pluginDir, "mcp-server", "server.mjs");
  checks.push(
    existsSync(mcpServerPath)
      ? { ok: true, label: "MCP server file", detail: mcpServerPath }
      : { ok: false, label: "MCP server file", detail: `Missing: ${mcpServerPath}` },
  );

  const sdkPath = join(opts.pluginDir, "node_modules", "@modelcontextprotocol", "sdk");
  checks.push(
    existsSync(sdkPath)
      ? { ok: true, label: "MCP SDK dependency", detail: "installed" }
      : { ok: false, label: "MCP SDK dependency", detail: `Missing: run npm install in ${opts.pluginDir}` },
  );

  const mcpConfigPath = getCursorMcpConfigPath();
  try {
    if (existsSync(mcpConfigPath)) {
      const cfg = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
      const entry = cfg?.mcpServers?.[MCP_SERVER_ID];
      checks.push(
        entry
          ? { ok: true, label: "Cursor mcp.json", detail: `Server "${MCP_SERVER_ID}" configured` }
          : { ok: false, label: "Cursor mcp.json", detail: `Server "${MCP_SERVER_ID}" not found in config` },
      );
    } else {
      checks.push({ ok: false, label: "Cursor mcp.json", detail: `File does not exist: ${mcpConfigPath}` });
    }
  } catch (e: any) {
    checks.push({ ok: false, label: "Cursor mcp.json", detail: `Parse error: ${e.message}` });
  }

  checks.push(
    existsSync(OPENCLAW_CONFIG_PATH)
      ? { ok: true, label: "OpenClaw config", detail: OPENCLAW_CONFIG_PATH }
      : { ok: false, label: "OpenClaw config", detail: `Missing: ${OPENCLAW_CONFIG_PATH}` },
  );

  checks.push(createGatewayCheck(opts.gatewayPort, opts.gatewayToken));

  return checks;
}

function createGatewayCheck(port: number, token: string): CheckResult {
  try {
    const isWin = process.platform === "win32";

    if (isWin) {
      const script = `
        const r = await fetch("http://127.0.0.1:${port}/tools/invoke", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer ${token}" },
          body: '{"tool":"__ping__","args":{}}'
        });
        process.stdout.write(String(r.status));
      `;
      const status = execSync(`node -e "${script.replace(/"/g, '\\"')}"`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      const code = parseInt(status, 10);
      const ok = code >= 200 && code < 500;
      return ok
        ? { ok: true, label: "Gateway REST API", detail: `http://127.0.0.1:${port} (HTTP ${code})` }
        : { ok: false, label: "Gateway REST API", detail: `HTTP ${code}` };
    }

    const status = execSync(
      `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${port}/tools/invoke -X POST ` +
        `-H "Authorization: Bearer ${token}" -H "Content-Type: application/json" ` +
        `-d '{"tool":"__ping__","args":{}}' 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    const code = parseInt(status, 10);
    const ok = code >= 200 && code < 500;
    return ok
      ? { ok: true, label: "Gateway REST API", detail: `http://127.0.0.1:${port} (HTTP ${code})` }
      : { ok: false, label: "Gateway REST API", detail: `HTTP ${code}` };
  } catch {
    return { ok: false, label: "Gateway REST API", detail: "Unreachable (is the gateway running?)" };
  }
}

export function formatDoctorResults(checks: CheckResult[]): string {
  const lines = ["Cursor Bridge Doctor", ""];
  for (const c of checks) {
    const icon = c.ok ? "\u2713" : "\u2717";
    lines.push(`  ${icon} ${c.label}: ${c.detail}`);
  }
  const passed = checks.filter((c) => c.ok).length;
  lines.push("", `${passed}/${checks.length} checks passed`);
  if (passed < checks.length) {
    lines.push("Run `openclaw cursor-bridge setup` to fix configuration issues.");
  }
  return lines.join("\n");
}

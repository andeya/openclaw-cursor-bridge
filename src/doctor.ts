import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import {
  getCursorMcpConfigPath,
  MCP_SERVER_ID,
  PROVIDER_ID,
  OPENCLAW_CONFIG_PATH,
} from "./constants.js";
import { detectCursorPath, detectOutputFormat } from "./setup.js";

export type CheckResult = { ok: boolean; label: string; detail: string };

function getCursorVersion(cursorPath: string): string | null {
  try {
    const output = execSync(`"${cursorPath}" --version`, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output.trim().split("\n")[0]?.trim() || null;
  } catch (e: any) {
    const combined = ((e.stdout || "") + (e.stderr || "")).trim();
    return combined.split("\n")[0]?.trim() || null;
  }
}

function getPluginVersion(pluginDir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf-8"));
    return pkg.version || null;
  } catch {
    return null;
  }
}

export function countDiscoveredTools(): number | null {
  try {
    const config = JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, "utf-8"));
    const installs = config.plugins?.installs || {};
    const names = new Set<string>();

    for (const [, info] of Object.entries(installs)) {
      const installPath = (info as any).installPath;
      if (!installPath || !existsSync(installPath)) continue;
      const srcDir = join(installPath, "src");
      if (!existsSync(srcDir)) continue;

      const files = readdirSync(srcDir).filter(
        (f: string) => f.endsWith(".ts") && !f.includes(".test.") && !f.includes(".d.ts"),
      );
      for (const file of files) {
        try {
          const content = readFileSync(join(srcDir, file), "utf-8");
          for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("name:") && !trimmed.startsWith('"name"')) continue;
            const match = trimmed.match(/^(?:name|"name")\s*:\s*['"]([a-zA-Z_]\w{2,})['"]/);
            if (match) names.add(match[1]);
          }
        } catch { /* skip */ }
      }
    }
    return names.size;
  } catch {
    return null;
  }
}

export function runDoctorChecks(opts: {
  gatewayPort: number;
  gatewayToken: string;
  pluginDir: string;
  cursorPathOverride?: string;
}): CheckResult[] {
  const checks: CheckResult[] = [];

  // Plugin version
  const pluginVersion = getPluginVersion(opts.pluginDir);
  checks.push(
    pluginVersion
      ? { ok: true, label: "Plugin version", detail: `v${pluginVersion}` }
      : { ok: false, label: "Plugin version", detail: "unknown (package.json missing or unreadable)" },
  );

  // Cursor Agent CLI
  const cursorPath = detectCursorPath(opts.cursorPathOverride);
  checks.push(
    cursorPath
      ? { ok: true, label: "Cursor Agent CLI", detail: cursorPath }
      : { ok: false, label: "Cursor Agent CLI", detail: "Not found. Install from https://cursor.sh" },
  );

  // Cursor agent version
  if (cursorPath) {
    const version = getCursorVersion(cursorPath);
    checks.push(
      version
        ? { ok: true, label: "Cursor Agent version", detail: version }
        : { ok: true, label: "Cursor Agent version", detail: "unknown (--version not supported)" },
    );
  }

  // MCP server file
  const mcpServerPath = join(opts.pluginDir, "mcp-server", "server.mjs");
  checks.push(
    existsSync(mcpServerPath)
      ? { ok: true, label: "MCP server file", detail: mcpServerPath }
      : { ok: false, label: "MCP server file", detail: `Missing: ${mcpServerPath}` },
  );

  // MCP SDK dependency
  const sdkPath = join(opts.pluginDir, "node_modules", "@modelcontextprotocol", "sdk");
  checks.push(
    existsSync(sdkPath)
      ? { ok: true, label: "MCP SDK dependency", detail: "installed" }
      : { ok: false, label: "MCP SDK dependency", detail: `Missing: run npm install in ${opts.pluginDir}` },
  );

  // Cursor mcp.json
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

  // OpenClaw config
  checks.push(
    existsSync(OPENCLAW_CONFIG_PATH)
      ? { ok: true, label: "OpenClaw config", detail: OPENCLAW_CONFIG_PATH }
      : { ok: false, label: "OpenClaw config", detail: `Missing: ${OPENCLAW_CONFIG_PATH}` },
  );

  // Streaming proxy provider configured
  if (existsSync(OPENCLAW_CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, "utf-8"));
      const provider = cfg?.models?.providers?.[PROVIDER_ID];
      checks.push(
        provider
          ? { ok: true, label: "Streaming provider", detail: `"${PROVIDER_ID}" configured (${provider.baseUrl || "unknown"})` }
          : { ok: false, label: "Streaming provider", detail: `"${PROVIDER_ID}" not found in openclaw.json` },
      );
    } catch {
      checks.push({ ok: false, label: "Streaming provider", detail: "Could not parse openclaw.json" });
    }
  }

  // Output format detection
  if (cursorPath) {
    const detected = detectOutputFormat(cursorPath);
    checks.push({
      ok: true,
      label: "Output format (detected)",
      detail: `"${detected}"${detected === "stream-json" ? " (streaming + thinking)" : " (batch)"}`,
    });
  }

  // Discovered tools count
  const toolCount = countDiscoveredTools();
  if (toolCount !== null) {
    checks.push({
      ok: toolCount > 0,
      label: "Discovered tool candidates",
      detail: toolCount > 0 ? `${toolCount} tools found in plugin sources` : "No tools found (are plugins installed?)",
    });
  }

  // Gateway connectivity
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
  const lines = ["Cursor Brain Doctor", ""];
  for (const c of checks) {
    const icon = c.ok ? "\u2713" : "\u2717";
    lines.push(`  ${icon} ${c.label}: ${c.detail}`);
  }
  const passed = checks.filter((c) => c.ok).length;
  const total = checks.length;
  lines.push("", `${passed}/${total} checks passed`);
  if (passed < total) {
    lines.push("Run `openclaw cursor-brain setup` to fix configuration issues.");
  }
  return lines.join("\n");
}

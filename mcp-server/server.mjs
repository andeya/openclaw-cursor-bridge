#!/usr/bin/env node

// OpenClaw Gateway MCP Server
// Discovers plugin tools from openclaw.json + REST API probing.
// Spawned automatically via ~/.cursor/mcp.json.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || join(homedir(), ".openclaw", "openclaw.json");

const TOOL_TIMEOUT_MS = parseInt(process.env.OPENCLAW_TOOL_TIMEOUT_MS || "60000", 10);
const TOOL_RETRY_COUNT = parseInt(process.env.OPENCLAW_TOOL_RETRY_COUNT || "2", 10);
const TOOL_RETRY_DELAY_MS = 1000;

function log(level, msg) {
  process.stderr.write(`[openclaw-mcp] [${level}] ${msg}\n`);
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ── Gateway REST API caller ─────────────────────────────────────────────────

async function gatewayFetch(body, timeoutMs = TOOL_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${GATEWAY_URL}/tools/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function isRetryable(err) {
  if (err?.name === "AbortError") return true;
  if (err?.cause?.code === "ECONNREFUSED") return true;
  if (err?.cause?.code === "ECONNRESET") return true;
  return false;
}

async function invokeGatewayTool(tool, args) {
  let lastError;
  for (let attempt = 0; attempt <= TOOL_RETRY_COUNT; attempt++) {
    try {
      const resp = await gatewayFetch({ tool, args });
      const data = await resp.json();
      if (!data.ok) {
        throw new Error(data.error?.message || `Gateway error for tool "${tool}"`);
      }
      return (
        data.result?.content?.[0]?.text ||
        JSON.stringify(data.result?.details || data.result)
      );
    } catch (err) {
      lastError = err;
      if (attempt < TOOL_RETRY_COUNT && isRetryable(err)) {
        log("warn", `Tool "${tool}" attempt ${attempt + 1} failed (${err.message}), retrying...`);
        await new Promise((r) => setTimeout(r, TOOL_RETRY_DELAY_MS * (attempt + 1)));
        continue;
      }
      break;
    }
  }
  throw lastError;
}

async function probeToolExists(name) {
  try {
    const resp = await gatewayFetch({ tool: name, args: {} }, 5000);
    const data = await resp.json();
    return data.ok || data.error?.type !== "not_found";
  } catch {
    return false;
  }
}

// ── Gateway tool metadata ───────────────────────────────────────────────────

async function fetchToolDescriptions() {
  try {
    const resp = await fetch(`${GATEWAY_URL}/tools`, {
      method: "GET",
      headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return {};
    const data = await resp.json();
    const map = {};
    const tools = data.tools || data.result || data;
    if (Array.isArray(tools)) {
      for (const t of tools) {
        if (t.name) map[t.name] = { description: t.description || "", parameters: t.parameters || null };
      }
    }
    return map;
  } catch {
    return {};
  }
}

// ── Structured tool discovery ───────────────────────────────────────────────

function readOpenClawConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function extractToolNamesFromSource(filePath) {
  try {
    const content = readFileSync(filePath, "utf-8");
    const names = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("name:") && !trimmed.startsWith('"name"')) continue;
      const match = trimmed.match(/^(?:name|"name")\s*:\s*['"]([a-zA-Z_]\w{2,})['"]/);
      if (match) names.push(match[1]);
    }
    return names;
  } catch {
    return [];
  }
}

function discoverCandidateToolNames() {
  const config = readOpenClawConfig();
  if (!config) return [];

  const installs = config.plugins?.installs || {};
  const candidates = new Set();

  for (const [, info] of Object.entries(installs)) {
    const installPath = (info).installPath;
    if (!installPath || !existsSync(installPath)) continue;

    const srcDir = join(installPath, "src");
    if (!existsSync(srcDir)) continue;

    let files;
    try {
      files = readdirSync(srcDir).filter(
        (f) => f.endsWith(".ts") && !f.includes(".test.") && !f.includes(".d.ts")
      );
    } catch {
      continue;
    }

    for (const file of files) {
      const names = extractToolNamesFromSource(join(srcDir, file));
      for (const name of names) candidates.add(name);
    }
  }

  return [...candidates];
}

async function discoverVerifiedTools() {
  const candidates = discoverCandidateToolNames();
  const results = await Promise.allSettled(
    candidates.map(async (name) => {
      const exists = await probeToolExists(name);
      return { name, exists };
    }),
  );
  return results
    .filter((r) => r.status === "fulfilled" && r.value.exists)
    .map((r) => r.value.name);
}

// ── Build MCP server ────────────────────────────────────────────────────────

const VERSION = readPackageVersion();
const server = new McpServer({ name: "openclaw-gateway", version: VERSION });

const registeredNames = new Set();

log("info", `Starting openclaw-gateway MCP server v${VERSION}`);
log("info", `Gateway: ${GATEWAY_URL}`);

let startupTools = [];
let toolMeta = {};

try {
  const [tools, meta] = await Promise.all([
    discoverVerifiedTools(),
    fetchToolDescriptions(),
  ]);
  startupTools = tools;
  toolMeta = meta;
  log("info", `Discovered ${startupTools.length} tools: ${startupTools.join(", ") || "(none)"}`);
} catch (err) {
  log("error", `Tool discovery failed: ${err.message}`);
}

for (const name of startupTools) {
  const meta = toolMeta[name];
  const description = meta?.description || `OpenClaw plugin tool: ${name}. Call openclaw_discover for details.`;

  server.tool(
    name,
    description,
    {
      action: z.string().optional().describe("Action to perform"),
      args_json: z.string().optional().describe("Additional arguments as JSON string"),
    },
    async (params) => {
      const args = {};
      if (params.action) args.action = params.action;
      if (params.args_json) {
        try { Object.assign(args, JSON.parse(params.args_json)); } catch { /* ignore */ }
      }
      try {
        const text = await invokeGatewayTool(name, args);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        log("error", `Tool "${name}" failed: ${err.message}`);
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    },
  );
  registeredNames.add(name);
}

server.tool(
  "openclaw_invoke",
  "Call any OpenClaw Gateway tool by name. Use for tools not listed directly, or newly installed plugins.",
  {
    tool: z.string().describe("Gateway tool name"),
    action: z.string().optional().describe("Action"),
    args_json: z.string().optional().describe("Extra arguments as JSON string"),
  },
  async (params) => {
    const args = {};
    if (params.action) args.action = params.action;
    if (params.args_json) {
      try { Object.assign(args, JSON.parse(params.args_json)); } catch { /* ignore */ }
    }
    try {
      const text = await invokeGatewayTool(params.tool, args);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      log("error", `openclaw_invoke("${params.tool}") failed: ${err.message}`);
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "openclaw_discover",
  "Discover all available OpenClaw Gateway tools with live availability check.",
  {},
  async () => {
    const candidates = discoverCandidateToolNames();
    const results = await Promise.allSettled(
      candidates.map(async (n) => ({ name: n, ok: await probeToolExists(n) })),
    );

    const available = [];
    const unavailable = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        (r.value.ok ? available : unavailable).push(r.value.name);
      }
    }

    const lines = [
      `Available tools (${available.length}):`,
      ...available.map((n) => `  - ${n}${registeredNames.has(n) ? " (direct)" : ""}`),
    ];
    if (unavailable.length)
      lines.push(`\nUnavailable: ${unavailable.join(", ")}`);
    lines.push(
      `\nDirect MCP tools: ${[...registeredNames].join(", ") || "none"}`,
      `Tip: (direct) tools can be called by name; others work via openclaw_invoke.`,
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// ── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
log("info", "MCP server connected via stdio");

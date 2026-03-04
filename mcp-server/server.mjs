#!/usr/bin/env node

// OpenClaw Gateway MCP Bridge
// Discovers plugin tools from openclaw.json + REST API probing (no log regex).
// Spawned automatically by cursor-cli via ~/.cursor/mcp.json.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || join(homedir(), ".openclaw", "openclaw.json");

// ── Gateway REST API caller ─────────────────────────────────────────────────

async function invokeGatewayTool(tool, args) {
  const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GATEWAY_TOKEN}`,
    },
    body: JSON.stringify({ tool, args }),
  });
  const data = await resp.json();
  if (!data.ok) {
    throw new Error(data.error?.message || `Gateway error for tool "${tool}"`);
  }
  return (
    data.result?.content?.[0]?.text ||
    JSON.stringify(data.result?.details || data.result)
  );
}

async function probeToolExists(name) {
  try {
    const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({ tool: name, args: {} }),
    });
    const data = await resp.json();
    return data.ok || data.error?.type !== "not_found";
  } catch {
    return false;
  }
}

// ── Structured tool discovery ───────────────────────────────────────────────
// 1. Parse openclaw.json (JSON) → installed plugin paths
// 2. Scan plugin source files for `name: "tool_name"` declarations
// 3. Verify each candidate via REST API probe

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
      const qSingle = trimmed.indexOf("'");
      const qDouble = trimmed.indexOf('"', trimmed.indexOf(":"));
      const qStart = qSingle >= 0 && (qDouble < 0 || qSingle < qDouble) ? qSingle : qDouble;
      if (qStart < 0) continue;
      const quote = trimmed[qStart];
      const qEnd = trimmed.indexOf(quote, qStart + 1);
      if (qEnd < 0) continue;
      const value = trimmed.slice(qStart + 1, qEnd);
      if (/^[a-zA-Z_]\w*$/.test(value) && value.length > 2) {
        names.push(value);
      }
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
  const verified = [];
  for (const name of candidates) {
    if (await probeToolExists(name)) {
      verified.push(name);
    }
  }
  return verified;
}

// ── Build MCP server ────────────────────────────────────────────────────────

const server = new McpServer({ name: "openclaw-gateway-bridge", version: "2.0.0" });

const registeredNames = new Set();

// Discover tools at startup: candidates from config + source scan, then REST probe
let startupTools = [];
try {
  startupTools = await discoverVerifiedTools();
} catch {
  startupTools = [];
}

for (const name of startupTools) {
  server.tool(
    name,
    `OpenClaw plugin tool: ${name}. Call openclaw_discover for details.`,
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
      const text = await invokeGatewayTool(name, args);
      return { content: [{ type: "text", text }] };
    },
  );
  registeredNames.add(name);
}

// Universal tool invoker — works for any Gateway tool by name
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
    const text = await invokeGatewayTool(params.tool, args);
    return { content: [{ type: "text", text }] };
  },
);

// Runtime discovery — let the agent ask what tools are available
server.tool(
  "openclaw_discover",
  "Discover all available OpenClaw Gateway tools with live availability check.",
  {},
  async () => {
    const candidates = discoverCandidateToolNames();
    const available = [];
    const unavailable = [];

    for (const n of candidates) {
      if (await probeToolExists(n)) {
        available.push(n);
      } else {
        unavailable.push(n);
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

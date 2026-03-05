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
  const endpoints = [
    `${GATEWAY_URL}/api/tools`,
    `${GATEWAY_URL}/tools`,
  ];
  for (const url of endpoints) {
    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${GATEWAY_TOKEN}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) continue;
      const contentType = resp.headers.get("content-type") || "";
      if (!contentType.includes("json")) continue;
      const data = await resp.json();
      const map = {};
      const tools = data.tools || data.result || data;
      if (Array.isArray(tools)) {
        for (const t of tools) {
          if (t.name) map[t.name] = { description: t.description || "", parameters: t.parameters || null };
        }
      }
      if (Object.keys(map).length > 0) return map;
    } catch {
      /* try next endpoint */
    }
  }
  return {};
}

// ── Plugin skill & metadata extraction ──────────────────────────────────────

/**
 * Read SKILL.md files from a plugin's skills directories.
 * Skills are the authoritative, human/AI-readable documentation for tools.
 *
 * Returns: Map<toolName, skillContent>
 *   toolName is derived from the skill directory name (e.g., "feishu-doc" → "feishu_doc").
 */
function readPluginSkills(installPath) {
  /** @type {Map<string, string>} */
  const skills = new Map();
  try {
    const pluginJsonPath = join(installPath, "openclaw.plugin.json");
    if (!existsSync(pluginJsonPath)) return skills;
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf-8"));
    const skillDirs = pluginJson.skills || [];

    for (const relDir of skillDirs) {
      const skillsRoot = join(installPath, relDir);
      if (!existsSync(skillsRoot)) continue;

      let entries;
      try { entries = readdirSync(skillsRoot, { withFileTypes: true }); } catch { continue; }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillDir = join(skillsRoot, entry.name);
        const skillFile = join(skillDir, "SKILL.md");
        if (!existsSync(skillFile)) continue;

        let content = readFileSync(skillFile, "utf-8");

        // Also inline reference files from the same skill directory
        const refsDir = join(skillDir, "references");
        if (existsSync(refsDir)) {
          try {
            const refFiles = readdirSync(refsDir).filter((f) => f.endsWith(".md"));
            for (const rf of refFiles) {
              const refContent = readFileSync(join(refsDir, rf), "utf-8");
              content += `\n\n---\n\n${refContent}`;
            }
          } catch { /* ignore */ }
        }

        // Map skill directory name to tool name: "feishu-doc" → "feishu_doc"
        const toolName = entry.name.replace(/-/g, "_");
        skills.set(toolName, content);
      }
    }
  } catch { /* ignore */ }
  return skills;
}

/**
 * Extract tool metadata (name + description) from a plugin source file.
 * Lightweight fallback for tools without SKILL.md files.
 *
 * Returns: Array<{ name: string, description: string }>
 */
function extractToolMetaFromSource(filePath) {
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n");
    const tools = [];
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed.startsWith("name:") && !trimmed.startsWith('"name"')) continue;
      const nameMatch = trimmed.match(/^(?:name|"name")\s*:\s*['"]([a-zA-Z_]\w{2,})['"]/);
      if (!nameMatch) continue;

      const name = nameMatch[1];
      let description = "";

      // Scan nearby lines (up to 5 after name) for description field
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const descLine = lines[j].trim();
        if (!descLine.startsWith("description:") && !descLine.startsWith('"description"')) continue;
        const descMatch = descLine.match(/^(?:description|"description")\s*:\s*['"](.+?)['"]/);
        if (descMatch) description = descMatch[1];
        else {
          // Multi-line string: description:\n  "text"
          const nextLine = (lines[j + 1] || "").trim();
          const nextMatch = nextLine.match(/^['"](.+?)['"]/);
          if (nextMatch) description = nextMatch[1];
        }
        break;
      }

      tools.push({ name, description });
    }
    return tools;
  } catch {
    return [];
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

/**
 * Discover candidate tools with rich metadata.
 *
 * Strategy:
 *   1. Read SKILL.md files from plugin skills directories (authoritative source)
 *   2. Scan plugin source files for tool names (catches tools without skills)
 *   3. Merge: tools with skills get full skill content; others get name only
 *
 * Returns: Map<toolName, { skill?: string, description?: string }>
 */
function discoverCandidateTools() {
  const config = readOpenClawConfig();
  if (!config) return new Map();

  const installs = config.plugins?.installs || {};
  /** @type {Map<string, { skill?: string, description?: string }>} */
  const toolsMap = new Map();

  for (const [, info] of Object.entries(installs)) {
    const installPath = info.installPath;
    if (!installPath || !existsSync(installPath)) continue;

    // Step 1: Read skill files (primary, reliable source)
    const skills = readPluginSkills(installPath);
    for (const [toolName, skillContent] of skills) {
      toolsMap.set(toolName, { skill: skillContent });
    }

    // Step 2: Scan source files for tool names not covered by skills
    const srcDir = join(installPath, "src");
    if (!existsSync(srcDir)) continue;

    let files;
    try {
      files = readdirSync(srcDir).filter(
        (f) => f.endsWith(".ts") && !f.includes(".test.") && !f.includes(".d.ts"),
      );
    } catch {
      continue;
    }

    for (const file of files) {
      const metas = extractToolMetaFromSource(join(srcDir, file));
      for (const { name, description } of metas) {
        if (!toolsMap.has(name)) {
          toolsMap.set(name, { description: description || name });
        }
      }
    }
  }

  return toolsMap;
}

// ── Candidate tools cache (avoids repeated disk reads during startup) ────────

let _candidateCache = null;
let _candidateCacheAt = 0;
const CANDIDATE_TTL_MS = 60_000;

function getCachedCandidateTools(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _candidateCache && (now - _candidateCacheAt) < CANDIDATE_TTL_MS) {
    return _candidateCache;
  }
  _candidateCache = discoverCandidateTools();
  _candidateCacheAt = now;
  return _candidateCache;
}

async function discoverVerifiedTools(candidateTools) {
  const results = await Promise.allSettled(
    [...candidateTools.entries()].map(async ([name, meta]) => {
      const exists = await probeToolExists(name);
      return { name, meta, exists };
    }),
  );
  /** @type {Map<string, { skill?: string, description?: string }>} */
  const verified = new Map();
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.exists) {
      verified.set(r.value.name, r.value.meta);
    }
  }
  return verified;
}

// ── Formatting helpers ──────────────────────────────────────────────────────

/**
 * Extract a short description from SKILL.md frontmatter.
 * Parses YAML frontmatter between --- delimiters.
 */
function extractSkillDescription(skillContent) {
  const fmMatch = skillContent.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return "";
  const descMatch = fmMatch[1].match(/description:\s*\|?\s*\n?\s*(.+)/);
  return descMatch ? descMatch[1].trim() : "";
}

/**
 * Strip YAML frontmatter from SKILL.md content for clean output.
 */
function stripFrontmatter(content) {
  return content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
}

/**
 * Extract a capability brief from SKILL.md for use in server instructions.
 * Pulls: token extraction rules, actions with exact keys, URL patterns,
 * parameter format hints, and dependency notes.
 */
function extractSkillBrief(skillContent) {
  const body = stripFrontmatter(skillContent);
  const hints = [];

  const tokenSection = body.match(/## Token Extraction\n+([\s\S]*?)(?=\n## |\n$)/);
  if (tokenSection) {
    const rule = tokenSection[1].trim().split("\n")[0];
    if (rule) hints.push(`Token: ${rule}`);
  }

  const sections = body.split(/\n(?=## [^#])/);
  const actionsSection = sections.find((s) => s.startsWith("## Actions"));
  if (actionsSection) {
    const actionBlocks = [...actionsSection.matchAll(/^### ([^\n]+)\n[\s\S]*?```json\n\{[^}]*"action"\s*:\s*"(\w+)"[^}]*\}/gm)];
    if (actionBlocks.length) {
      hints.push(`Actions: ${actionBlocks.map(([, label, key]) => `${label.replace(/\s*\(.*\)$/, "").trim()}(\`${key}\`)`).join(", ")}`);
    } else {
      const actions = [...actionsSection.matchAll(/^### (.+)/gm)].map((m) => m[1].replace(/\s*\(.*\)$/, "").trim());
      if (actions.length) hints.push(`Actions: ${actions.join(", ")}`);
    }
  }

  const urlPatterns = [...body.matchAll(/\w+\.(?:cn|com)\/(\w+)\/\w+/g)].map((m) => m[1]);
  const uniquePatterns = [...new Set(urlPatterns)];
  if (uniquePatterns.length) {
    const host = body.match(/(\w+\.(?:cn|com))\//)?.[1] || "";
    hints.push(`URL patterns: ${uniquePatterns.map((p) => `${host}/${p}/...`).join(", ")}`);
  }

  if (actionsSection) {
    const firstExample = actionsSection.match(/```json\n(\{[\s\S]*?\})\n```/);
    if (firstExample) {
      hints.push(`Params: pass \`action\` and remaining fields as \`args_json\` JSON string. Example: ${firstExample[1].replace(/\s+/g, " ")}`);
    }
  }

  const depMatch = body.match(/\*\*(?:Dependency|Note):\*\*\s*(.+)/);
  if (depMatch) hints.push(`Note: ${depMatch[1].trim()}`);

  return hints.join(". ");
}

// ── Build MCP server ────────────────────────────────────────────────────────

const VERSION = readPackageVersion();

// Build server instructions dynamically from discovered tools and skills
function buildServerInstructions() {
  const candidateTools = getCachedCandidateTools();
  if (candidateTools.size === 0) {
    return "OpenClaw Gateway MCP server. Call openclaw_discover to see available tools.";
  }

  const toolLines = [];
  for (const [name, meta] of candidateTools) {
    const hasSkill = !!meta.skill;
    const desc = hasSkill ? extractSkillDescription(meta.skill) : (meta.description || "");
    const brief = hasSkill ? extractSkillBrief(meta.skill) : "";
    const line = [`  - ${name}:`, desc, brief].filter(Boolean).join(" ");
    toolLines.push(line);
  }

  return [
    "OpenClaw Gateway — tool server for external service integrations.",
    "",
    "CAPABILITIES:",
    ...toolLines,
    "",
    "USAGE:",
    "  1. When a user mentions URLs or services matching the capabilities above, use the corresponding tool.",
    "  2. Use the token extraction rules and action keys above to call tools directly for common read/write operations.",
    "  3. Call openclaw_skill(tool_name) for advanced operations, complex parameters, or when unsure about usage.",
    "  4. Call openclaw_discover for a refreshed list of all available tools.",
  ].join("\n");
}

const serverInstructions = buildServerInstructions();
const server = new McpServer(
  { name: "openclaw-gateway", version: VERSION },
  { instructions: serverInstructions },
);

// Build a concise capability summary for embedding in static tool descriptions.
// This ensures the AI knows about available services even when only static tools are registered
// (e.g., gateway not ready at startup → 0 dynamic tools, only openclaw_invoke/discover/skill).
function buildCapabilitySummary() {
  const candidateTools = getCachedCandidateTools();
  if (candidateTools.size === 0) return "";
  const parts = [];
  for (const [name, meta] of candidateTools) {
    const desc = meta.skill ? extractSkillDescription(meta.skill) : (meta.description || "");
    if (desc) parts.push(`${name}: ${desc}`);
  }
  return parts.length ? ` Available: ${parts.join("; ")}.` : "";
}
const capSummary = buildCapabilitySummary();

const registeredNames = new Set();

log("info", `Starting openclaw-gateway MCP server v${VERSION}`);
log("info", `Gateway: ${GATEWAY_URL}`);

// Lazy-loaded skill content cache (reads from disk, independent of gateway)
/** @type {Map<string, string> | null} */
let _skillsCache = null;
function getSkillsByTool() {
  if (_skillsCache) return _skillsCache;
  _skillsCache = new Map();
  const candidateTools = getCachedCandidateTools();
  for (const [name, meta] of candidateTools) {
    if (meta.skill) _skillsCache.set(name, meta.skill);
  }
  return _skillsCache;
}

// Register dynamic tools from disk-based candidates immediately, without
// waiting for Gateway liveness probes. This avoids a startup race condition
// where the MCP server starts before the Gateway is ready, resulting in zero
// dynamic tools. If a tool's Gateway handler is not yet available when called,
// invokeGatewayTool's retry logic will handle it gracefully.
let gatewayMeta = {};
try {
  gatewayMeta = await fetchToolDescriptions();
} catch {
  log("warn", "Could not fetch tool descriptions from gateway (may not be ready yet)");
}

const candidateToolsForReg = getCachedCandidateTools();
for (const [name, localMeta] of candidateToolsForReg) {
  const gwMeta = gatewayMeta[name];
  const skillContent = localMeta.skill || getSkillsByTool().get(name);
  const hasSkill = !!skillContent;
  const baseDesc = hasSkill
    ? extractSkillDescription(skillContent)
    : localMeta.description || gwMeta?.description || "";
  const skillHint = hasSkill ? ` Call openclaw_skill for advanced usage beyond common read/write.` : "";
  const description = (baseDesc || `OpenClaw tool: ${name}.`) + skillHint;

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
log("info", `Registered ${registeredNames.size} dynamic tools from disk: ${[...registeredNames].join(", ") || "(none)"}`);

// Background: verify which tools are actually available on the gateway (non-blocking, for logging only)
discoverVerifiedTools(candidateToolsForReg).then((verified) => {
  const missing = [...candidateToolsForReg.keys()].filter((n) => !verified.has(n));
  if (missing.length > 0) {
    log("warn", `Tools registered but not yet on gateway: ${missing.join(", ")} (will retry on invocation)`);
  } else {
    log("info", `All ${verified.size} registered tools verified on gateway`);
  }
}).catch(() => {});

server.tool(
  "openclaw_invoke",
  `Call any OpenClaw Gateway tool by name. Use for tools not listed directly, or newly installed plugins.${capSummary}`,
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
  `List all available OpenClaw Gateway tools with short descriptions. Use openclaw_skill to get full documentation for a specific tool.${capSummary}`,
  {},
  async () => {
    const candidateTools = getCachedCandidateTools(true);
    const results = await Promise.allSettled(
      [...candidateTools.entries()].map(async ([name, meta]) => ({
        name,
        meta,
        ok: await probeToolExists(name),
      })),
    );

    const available = [];
    const unavailable = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        (r.value.ok ? available : unavailable).push(r.value);
      }
    }

    const lines = [`Available tools (${available.length}):\n`];
    for (const { name, meta } of available) {
      const direct = registeredNames.has(name) ? " (direct)" : "";
      const hasSkill = !!meta.skill;
      const desc = hasSkill ? extractSkillDescription(meta.skill) : (meta.description || "");
      const badge = hasSkill ? " [has skill]" : "";
      lines.push(`- ${name}${direct}${badge}${desc ? ` — ${desc}` : ""}`);
    }

    if (unavailable.length) {
      lines.push(`\nUnavailable: ${unavailable.map((u) => u.name).join(", ")}`);
    }

    const newTools = available.filter(({ name }) => !registeredNames.has(name));
    if (newTools.length > 0) {
      lines.push(
        `\nNew tools available via openclaw_invoke: ${newTools.map((t) => t.name).join(", ")}`,
        `(These tools were installed after MCP server started. ` +
          `Use openclaw_invoke to call them, or restart Cursor to register them as direct tools.)`,
      );
    }

    lines.push(
      `\nDirect MCP tools: ${[...registeredNames].join(", ") || "none"}`,
      `\nUsage:`,
      `  - Use openclaw_skill with tool name to get full documentation (actions, parameters, examples).`,
      `  - (direct) tools can be called by name; others work via openclaw_invoke.`,
      `  - Pass action and other parameters in args_json as a JSON string.`,
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

/**
 * Find tools referenced in skill content that are known to exist.
 * Returns list of { name, hasSkill, description } for referenced tools.
 */
function findReferencedTools(skillContent, excludeTools, allSkills, candidateTools) {
  const pattern = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;
  const mentioned = new Set();
  for (const m of skillContent.matchAll(pattern)) {
    const name = m[1];
    if (!excludeTools.has(name) && (allSkills.has(name) || candidateTools.has(name))) {
      mentioned.add(name);
    }
  }
  const refs = [];
  for (const name of mentioned) {
    const hasSkill = allSkills.has(name);
    const desc = hasSkill
      ? extractSkillDescription(allSkills.get(name))
      : candidateTools.get(name)?.description || "";
    refs.push({ name, hasSkill, description: desc });
  }
  return refs;
}

server.tool(
  "openclaw_skill",
  "Get full usage documentation (actions, parameters, JSON examples) for OpenClaw tools. Accepts one or more tool names (comma-separated). Call this before using a tool you haven't used before.",
  {
    tool: z.string().describe("Tool name(s), comma-separated (e.g. 'feishu_doc' or 'feishu_wiki,feishu_doc')"),
  },
  async (params) => {
    const skills = getSkillsByTool();
    const candidates = getCachedCandidateTools();
    const requestedNames = params.tool.split(",").map((s) => s.trim()).filter(Boolean);
    const requestedSet = new Set(requestedNames);

    const sections = [];
    const notFound = [];
    const allRefs = [];

    for (const name of requestedNames) {
      const skill = skills.get(name);
      if (skill) {
        sections.push(`# ${name}\n\n${stripFrontmatter(skill)}`);
        const refs = findReferencedTools(skill, requestedSet, skills, candidates);
        allRefs.push(...refs);
        continue;
      }

      const gwMeta = gatewayMeta[name];
      const candidateMeta = candidates.get(name);
      const desc = gwMeta?.description || candidateMeta?.description || "";
      if (desc) {
        sections.push(`# ${name}\n\nNo detailed skill documentation available.\n\nDescription: ${desc}`);
      } else {
        notFound.push(name);
      }
    }

    if (notFound.length) {
      const allTools = [...skills.keys(), ...[...candidates.keys()].filter((n) => !skills.has(n))];
      sections.push(`Not found: ${notFound.join(", ")}.\nAvailable tools: ${allTools.join(", ")}`);
    }

    // Deduplicate refs and exclude already-loaded tools
    const seenRefs = new Set(requestedNames);
    const uniqueRefs = allRefs.filter((r) => {
      if (seenRefs.has(r.name)) return false;
      seenRefs.add(r.name);
      return true;
    });

    if (uniqueRefs.length > 0) {
      const refLines = uniqueRefs.map((r) => {
        const badge = r.hasSkill ? " [has skill]" : "";
        return `  - ${r.name}${badge}${r.description ? ` — ${r.description}` : ""}`;
      });
      sections.push(`\n---\nReferenced tools (use openclaw_skill to load):\n${refLines.join("\n")}`);
    }

    const text = sections.join("\n\n");
    return {
      content: [{ type: "text", text }],
      ...(notFound.length === requestedNames.length ? { isError: true } : {}),
    };
  },
);

// ── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
log("info", "MCP server connected via stdio");

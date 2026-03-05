#!/usr/bin/env node

// Cursor Agent → OpenAI-compatible streaming API proxy
//
// Works as part of the openclaw-cursor-brain plugin (auto-started by gateway)
// or as a standalone server for any OpenAI-compatible client.
//
// Start (standalone):
//   node streaming-proxy.mjs
//   # or with options:
//   CURSOR_PROXY_PORT=18790 CURSOR_PROXY_API_KEY=secret node streaming-proxy.mjs
//
// Endpoints:
//   POST /v1/chat/completions   (stream: true/false)
//   GET  /v1/models
//   GET  /v1/health

import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Configuration ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.CURSOR_PROXY_PORT || "18790", 10);
const WORKSPACE_DIR = process.env.CURSOR_WORKSPACE_DIR || "";
const API_KEY = process.env.CURSOR_PROXY_API_KEY || "";
const OUTPUT_FORMAT = process.env.CURSOR_OUTPUT_FORMAT || "stream-json";
const CURSOR_MODEL = process.env.CURSOR_MODEL || "";

const FORWARD_THINKING = process.env.CURSOR_PROXY_FORWARD_THINKING === "true";
const INSTANT_RESULT = process.env.CURSOR_PROXY_INSTANT_RESULT !== "false";
const TARGET_CHARS_PER_SEC = parseInt(process.env.CURSOR_PROXY_STREAM_SPEED || "200", 10);
const SHORT_TEXT_THRESHOLD = 100;
const REQUEST_TIMEOUT_MS = parseInt(process.env.CURSOR_PROXY_REQUEST_TIMEOUT || "300000", 10); // 5 min default
const MAX_CONSECUTIVE_FAILURES = parseInt(process.env.CURSOR_PROXY_MAX_CONSECUTIVE_FAILURES || "5", 10);

// ── Request health tracking ─────────────────────────────────────────────────

let consecutiveFailures = 0;
let lastErrorTime = 0;
let lastErrorMsg = "";

function recordSuccess() {
  consecutiveFailures = 0;
}

function recordFailure(stderrSnippet) {
  consecutiveFailures++;
  lastErrorTime = Date.now();
  lastErrorMsg = stderrSnippet || "empty response";
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    log("error", `${consecutiveFailures} consecutive failures (last: ${lastErrorMsg}), self-exiting for restart`);
    process.exit(2);
  }
}

// ── Script identity ─────────────────────────────────────────────────────────

function computeScriptHash() {
  try {
    const scriptPath = new URL(import.meta.url).pathname;
    const content = readFileSync(scriptPath, "utf-8");
    return createHash("sha256").update(content).digest("hex").slice(0, 12);
  } catch { return "unknown"; }
}
const SCRIPT_HASH = computeScriptHash();

// ── Cursor path auto-detection ──────────────────────────────────────────────

function detectCursorPath() {
  if (process.env.CURSOR_PATH) return process.env.CURSOR_PATH;

  const home = homedir();
  const isWin = process.platform === "win32";

  const candidates = isWin
    ? [
        join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "Programs", "cursor", "resources", "app", "bin", "agent.exe"),
        join(home, ".cursor", "bin", "agent.exe"),
        join(home, ".local", "bin", "agent.exe"),
      ]
    : [
        join(home, ".local", "bin", "agent"),
        "/usr/local/bin/agent",
        join(home, ".cursor", "bin", "agent"),
      ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  try {
    const cmd = isWin ? "where agent 2>nul" : "which agent 2>/dev/null";
    const result = execSync(cmd, { encoding: "utf-8", timeout: 3000 }).trim();
    if (result && existsSync(result.split("\n")[0])) return result.split("\n")[0];
  } catch {}

  return "";
}

const CURSOR_PATH = detectCursorPath();

function discoverModels() {
  if (!CURSOR_PATH) return [{ id: "auto", object: "model", created: 0, owned_by: "cursor" }];
  try {
    const out = execSync(`"${CURSOR_PATH}" --list-models`, { encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] });
    const models = [];
    for (const line of out.split("\n")) {
      const m = line.match(/^(\S+)\s+-\s+(.+?)(?:\s+\((current|default)\))?$/);
      if (m) models.push({ id: m[1], object: "model", created: 0, owned_by: "cursor" });
    }
    return models.length ? models : [{ id: "auto", object: "model", created: 0, owned_by: "cursor" }];
  } catch {
    return [{ id: "auto", object: "model", created: 0, owned_by: "cursor" }];
  }
}

const cachedModels = discoverModels();

// ── Persistent sessions ─────────────────────────────────────────────────────

const OPENCLAW_DIR = join(homedir(), ".openclaw");
const SESSIONS_FILE = join(OPENCLAW_DIR, "cursor-sessions.json");
const LOG_FILE = join(OPENCLAW_DIR, "cursor-proxy.log");
const MAX_SESSIONS = 100;

function loadSessions() {
  try {
    const data = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
    if (Array.isArray(data)) return new Map(data);
  } catch {}
  return new Map();
}

function saveSessions(map) {
  try {
    mkdirSync(OPENCLAW_DIR, { recursive: true });
    const entries = [...map.entries()];
    const trimmed = entries.length > MAX_SESSIONS ? entries.slice(-MAX_SESSIONS) : entries;
    writeFileSync(SESSIONS_FILE, JSON.stringify(trimmed));
  } catch {}
}

const sessions = loadSessions();

function setSession(key, value) {
  const old = sessions.get(key);
  if (old === value) return;
  sessions.delete(key);
  sessions.set(key, value);
  saveSessions(sessions);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function mapRequestModel(reqModel) {
  if (!reqModel || reqModel === "auto") return "";
  return reqModel;
}

function localTimestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function log(level, msg) {
  const line = `${localTimestamp()} [${level}] ${msg}\n`;
  process.stderr.write(`[cursor-proxy] ${line}`);
  try { appendFileSync(LOG_FILE, line); } catch {}
}

function extractUserMessage(messages) {
  if (!Array.isArray(messages) || !messages.length) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    }
  }
  return "";
}

function sseEvent(id, model, { content, finishReason } = {}) {
  const delta = {};
  if (content !== undefined) delta.content = content;
  const choice = { index: 0, delta };
  if (finishReason) choice.finish_reason = finishReason;
  return (
    "data: " +
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [choice],
    }) +
    "\n\n"
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Smart chunked streaming ─────────────────────────────────────────────────

async function streamChunked(res, id, model, text) {
  const len = text.length;
  if (len <= SHORT_TEXT_THRESHOLD) {
    res.write(sseEvent(id, model, { content: text }));
    return;
  }

  const chunkSize = Math.max(3, Math.min(15, Math.ceil(TARGET_CHARS_PER_SEC / 30)));
  const delayMs = Math.max(10, Math.round((chunkSize / TARGET_CHARS_PER_SEC) * 1000));

  for (let i = 0; i < len; i += chunkSize) {
    res.write(sseEvent(id, model, { content: text.slice(i, i + chunkSize) }));
    if (i + chunkSize < len) await sleep(delayMs);
  }
}

// ── Spawn cursor-agent ──────────────────────────────────────────────────────

function spawnCursorAgent(userMsg, sessionKey, requestModel, { skipSession = false } = {}) {
  const cursorSessionId = !skipSession && sessionKey ? sessions.get(sessionKey) : null;
  const args = ["-p", "--output-format", OUTPUT_FORMAT, "--stream-partial-output", "--trust", "--approve-mcps", "--force"];
  const model = CURSOR_MODEL || mapRequestModel(requestModel);
  if (model) args.push("--model", model);
  if (cursorSessionId) args.push("--resume", cursorSessionId);

  const child = spawn(CURSOR_PATH, args, {
    cwd: WORKSPACE_DIR || undefined,
    env: { ...process.env, ...(process.platform !== "win32" && { SHELL: process.env.SHELL || "/bin/bash" }) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.write(userMsg);
  child.stdin.end();
  child._stderrBuf = "";
  child.stderr.on("data", (d) => { child._stderrBuf += d; });
  child.stderr.on("close", () => {
    if (child._stderrBuf.trim()) log("debug", `cursor-agent stderr: ${child._stderrBuf.trim().slice(0, 500)}`);
  });
  child._usedSession = !!cursorSessionId;
  return child;
}

// ── Session auto-derive from message metadata ──────────────────────────────

const CONV_INFO_RE = /Conversation info \(untrusted metadata\):\s*```json\s*(\{[\s\S]*?\})\s*```/;

function extractSessionFromMeta(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const text = typeof m.content === "string" ? m.content
      : Array.isArray(m.content) ? m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n")
      : "";
    const match = text.match(CONV_INFO_RE);
    if (!match) continue;
    try {
      const info = JSON.parse(match[1]);
      if (info.is_group_chat && info.group_channel) {
        return `auto:grp:${info.group_channel}:${info.topic_id || "main"}`;
      }
      if (info.sender_id) {
        return `auto:dm:${info.sender_id}`;
      }
    } catch {}
  }
  return null;
}

// ── Stream output processor (reusable for retry) ────────────────────────────

function processStreamOutput(child, { requestId, model, sessionKey, res }) {
  return new Promise((resolve) => {
    let resolved = false;
    let resultText = "";
    let hasStreamedContent = false;
    let error = null;
    const toolCalls = new Map();

    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve({ resultText, hasStreamedContent, error });
    };

    const rl = createInterface({ input: child.stdout, terminal: false });

    rl.on("line", (raw) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      let parsed;
      try { parsed = JSON.parse(trimmed); } catch { return; }

      log("debug", `[${requestId}] event: ${JSON.stringify({ type: parsed.type, subtype: parsed.subtype, hasText: !!parsed.text, hasResult: !!parsed.result })}`);

      if (parsed.session_id && sessionKey) setSession(sessionKey, parsed.session_id);

      const type = parsed.type;

      if (type === "tool_call") {
        const callId = parsed.call_id || "unknown";
        const tc = parsed.tool_call || {};
        const toolKey = Object.keys(tc)[0] || "unknown";
        if (parsed.subtype === "started") {
          toolCalls.set(callId, { tool: toolKey, startTime: Date.now() });
          const args = tc[toolKey]?.args;
          const argsSummary = args ? JSON.stringify(args).slice(0, 120) : "";
          log("info", `[${requestId}] tool:start ${toolKey}${argsSummary ? ` args=${argsSummary}` : ""} (call_id=${callId})`);
        } else if (parsed.subtype === "completed") {
          const tracked = toolCalls.get(callId);
          const elapsed = tracked ? `${Date.now() - tracked.startTime}ms` : "?ms";
          const result = tc[toolKey]?.result;
          const ok = result ? !!result.success : null;
          log("info", `[${requestId}] tool:done  ${tracked?.tool || toolKey} ${elapsed}${ok !== null ? ` ok=${ok}` : ""} (call_id=${callId})`);
          toolCalls.delete(callId);
        }
        return;
      }

      if (type === "thinking") {
        if (FORWARD_THINKING && parsed.text) {
          hasStreamedContent = true;
          const delta = { reasoning_content: parsed.text };
          const chunk = {
            id: requestId, object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, delta, finish_reason: null }],
          };
          res.write("data: " + JSON.stringify(chunk) + "\n\n");
        }
        return;
      }

      if (type === "text" && parsed.text) {
        hasStreamedContent = true;
        res.write(sseEvent(requestId, model, { content: parsed.text }));
        return;
      }

      if (type === "result" && typeof parsed.result === "string") {
        resultText = parsed.result;
      }
    });

    child.on("error", (err) => {
      error = err;
      log("error", `[${requestId}] cursor-agent spawn error: ${err.message}`);
      done();
    });

    rl.on("close", () => done());
  });
}

// ── Streaming handler (real-time thinking + smart chunked result) ────────────

function resolveSessionKey(body, req) {
  if (body._openclaw_session_id) return { key: body._openclaw_session_id, src: "body._openclaw" };
  if (body.session_id) return { key: body.session_id, src: "body.session_id" };
  if (req.headers["x-openclaw-session-id"]) return { key: req.headers["x-openclaw-session-id"], src: "header.x-openclaw" };
  if (req.headers["x-session-id"]) return { key: req.headers["x-session-id"], src: "header.x-session" };
  const metaKey = extractSessionFromMeta(body.messages);
  if (metaKey) return { key: metaKey, src: "meta.auto" };
  return { key: null, src: "none" };
}

async function handleStream(req, res, body) {
  const userMsg = extractUserMessage(body.messages);
  const model = body.model || "auto";
  const { key: sessionKey, src: sessionSrc } = resolveSessionKey(body, req);
  const requestId = `chatcmpl-${randomUUID().slice(0, 8)}`;
  const msgPreview = userMsg.slice(0, 80).replace(/\n/g, " ");
  const startTime = Date.now();

  log("info", `[${requestId}] stream request: model=${model}, session=${sessionKey || "none"}(${sessionSrc}), msg="${msgPreview}${userMsg.length > 80 ? "…" : ""}"`);

  let child = spawnCursorAgent(userMsg, sessionKey, model);
  let clientGone = false;
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    log("warn", `[${requestId}] request timeout after ${REQUEST_TIMEOUT_MS}ms, killing cursor-agent`);
    child.kill();
  }, REQUEST_TIMEOUT_MS);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  req.on("close", () => {
    clientGone = true;
    clearTimeout(timeout);
    child.kill();
    log("info", `[${requestId}] client disconnected after ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  });

  let result = await processStreamOutput(child, { requestId, model, sessionKey, res });

  if (clientGone) {
    log("info", `[${requestId}] agent finished after client disconnect, ${((Date.now() - startTime) / 1000).toFixed(1)}s, resultLen=${result.resultText.length}`);
    return;
  }

  if (result.error) {
    recordFailure(result.error.message?.slice(0, 200));
    clearTimeout(timeout);
    res.end();
    return;
  }

  const canRetry = !timedOut && !result.hasStreamedContent && !result.resultText
    && child._usedSession && sessionKey;
  if (canRetry) {
    sessions.delete(sessionKey);
    saveSessions(sessions);
    log("warn", `[${requestId}] empty response with session, retrying without resume`);
    child = spawnCursorAgent(userMsg, sessionKey, model, { skipSession: true });
    result = await processStreamOutput(child, { requestId, model, sessionKey, res });
    if (clientGone) return;
    if (result.error) { recordFailure(result.error.message?.slice(0, 200)); clearTimeout(timeout); res.end(); return; }
  }

  clearTimeout(timeout);
  const elapsed = Date.now() - startTime;
  const hasContent = result.hasStreamedContent || !!result.resultText;

  if (!hasContent) {
    recordFailure(child._stderrBuf?.trim().slice(0, 200));
    res.write(sseEvent(requestId, model, { content: "(no response from cursor-agent)" }));
    if (canRetry) log("warn", `[${requestId}] retry also returned empty`);
  } else {
    recordSuccess();
    if (canRetry) log("info", `[${requestId}] retry succeeded`);
    if (result.resultText && !result.hasStreamedContent) {
      if (INSTANT_RESULT) {
        res.write(sseEvent(requestId, model, { content: result.resultText }));
      } else {
        await streamChunked(res, requestId, model, result.resultText);
      }
    } else if (result.resultText && result.hasStreamedContent) {
      log("debug", `[${requestId}] result received after text deltas, skipping duplicate`);
    }
  }

  res.write(sseEvent(requestId, model, { finishReason: "stop" }));
  res.write("data: [DONE]\n\n");
  res.end();
  log("info", `[${requestId}] completed in ${(elapsed / 1000).toFixed(1)}s, streamed=${result.hasStreamedContent}, resultLen=${result.resultText.length}`);
}

// ── Non-streaming handler ───────────────────────────────────────────────────

function collectNonStreamOutput(child, { requestId, sessionKey }) {
  return new Promise((resolve) => {
    let resolved = false;
    let stdout = "";
    let error = null;
    child.stdout.on("data", (d) => (stdout += d));

    const done = () => {
      if (resolved) return;
      resolved = true;
      let resultText = "";
      let thinkingText = "";
      if (!error) {
        for (const line of stdout.split("\n")) {
          try {
            const p = JSON.parse(line.trim());
            if (p.type === "tool_call") {
              const callId = p.call_id || "unknown";
              const tc = p.tool_call || {};
              const toolKey = Object.keys(tc)[0] || "unknown";
              if (p.subtype === "started") {
                const args = tc[toolKey]?.args;
                const argsSummary = args ? JSON.stringify(args).slice(0, 120) : "";
                log("info", `[${requestId}] tool:start ${toolKey}${argsSummary ? ` args=${argsSummary}` : ""} (call_id=${callId})`);
              } else if (p.subtype === "completed") {
                const ok = tc[toolKey]?.result ? !!tc[toolKey].result.success : null;
                log("info", `[${requestId}] tool:done  ${toolKey}${ok !== null ? ` ok=${ok}` : ""} (call_id=${callId})`);
              }
            }
            if (p.type === "result" && typeof p.result === "string") resultText = p.result;
            if (p.type === "thinking" && FORWARD_THINKING && p.text) thinkingText += p.text;
            if (p.session_id && sessionKey) setSession(sessionKey, p.session_id);
          } catch {}
        }
      }
      resolve({ resultText, thinkingText, error });
    };

    child.on("error", (err) => {
      error = err;
      log("error", `[${requestId}] cursor-agent spawn error: ${err.message}`);
      done();
    });
    child.on("close", () => done());
  });
}

async function handleNonStream(req, res, body) {
  const userMsg = extractUserMessage(body.messages);
  const model = body.model || "auto";
  const { key: sessionKey, src: sessionSrc } = resolveSessionKey(body, req);
  const requestId = `chatcmpl-${randomUUID().slice(0, 8)}`;
  const msgPreview = userMsg.slice(0, 80).replace(/\n/g, " ");
  const startTime = Date.now();

  log("info", `[${requestId}] non-stream request: model=${model}, session=${sessionKey || "none"}(${sessionSrc}), msg="${msgPreview}${userMsg.length > 80 ? "…" : ""}"`);

  const sendError = (err) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `cursor-agent error: ${err.message}` } }));
  };

  let child = spawnCursorAgent(userMsg, sessionKey, model);
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    log("warn", `[${requestId}] request timeout after ${REQUEST_TIMEOUT_MS}ms, killing cursor-agent`);
    child.kill();
  }, REQUEST_TIMEOUT_MS);

  let result = await collectNonStreamOutput(child, { requestId, sessionKey });

  if (result.error) {
    recordFailure(result.error.message?.slice(0, 200));
    clearTimeout(timeout);
    sendError(result.error);
    return;
  }

  let retried = false;
  if (!timedOut && !result.resultText && child._usedSession && sessionKey) {
    retried = true;
    sessions.delete(sessionKey);
    saveSessions(sessions);
    log("warn", `[${requestId}] empty response with session, retrying without resume`);
    child = spawnCursorAgent(userMsg, sessionKey, model, { skipSession: true });
    result = await collectNonStreamOutput(child, { requestId, sessionKey });
    if (result.error) {
      recordFailure(result.error.message?.slice(0, 200));
      clearTimeout(timeout);
      sendError(result.error);
      return;
    }
  }

  clearTimeout(timeout);

  if (result.resultText) {
    recordSuccess();
    if (retried) log("info", `[${requestId}] retry succeeded`);
  } else {
    recordFailure(child._stderrBuf?.trim().slice(0, 200));
    if (retried) log("warn", `[${requestId}] retry also returned empty`);
  }

  const content = result.resultText || "(no response)";

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: requestId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(result.thinkingText ? { reasoning_content: result.thinkingText } : {}),
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
  );
  log("info", `[${requestId}] completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s, resultLen=${content.length}`);
}

// ── Auth & CORS ─────────────────────────────────────────────────────────────

function checkAuth(req, res) {
  if (!API_KEY) return true;
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${API_KEY}`) return true;
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
  return false;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-OpenClaw-Session-Id, X-Session-Id");
}

// ── HTTP server ─────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    req.on("data", (c) => {
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      data += c;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (!checkAuth(req, res)) return;

  if (req.method === "GET" && req.url === "/v1/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", cursor: !!CURSOR_PATH, port: PORT, sessions: sessions.size, scriptHash: SCRIPT_HASH, consecutiveFailures, lastErrorTime, lastErrorMsg }));
  }

  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ data: cachedModels }));
  }

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    if (!CURSOR_PATH) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({ error: { message: "cursor-agent not found. Set CURSOR_PATH or install Cursor." } }),
      );
    }
    try {
      const body = await readBody(req);
      const userMsg = extractUserMessage(body.messages);
      if (!userMsg) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "No user message found in messages array" } }));
      }
      if (body.stream) return handleStream(req, res, body);
      return handleNonStream(req, res, body);
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: e instanceof Error ? e.message : String(e) } }));
    }
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found" } }));
});

server.listen(PORT, "127.0.0.1", () => {
  log("info", `Cursor streaming proxy on http://127.0.0.1:${PORT}`);
  if (CURSOR_PATH) {
    log("info", `Cursor agent: ${CURSOR_PATH}`);
  } else {
    log("warn", "cursor-agent not found — all /v1/chat/completions requests will fail. Set CURSOR_PATH or install Cursor.");
  }
  log("info", `Model: ${CURSOR_MODEL || "auto"}, Format: ${OUTPUT_FORMAT}, Partial: on, Thinking: ${FORWARD_THINKING ? "forward" : "drop"}, InstantResult: ${INSTANT_RESULT}, SessionAuto: true`);
  log("info", `Sessions loaded: ${sessions.size} (max ${MAX_SESSIONS})`);
  if (API_KEY) log("info", "API key authentication enabled");
  if (WORKSPACE_DIR) log("info", `Workspace: ${WORKSPACE_DIR}`);
});

function gracefulShutdown(signal) {
  log("info", `Received ${signal}, shutting down gracefully...`);
  server.close(() => {
    log("info", "All connections closed, exiting.");
    process.exit(0);
  });
  setTimeout(() => {
    log("warn", "Graceful shutdown timed out after 10s, forcing exit.");
    process.exit(1);
  }, 10_000).unref();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

<p align="center">
  <a href="https://github.com/openclaw/openclaw"><img src="./doc/openclaw-logo.svg" width="96" height="96" alt="OpenClaw" style="vertical-align: middle"></a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://cursor.sh"><img src="./doc/cursor-logo.svg" width="80" height="80" alt="Cursor" style="vertical-align: middle"></a>
  <h1 align="center">openclaw-cursor-brain</h1>
  <p align="center">
    Use <a href="https://cursor.sh">Cursor</a> as the AI brain for <a href="https://github.com/openclaw/openclaw">OpenClaw</a> — with full access to every plugin tool.
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/openclaw-cursor-brain"><img src="https://img.shields.io/npm/v/openclaw-cursor-brain.svg" alt="npm version"></a>
    <a href="https://www.npmjs.com/package/openclaw-cursor-brain"><img src="https://img.shields.io/npm/dm/openclaw-cursor-brain.svg" alt="npm downloads"></a>
    <a href="https://github.com/openclaw/openclaw"><img src="https://img.shields.io/badge/OpenClaw-Plugin-orange.svg" alt="OpenClaw Plugin"></a>
    <a href="https://cursor.sh"><img src="https://img.shields.io/badge/Cursor-Agent%20CLI-purple.svg" alt="Cursor"></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D18-green.svg" alt="Node.js >= 18"></a>
    <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
    <br/>
    <a href="./README_ZH.md">中文文档</a> · <a href="./doc/technical-guide-en.md">Technical Guide</a> · <a href="./doc/technical-guide-zh.md">技术设计文档</a>
  </p>
</p>

---

**openclaw-cursor-brain** is an [OpenClaw](https://github.com/openclaw/openclaw) plugin that turns [Cursor Agent CLI](https://cursor.sh) into a fully-integrated, streaming AI backend via [MCP](https://modelcontextprotocol.io). All OpenClaw plugin tools become natively accessible to Cursor — and vice versa.

## Prerequisites

- [Cursor IDE](https://cursor.sh) installed and launched at least once
- Cursor Agent CLI enabled: open Cursor → `Cmd+Shift+P` → type **Install 'cursor' command** → Enter (after this, `cursor-agent` or `agent` is available in the terminal)
- [OpenClaw](https://github.com/openclaw/openclaw) installed globally (`npm i -g openclaw`)
- Node.js ≥ 18

## Quick Start

```bash
openclaw plugins install openclaw-cursor-brain # install & configure
openclaw gateway restart                       # restart gateway
openclaw cursor-brain doctor                   # verify
```

During **setup** (and **upgrade**), models are dynamically discovered from `cursor-agent --list-models`. Primary is single-select; fallbacks are multi-select (space to toggle), defaulting to all models in cursor's original order:

```
◆  Select primary model (↑↓ navigate, enter confirm)
│  ● auto              Auto
│  ○ opus-4.6-thinking Claude 4.6 Opus (thinking, cursor default)
│  ○ opus-4.6          Claude 4.6 Opus
│  ○ sonnet-4.6        Claude 4.6 Sonnet
│  ○ gpt-5.3-codex     GPT-5.3 Codex
│  …
└

◆  Select fallback models (space toggle, enter confirm, order follows list)
│  ◼ opus-4.6-thinking Claude 4.6 Opus (thinking, cursor default)
│  ◼ opus-4.6          Claude 4.6 Opus
│  ◼ sonnet-4.6        Claude 4.6 Sonnet
│  …
└
```

## How It Works

```mermaid
flowchart LR
    subgraph Channels ["📱 Messaging Channels"]
        direction TB
        Feishu["Feishu"]
        Slack["Slack"]
        Web["Web / API"]
    end

    subgraph Core ["🔄 Bidirectional Bridge"]
        direction TB
        GW["OpenClaw<br/>Gateway"]

        subgraph ProxyBox ["⚡ Streaming Proxy :18790"]
            Proxy["OpenAI-compatible API<br/>• Session auto-derive<br/>• InstantResult<br/>• scriptHash auto-restart"]
        end

        subgraph MCPBox ["🔌 MCP Server (stdio)"]
            MCP["Tool Gateway<br/>• Rich descriptions<br/>• Timeout + retry<br/>• Auto-discovery"]
        end
    end

    subgraph AI ["🧠 Cursor Agent"]
        Agent["cursor-agent CLI<br/>--stream-partial-output<br/>--resume session"]
    end

    subgraph Tools ["🛠️ Plugin Tools"]
        direction TB
        T1["feishu_doc"]
        T2["feishu_wiki"]
        T3["GitHub · DB · …"]
    end

    Channels -->|"User messages"| GW
    GW -->|"POST /v1/chat/completions"| Proxy
    Proxy -->|"spawn + stdin"| Agent
    Agent -->|"SSE stream"| Proxy
    Proxy -->|"Response"| GW
    GW -->|"Reply"| Channels

    Agent <-->|"MCP stdio"| MCP
    MCP -->|"POST /tools/invoke"| GW
    GW --> Tools

    style Proxy fill:#2563eb,color:#fff,stroke:#1d4ed8
    style MCP fill:#7c3aed,color:#fff,stroke:#6d28d9
    style Agent fill:#ea580c,color:#fff,stroke:#c2410c
    style GW fill:#0891b2,color:#fff,stroke:#0e7490
```

Two auto-configured paths:

1. **Streaming Proxy** — local OpenAI-compatible server (`/v1/chat/completions`) spawns `cursor-agent` with `--stream-partial-output`, streams text deltas as SSE in real-time. Includes tool call logging, instant result delivery, optional thinking forwarding, and script hash-based auto-restart on upgrade.
2. **MCP Server** — Cursor IDE calls OpenClaw tools via stdio, proxied to Gateway REST API with timeout/retry. Server instructions include rich tool descriptions (token extraction rules, action keys, parameter examples) to minimize unnecessary `openclaw_skill` calls.

Sessions are persisted to disk and reused via `--resume` for faster subsequent responses (context survives restarts). Session IDs are automatically derived from conversation metadata embedded in user messages (e.g., `sender_id` for DM, `group_channel` + `topic_id` for group chats), or can be passed explicitly via body fields (`_openclaw_session_id`, `session_id`) or HTTP headers (`X-OpenClaw-Session-Id`, `X-Session-Id`). New plugins are auto-discovered on gateway restart.

## Bidirectional Enhancement

- **OpenClaw gains Cursor AI** — all channels (Slack, Feishu, Web, etc.) get Cursor's frontier models as the AI backend
- **Cursor IDE gains OpenClaw tools** — all plugin tools auto-registered as MCP tools, letting Cursor natively call Feishu, Slack, GitHub, databases, etc.
- **Compound effect** — a single agent session can read Slack, write code, push to GitHub, and notify on Feishu — no context switching

## Features

- **Zero config** — install and restart; everything auto-configures
- **Interactive model selection** — `setup`/`upgrade` present all discovered models via `@clack/prompts` (single-select primary, multi-select ordered fallbacks)
- **Dynamic model discovery** — models auto-detected from `cursor-agent --list-models`, synced to OpenClaw on every gateway start
- **Real-time streaming** — `--stream-partial-output` for character-level text deltas; instant result delivery by default (`CURSOR_PROXY_INSTANT_RESULT=true`), with optional smart-chunked fallback
- **Thinking forwarding** — optionally stream LLM reasoning via `reasoning_content` (OpenAI-compatible `CURSOR_PROXY_FORWARD_THINKING=true`)
- **Rich tool descriptions** — MCP server instructions include token extraction rules, exact action keys, and parameter examples from SKILL.md — reducing unnecessary `openclaw_skill` calls
- **Tool call logging** — proxy logs every tool invocation with name, arguments summary, duration, and call ID for diagnostics
- **Tool auto-discovery** — disk-based registration from SKILL.md at startup (no Gateway dependency); background verification for diagnostics; cached with 60s TTL
- **Session auto-derive** — session keys automatically derived from conversation metadata (sender/group/topic) in user messages; no explicit session ID required from Gateway
- **Session persistence** — cursor-agent sessions persisted to disk (`~/.openclaw/cursor-sessions.json`); explicit session IDs also accepted via body fields or HTTP headers (`X-OpenClaw-Session-Id`, `X-Session-Id`)
- **Auto-restart on upgrade** — proxy exposes a `scriptHash` in `/v1/health`; gateway compares it against the installed script hash and auto-restarts when code changes
- **Three-layer fault tolerance** — request-level: auto-clear stale session and retry once; process-level: self-exit after consecutive failures to trigger restart; gateway-level: exponential backoff auto-restart on crash (2s → 10s → 60s, resets after 5min stable)
- **Version guard** — `upgrade` command detects version comparison; downgrade or same-version requires confirmation
- **Standalone proxy** — `streaming-proxy.mjs` runs independently as OpenAI-compatible API (auto-detection, API key auth, CORS)
- **Reliability** — tool call timeout (60s), retry (2x), structured MCP errors (`isError: true`)
- **Proxy management** — `proxy status/stop/restart/log` commands for lifecycle control without restarting gateway
- **Diagnostics** — `doctor` (10+ checks), `status`, and `proxy log` commands
- **Request safety** — request body size limit (10 MB), per-request timeout, graceful client disconnect handling
- **Cross-platform** — macOS, Linux, Windows (port management, health checks)

## Configuration

In `openclaw.json` under `plugins.entries.openclaw-cursor-brain.config`:

| Option          | Type   | Default     | Description                                                                      |
| --------------- | ------ | ----------- | -------------------------------------------------------------------------------- |
| `cursorPath`    | string | auto-detect | Path to cursor-agent binary                                                      |
| `model`         | string | interactive | Primary model (override to skip interactive selection)                           |
| `fallbackModel` | string | interactive | Fallback model override (interactive selection provides ordered multi-fallbacks) |
| `cursorModel`   | string | `""` (auto) | Direct `cursor-agent --model` override (e.g. `sonnet-4.6`, `opus-4.6-thinking`)  |
| `outputFormat`  | string | auto-detect | `"stream-json"` or `"json"`                                                      |
| `proxyPort`     | number | `18790`     | Streaming proxy port                                                             |

<details>
<summary><strong>Environment variables</strong></summary>

| Variable                                | Default  | Description                                                               |
| --------------------------------------- | -------- | ------------------------------------------------------------------------- |
| `OPENCLAW_TOOL_TIMEOUT_MS`              | `60000`  | Tool call timeout (ms)                                                    |
| `OPENCLAW_TOOL_RETRY_COUNT`             | `2`      | Max retries on transient errors                                           |
| `CURSOR_PROXY_INSTANT_RESULT`           | `true`   | Send batch results instantly instead of simulated streaming               |
| `CURSOR_PROXY_FORWARD_THINKING`         | `false`  | Forward LLM reasoning as `reasoning_content` in SSE chunks                |
| `CURSOR_PROXY_STREAM_SPEED`             | `200`    | Chunked streaming speed (chars/sec, only when `INSTANT_RESULT=false`)     |
| `CURSOR_PROXY_REQUEST_TIMEOUT`          | `300000` | Per-request timeout in ms (default 5 min)                                 |
| `CURSOR_PROXY_MAX_CONSECUTIVE_FAILURES` | `5`      | Consecutive failure threshold; proxy self-exits for restart when exceeded |
| `CURSOR_PROXY_API_KEY`                  | _(none)_ | API key for standalone proxy auth                                         |

</details>

## CLI Commands

| Command                                  | Description                                 |
| ---------------------------------------- | ------------------------------------------- |
| `openclaw cursor-brain setup`            | Configure MCP + interactive model selection |
| `openclaw cursor-brain doctor`           | Health check (10+ items)                    |
| `openclaw cursor-brain status`           | Show versions, config, models & tool count  |
| `openclaw cursor-brain upgrade <source>` | One-command upgrade + model selection       |
| `openclaw cursor-brain uninstall`        | Full uninstall (configs + files)            |
| `openclaw cursor-brain proxy`            | Show proxy status (PID, port, sessions)     |
| `openclaw cursor-brain proxy stop`       | Stop the streaming proxy                    |
| `openclaw cursor-brain proxy restart`    | Restart proxy (detached)                    |
| `openclaw cursor-brain proxy log [-n N]` | Show last N lines of proxy log (default 30) |

## Standalone Streaming Proxy

The proxy works without OpenClaw, turning any Cursor into an OpenAI-compatible API:

```bash
node mcp-server/streaming-proxy.mjs
# with options:
CURSOR_PROXY_PORT=8080 CURSOR_PROXY_API_KEY=secret node mcp-server/streaming-proxy.mjs
```

```bash
curl http://127.0.0.1:18790/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"Hello!"}]}'
```

Endpoints: `POST /v1/chat/completions`, `GET /v1/models`, `GET /v1/health` (returns `scriptHash` for version detection). Supports API key auth, CORS, session reuse via body or headers.

<details>
<summary><strong>Auto-configured files</strong></summary>

### ~/.cursor/mcp.json

```json
{
  "mcpServers": {
    "openclaw-gateway": {
      "command": "node",
      "args": ["<plugin-path>/mcp-server/server.mjs"],
      "env": {
        "OPENCLAW_GATEWAY_URL": "http://127.0.0.1:<port>",
        "OPENCLAW_GATEWAY_TOKEN": "<token>"
      }
    }
  }
}
```

### openclaw.json (after interactive selection)

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "cursor-local/auto",
        "fallbacks": ["cursor-local/opus-4.6", "cursor-local/sonnet-4.6", "..."]
      }
    }
  },
  "models": {
    "providers": {
      "cursor-local": {
        "api": "openai-completions",
        "baseUrl": "http://127.0.0.1:18790/v1",
        "apiKey": "local",
        "models": [
          { "id": "auto", "name": "Auto" },
          { "id": "opus-4.6", "name": "Claude 4.6 Opus" },
          "..."
        ]
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Troubleshooting</strong></summary>

| Problem                          | Fix                                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Cursor Agent CLI not found"     | Install Cursor and launch once, or set `config.cursorPath`                                                                                                         |
| Gateway error                    | Confirm gateway running (`openclaw gateway status`), check token                                                                                                   |
| Tools not appearing              | Restart gateway, call `openclaw_discover` in Cursor                                                                                                                |
| Tool timeout                     | Set `OPENCLAW_TOOL_TIMEOUT_MS=120000`                                                                                                                              |
| Proxy not starting               | `openclaw cursor-brain proxy log` to check; `proxy restart` to force start                                                                                         |
| Proxy not updating after upgrade | Gateway auto-restarts proxy when `scriptHash` differs; verify with `curl http://127.0.0.1:18790/v1/health`                                                         |
| Slow batch responses             | `CURSOR_PROXY_INSTANT_RESULT` defaults to `true`; if set to `false`, batch results are chunked at ~200 chars/s                                                     |
| Context lost between messages    | Check `cursor-proxy.log` for `session=auto:dm:…(meta.auto)` — if showing `session=none(none)`, ensure Gateway embeds "Conversation info" metadata in user messages |
| Context lost after restart       | Sessions auto-persist to disk; use `proxy restart` (not `gateway restart`) to keep sessions                                                                        |
| Debug MCP server                 | `OPENCLAW_GATEWAY_URL=... node mcp-server/server.mjs`                                                                                                              |
| Debug tool calls                 | Check `~/.openclaw/cursor-proxy.log` for `tool:start` / `tool:done` entries                                                                                        |

</details>

<details>
<summary><strong>Project structure</strong></summary>

```
openclaw-cursor-brain/
  index.ts                  # Plugin entry (register + CLI commands)
  openclaw.plugin.json      # Plugin metadata + config schema
  src/
    constants.ts            # Paths, IDs, output format types
    setup.ts                # Idempotent setup, model discovery, format detection
    doctor.ts               # Health checks (11 items)
    cleanup.ts              # Uninstall cleanup
  mcp-server/
    server.mjs              # MCP server (tool discovery, timeout/retry)
    streaming-proxy.mjs     # OpenAI-compatible streaming proxy
```

</details>

## License

[MIT](./LICENSE)

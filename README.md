<p align="center">
  <h1 align="center">openclaw-cursor-bridge</h1>
  <p align="center">
    Use <a href="https://cursor.sh">Cursor</a> as the AI brain for <a href="https://github.com/openclaw/openclaw">OpenClaw</a> — with full access to every plugin tool.
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/openclaw-cursor-bridge"><img src="https://img.shields.io/npm/v/openclaw-cursor-bridge.svg" alt="npm version"></a>
    <a href="https://www.npmjs.com/package/openclaw-cursor-bridge"><img src="https://img.shields.io/npm/dm/openclaw-cursor-bridge.svg" alt="npm downloads"></a>
    <a href="https://github.com/openclaw/openclaw"><img src="https://img.shields.io/badge/OpenClaw-Plugin-orange.svg" alt="OpenClaw Plugin"></a>
    <a href="https://cursor.sh"><img src="https://img.shields.io/badge/Cursor-Agent%20CLI-purple.svg" alt="Cursor"></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D18-green.svg" alt="Node.js >= 18"></a>
    <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
    <br/>
    <a href="./README_ZH.md">中文文档</a>
  </p>
</p>

---

**cursor-bridge** is an [OpenClaw](https://github.com/openclaw/openclaw) plugin that turns [Cursor Agent CLI](https://cursor.sh) into a fully-integrated LLM backend. It bridges all OpenClaw plugin tools (Feishu, Slack, GitHub, custom plugins, etc.) to Cursor through the [Model Context Protocol (MCP)](https://modelcontextprotocol.io), so the AI can call them natively.

**Zero manual config.** Install, restart, done.

## How It Works

```
User message → OpenClaw Gateway → cursor-cli (CLI backend)
                                       ↓
                                 Cursor Agent
                                       ↓
                             MCP Server (this plugin)
                                       ↓
                           Gateway REST API (/tools/invoke)
                                       ↓
                             Plugin tools (Feishu, Slack, …)
```

1. **On install** — auto-configures `~/.cursor/mcp.json` and the `cursor-cli` backend in `openclaw.json`.
2. **On each conversation** — `cursor-cli` spawns the MCP Server process.
3. **On MCP Server start** — reads `openclaw.json`, scans installed plugin source files for tool declarations, verifies each via the Gateway REST API, and registers them as MCP tools.
4. **On tool call** — Cursor Agent calls the tool through MCP; the server proxies it to the Gateway.

Newly installed OpenClaw plugins are **auto-discovered** — no extra configuration needed.

## Quick Start

### Prerequisites

- **Node.js** >= 18
- **[Cursor CLI](https://cursor.sh)** installed (`agent` command available)
- **OpenClaw Gateway** running

### Install

```bash
# From local path (development)
openclaw plugins install /path/to/openclaw-cursor-bridge

# From .tgz archive (team distribution)
openclaw plugins install ./openclaw-cursor-bridge-1.0.0.tgz

# From npm
openclaw plugins install openclaw-cursor-bridge

# Restart the gateway to load the plugin
openclaw gateway restart
```

### Verify

```bash
openclaw cursor-bridge doctor   # Health check
openclaw cursor-bridge status   # Show configuration
```

## Building & Packaging

```bash
cd /path/to/openclaw-cursor-bridge
npm pack
# → openclaw-cursor-bridge-<version>.tgz (~12 KB)
```

Share the `.tgz` with teammates — they run `openclaw plugins install <file>.tgz` and dependencies install automatically.

## Configuration

All options go in `openclaw.json` under `plugins.entries.cursor-bridge.config`:

| Option          | Type     | Default        | Description                                                                                                |
| --------------- | -------- | -------------- | ---------------------------------------------------------------------------------------------------------- |
| `cursorPath`    | `string` | auto-detect    | Path to the Cursor Agent CLI binary. Leave empty for automatic detection via `which agent` + common paths. |
| `model`         | `string` | `"auto"`       | Primary model, written as `cursor-cli/<model>` in `agents.defaults.model.primary`.                         |
| `fallbackModel` | `string` | `"sonnet-4.6"` | Fallback model, written to `agents.defaults.model.fallbacks`.                                              |

Example:

```json
{
  "plugins": {
    "entries": {
      "cursor-bridge": {
        "enabled": true,
        "config": {
          "model": "auto",
          "fallbackModel": "sonnet-4.6"
        }
      }
    }
  }
}
```

Setup is **idempotent** — runs on every gateway start and never duplicates existing configuration.

## CLI Commands

| Command                                   | Description                                                 |
| ----------------------------------------- | ----------------------------------------------------------- |
| `openclaw cursor-bridge setup`            | Re-run configuration (writes mcp.json + CLI backend)        |
| `openclaw cursor-bridge doctor`           | Health check all components                                 |
| `openclaw cursor-bridge status`           | Show current configuration details                          |
| `openclaw cursor-bridge upgrade <source>` | One-command upgrade (cleanup → uninstall → install)         |
| `openclaw cursor-bridge uninstall`        | One-command full uninstall (cleanup configs + remove files) |

### Upgrade

```bash
openclaw cursor-bridge upgrade ./openclaw-cursor-bridge-2.0.0.tgz
openclaw gateway restart
```

### Uninstall

```bash
openclaw cursor-bridge uninstall
openclaw gateway restart
```

This performs a complete teardown:

1. Removes the plugin config entry (`openclaw plugins uninstall`, auto-confirmed)
2. Deletes the plugin directory `~/.openclaw/extensions/cursor-bridge`
3. Cleans up all custom configuration (see table below)
4. Prompts you to restart the gateway

| Location                                      | What's removed                      |
| --------------------------------------------- | ----------------------------------- |
| `~/.cursor/mcp.json`                          | `openclaw-gateway` MCP server entry |
| `openclaw.json` `agents.defaults.cliBackends` | `cursor-cli` backend config         |
| `openclaw.json` `agents.defaults.model`       | `cursor-cli/*` model references     |
| `openclaw.json` `plugins.entries`             | `cursor-bridge` registration        |

> **Warning:** Do not run `openclaw plugins uninstall cursor-bridge` directly — it only removes the config entry, not the custom configuration above. If you did this by mistake, manually edit `~/.cursor/mcp.json` and `~/.openclaw/openclaw.json` to remove the leftover entries.

## Auto-configured Files

### ~/.cursor/mcp.json

```json
{
  "mcpServers": {
    "openclaw-gateway": {
      "command": "node",
      "args": ["<plugin-install-path>/mcp-server/server.mjs"],
      "env": {
        "OPENCLAW_GATEWAY_URL": "http://127.0.0.1:<port>",
        "OPENCLAW_GATEWAY_TOKEN": "<token>",
        "OPENCLAW_CONFIG_PATH": "~/.openclaw/openclaw.json"
      }
    }
  }
}
```

### openclaw.json agents.defaults

```json
{
  "model": {
    "primary": "cursor-cli/auto",
    "fallbacks": ["cursor-cli/sonnet-4.6"]
  },
  "cliBackends": {
    "cursor-cli": {
      "command": "/bin/bash",
      "args": [
        "-c",
        "export SHELL=/bin/bash && cd <workspace> && exec <cursorPath> \"$@\"",
        "_",
        "-p",
        "--output-format",
        "json",
        "--trust",
        "--approve-mcps",
        "--force"
      ],
      "output": "json",
      "input": "arg",
      "modelArg": "--model",
      "sessionArg": "--resume",
      "sessionMode": "existing"
    }
  }
}
```

## Cross-platform Support

| Platform | Cursor CLI detection                                                      | Shell       | mcp.json location                |
| -------- | ------------------------------------------------------------------------- | ----------- | -------------------------------- |
| macOS    | `~/.local/bin/agent`, `/usr/local/bin/agent`, `~/.cursor/bin/agent`       | `/bin/bash` | `~/.cursor/mcp.json`             |
| Linux    | Same as macOS                                                             | `/bin/bash` | `~/.cursor/mcp.json`             |
| Windows  | `%LOCALAPPDATA%\Programs\cursor\...\agent.exe`, `~\.cursor\bin\agent.exe` | `cmd.exe`   | `%USERPROFILE%\.cursor\mcp.json` |

## MCP Server Tools

The MCP Server auto-discovers and registers all OpenClaw plugin tools at startup. Two built-in tools are always available:

| Tool                | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `openclaw_invoke`   | Universal invoker — call any Gateway tool by name     |
| `openclaw_discover` | Discovery — list all available tools with live status |

### Tool Discovery Mechanism

No regex, no log parsing — fully structured:

1. Parse `openclaw.json` to get installed plugin paths
2. Scan each plugin's `src/*.ts` for `name: "tool_name"` declarations
3. Verify each candidate via Gateway REST API probe
4. Register only verified tools with generic MCP schemas

## Troubleshooting

**`doctor` reports "Cursor Agent CLI not found"**

- Ensure Cursor is installed and has been launched at least once (to generate the `agent` binary)
- Or set the path explicitly: `config.cursorPath = "/path/to/agent"`

**Tool calls return "Gateway error"**

- Confirm the gateway is running: `openclaw gateway status`
- Check that tokens match between `~/.cursor/mcp.json` and `openclaw.json`

**Newly installed plugin tools don't appear**

- Restart the gateway to trigger tool registration
- Call `openclaw_discover` to check live tool availability
- Use `openclaw_invoke` to call any tool directly by name

## Project Structure

```
cursor-bridge/
  package.json              # Dependencies & metadata
  openclaw.plugin.json      # OpenClaw plugin manifest
  index.ts                  # Plugin entry (register + CLI commands)
  src/
    constants.ts            # Cross-platform path constants
    setup.ts                # Idempotent setup logic
    doctor.ts               # Health checks
    cleanup.ts              # Uninstall cleanup logic
  mcp-server/
    server.mjs              # MCP bridge (JSON parsing + REST probing)
  skills/
    cursor-bridge/
      SKILL.md              # Agent skill description
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](./LICENSE) — use it, fork it, improve it.

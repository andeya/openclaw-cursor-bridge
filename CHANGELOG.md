# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] - 2026-03-05

### Fixed

- MCP server startup race condition: tool registration no longer depends on Gateway liveness probes; tools are registered immediately from disk-based SKILL.md candidates, with background verification for diagnostics only
- Streaming proxy: `SHELL` env was hardcoded to `/bin/bash`, breaking `cursor-agent` spawn on Windows; now respects `process.env.SHELL` on Unix and omits it on Windows
- Streaming proxy: SIGTERM/SIGINT now gracefully waits for active connections to close (10s timeout) instead of immediate `process.exit`
- Default model selection: replaced hardcoded `sonnet-4.6` fallback with dynamic `isDefault` lookup from discovered models
- Doctor check: plugin version "unknown" now correctly reports as a failure instead of a false positive
- Replace `\n` with `<br/>` in Mermaid diagrams for correct rendering across platforms

### Changed

- Updated technical guide (EN/ZH): "Three-Phase Tool Discovery" rewritten as "Tool Discovery & Registration" with updated Mermaid diagrams reflecting disk-based immediate registration
- Updated README (EN/ZH): tool auto-discovery feature description now reflects the new startup behavior
- Backfilled CHANGELOG entries for versions 1.1.0, 1.2.0, and 1.3.0

## [1.3.0] - 2026-03-05

### Added

- Technical design documents (English and Chinese)
- `openclaw_skill` tool: full usage documentation with batch loading and cross-reference detection
- Progressive disclosure: server instructions with capability briefs → capability summary in static tool descriptions → full SKILL.md via `openclaw_skill`
- Brand logos (OpenClaw + Cursor) in README headers

## [1.2.0] - 2026-03-05

### Added

- Session auto-derive from conversation metadata (sender/group/topic) embedded in user messages
- Rich MCP server instructions: token extraction rules, action keys, parameter examples from SKILL.md
- Proxy hardening: request body size limit (10 MB), per-request timeout, graceful client disconnect handling
- Tool call logging with name, arguments summary, duration, and call ID

## [1.1.0] - 2026-03-05

### Added

- Streaming proxy (`streaming-proxy.mjs`): OpenAI-compatible API wrapping `cursor-agent` with real-time SSE streaming
- Session persistence to disk (`~/.openclaw/cursor-sessions.json`) with `--resume` reuse
- Interactive model selection via `@clack/prompts` (single-select primary, multi-select ordered fallbacks)
- Dynamic model discovery from `cursor-agent --list-models`
- Proxy CLI commands: `proxy status/stop/restart/log`
- Script hash-based auto-restart on upgrade (`scriptHash` in `/v1/health`)
- Instant result delivery (`CURSOR_PROXY_INSTANT_RESULT`) and optional thinking forwarding (`CURSOR_PROXY_FORWARD_THINKING`)

## [1.0.0] - 2026-03-04

### Added

- Initial release
- MCP server with structured tool discovery (SKILL.md scanning + source file parsing)
- Auto-detection of Cursor Agent CLI across macOS, Linux, and Windows
- Idempotent setup: auto-configures `~/.cursor/mcp.json` and `openclaw.json` on gateway start
- CLI commands: `setup`, `doctor`, `status`, `uninstall`, `upgrade`
- Built-in MCP tools: `openclaw_invoke` (universal invoker) and `openclaw_discover` (live tool listing)
- One-command uninstall with full configuration cleanup
- One-command upgrade with automatic old version removal
- Cross-platform support (macOS, Linux, Windows)
- Agent skill file for Cursor integration

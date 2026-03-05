# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-03-04

### Added

- Initial release
- MCP server with structured tool discovery (JSON parsing + REST API probing)
- Auto-detection of Cursor Agent CLI across macOS, Linux, and Windows
- Idempotent setup: auto-configures `~/.cursor/mcp.json` and `openclaw.json` on gateway start
- CLI commands: `setup`, `doctor`, `status`, `uninstall`, `upgrade`
- Built-in MCP tools: `openclaw_invoke` (universal invoker), `openclaw_discover` (live tool listing), and `openclaw_skill` (full tool documentation with batch loading and cross-reference detection)
- Progressive disclosure: server instructions with capability briefs → capability summary in static tool descriptions → full SKILL.md via `openclaw_skill`
- One-command uninstall with full configuration cleanup
- One-command upgrade with automatic old version removal
- Cross-platform support (macOS, Linux, Windows)
- Agent skill file for Cursor integration

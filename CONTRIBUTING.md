# Contributing to cursor-brain

Thank you for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/andeya/openclaw-cursor-brain.git
cd openclaw-cursor-brain
npm install
```

### Local Testing

Install the plugin from your local working copy:

```bash
openclaw plugins install /path/to/openclaw-cursor-brain
openclaw gateway restart
```

After making changes, sync to the installed directory or use the upgrade command:

```bash
openclaw cursor-brain upgrade /path/to/openclaw-cursor-brain
openclaw gateway restart
```

### Verify Your Changes

```bash
openclaw cursor-brain doctor   # Health check
openclaw cursor-brain status   # Configuration overview
```

## Project Structure

```
index.ts              → Plugin entry point (register hook + CLI commands)
src/
  constants.ts        → Cross-platform paths and constants
  setup.ts            → Idempotent setup logic (detect Cursor, write configs)
  doctor.ts           → Health check implementation
  scripts/uninstall.mjs → Uninstall: openclaw.json + MCP + extension dir (--config-only for upgrade)
mcp-server/
  server.mjs          → MCP server (tool discovery + REST proxy)
skills/
  cursor-brain/
    SKILL.md          → Agent skill description for Cursor
```

## Guidelines

- **Cross-platform**: Always consider Windows, macOS, and Linux. Use `process.platform` checks and `path.join` instead of hardcoded separators.
- **Idempotent**: Setup and configuration writes must be safe to run multiple times.
- **Zero config**: New features should work out of the box whenever possible.
- **No hardcoded tools**: The MCP server discovers tools dynamically — never hardcode specific plugin tool names.
- **English code**: All code, comments, log messages, and CLI output must be in English.

## Submitting Changes

1. Fork the repository and create a feature branch
2. Make your changes following the guidelines above
3. Test locally with `openclaw cursor-brain doctor`
4. Submit a pull request with a clear description

## Reporting Issues

Please include:

- Output of `openclaw cursor-brain doctor`
- Output of `openclaw cursor-brain status`
- Your OS and Node.js version
- Steps to reproduce the issue

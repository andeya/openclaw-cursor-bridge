# Contributing to cursor-bridge

Thank you for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/nicepkg/openclaw-cursor-bridge.git
cd openclaw-cursor-bridge
npm install
```

### Local Testing

Install the plugin from your local working copy:

```bash
openclaw plugins install /path/to/openclaw-cursor-bridge
openclaw gateway restart
```

After making changes, sync to the installed directory or use the upgrade command:

```bash
openclaw cursor-bridge upgrade /path/to/openclaw-cursor-bridge
openclaw gateway restart
```

### Verify Your Changes

```bash
openclaw cursor-bridge doctor   # Health check
openclaw cursor-bridge status   # Configuration overview
```

## Project Structure

```
index.ts              → Plugin entry point (register hook + CLI commands)
src/
  constants.ts        → Cross-platform paths and constants
  setup.ts            → Idempotent setup logic (detect Cursor, write configs)
  doctor.ts           → Health check implementation
  cleanup.ts          → Uninstall cleanup (direct file I/O)
mcp-server/
  server.mjs          → MCP bridge server (tool discovery + REST proxy)
skills/
  cursor-bridge/
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
3. Test locally with `openclaw cursor-bridge doctor`
4. Submit a pull request with a clear description

## Reporting Issues

Please include:
- Output of `openclaw cursor-bridge doctor`
- Output of `openclaw cursor-bridge status`
- Your OS and Node.js version
- Steps to reproduce the issue

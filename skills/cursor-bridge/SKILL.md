# Cursor Bridge

Bridge between OpenClaw Gateway plugin tools and the Cursor Agent via MCP.

## When to activate

Activate when:
- User wants to use capabilities from installed OpenClaw plugins (docs, messaging, databases, etc.)
- User asks about available OpenClaw tools
- User shares a URL or resource from a connected service

## Available MCP tools

The Cursor Bridge exposes all OpenClaw Gateway plugin tools as MCP tools. Tools are auto-registered on each session start.

### Discovery

- Call `openclaw_discover` to list all currently available tools with live status
- Call `openclaw_invoke` with any tool name to use tools not directly registered

### Common patterns

**Discover available tools:**
```
openclaw_discover()
```

**Call any tool by name:**
```
openclaw_invoke(tool="<tool_name>", action="<action>", args_json='{"key":"value"}')
```

**Call a directly registered tool:**
```
<tool_name>(action="<action>", args_json='{"key":"value"}')
```

## Notes

- All tool calls are proxied through the OpenClaw Gateway REST API
- Tools are auto-discovered from installed plugins on each session start
- New plugins installed in OpenClaw are automatically available without configuration
- Use `openclaw_discover` first to see what's available before calling tools

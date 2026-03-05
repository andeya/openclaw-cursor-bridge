# Cursor Brain

Use Cursor Agent as the AI brain for OpenClaw, connecting all Gateway plugin tools via MCP.

## When to activate

Activate when:
- User wants to use capabilities from installed OpenClaw plugins (docs, messaging, databases, etc.)
- User asks about available OpenClaw tools
- User shares a URL or resource from a connected service

## Available MCP tools

Cursor Brain exposes all OpenClaw Gateway plugin tools as MCP tools. Tools are auto-registered on each session start.

### Discovery & Documentation

- Call `openclaw_discover` to list all currently available tools with short descriptions and `[has skill]` badges
- Call `openclaw_skill(tool="<tool_name>")` to get full usage documentation (actions, parameters, JSON examples) for a specific tool — supports comma-separated names for batch loading
- Call `openclaw_invoke` with any tool name to use tools not directly registered

### Common patterns

**Discover available tools:**
```
openclaw_discover()
```

**Get full documentation for a tool before first use:**
```
openclaw_skill(tool="feishu_doc")
```

**Get documentation for multiple tools at once:**
```
openclaw_skill(tool="feishu_doc,feishu_wiki")
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
- For common operations (read, write, append), server instructions already provide enough context — use `openclaw_skill` only for advanced operations or when unsure about parameters
- `openclaw_skill` also detects cross-references: if a tool's documentation mentions other tools, they are listed at the end

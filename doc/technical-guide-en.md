# openclaw-cursor-brain Technical Design Document

> This document is oriented towards technical sharing, with emphasis on architectural design and implementation details. It is suitable for team technical reviews, open-source community presentations, or new contributor onboarding.

---

## Table of Contents

- [Chapter 1: Project Overview](#chapter-1-project-overview)
- [Chapter 2: Overall Architecture](#chapter-2-overall-architecture)
- [Chapter 3: Data Flow Analysis](#chapter-3-data-flow-analysis)
- [Chapter 4: Key Technical Decisions](#chapter-4-key-technical-decisions)
- [Chapter 5: Module Design Details](#chapter-5-module-design-details)
- [Chapter 6: Installation & Configuration](#chapter-6-installation--configuration)
- [Chapter 7: Usage Guide](#chapter-7-usage-guide)
- [Chapter 8: Development & Contributing](#chapter-8-development--contributing)

---

## Chapter 1: Project Overview

### 1.1 One-Line Definition

**openclaw-cursor-brain** is a bidirectional MCP bridge plugin between OpenClaw and Cursor — it enables all OpenClaw messaging channels (Feishu, Slack, Web, etc.) to share Cursor's cutting-edge AI capabilities, while simultaneously giving Cursor IDE native access to the entire OpenClaw plugin ecosystem.

### 1.2 Core Problems Solved

| Problem                                                                     | Solution                                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| OpenClaw needs an AI backend to handle user requests                        | Wrap Cursor Agent CLI as an OpenAI-compatible Streaming Proxy             |
| Cursor IDE cannot directly call external services (Feishu, databases, etc.) | Expose OpenClaw plugin tools to Cursor via MCP Server                     |
| Tool registration requires manual configuration                             | Dynamic discovery: source scanning + REST API probing + auto-registration |
| Multiple requests require repeated cold starts                              | Session persistence + `--resume` session reuse                            |

### 1.3 Tech Stack

| Component         | Technology                          | Notes                                                      |
| ----------------- | ----------------------------------- | ---------------------------------------------------------- |
| Runtime           | Node.js >= 18                       | Supports ESM, SharedArrayBuffer, top-level await           |
| Module System     | ESM (`"type": "module"`)            | Required by MCP SDK                                        |
| Plugin Entry      | TypeScript (`index.ts`)             | OpenClaw Plugin SDK type safety                            |
| MCP Server        | JavaScript (`server.mjs`)           | Requires top-level await; TypeScript compilation too heavy |
| Streaming Proxy   | JavaScript (`streaming-proxy.mjs`)  | Zero-dependency standalone, lightweight deployment         |
| MCP Protocol      | `@modelcontextprotocol/sdk` ^1.12.1 | Standard MCP tool registration and stdio transport         |
| Schema Validation | `zod` ^3.24.0                       | MCP tool parameter validation                              |

### 1.4 Project Structure

```
openclaw-cursor-brain/
├── index.ts                    # Plugin entry: register() + CLI commands
├── openclaw.plugin.json        # Plugin metadata + config schema
├── package.json                # Dependency declarations
├── src/
│   ├── constants.ts            # Path constants, cross-platform utilities
│   ├── setup.ts                # Idempotent setup: Cursor detection, model discovery, MCP config
│   ├── doctor.ts               # Health checks (11 items)
│   └── cleanup.ts              # Uninstall cleanup (3 layers)
├── mcp-server/
│   ├── server.mjs              # MCP Server: tool discovery + Gateway REST proxy
│   └── streaming-proxy.mjs     # OpenAI-compatible streaming proxy
└── skills/
    └── cursor-brain/
        └── SKILL.md            # Agent skill descriptor
```

---

## Chapter 2: Overall Architecture

### 2.1 Bidirectional Bridge Architecture

The core design of this project is a **bidirectional bridge** — two independent data paths that don't depend on each other, each solving a different directional problem:

<img src="technical-guide-en-mermaid/Untitled-1.png" alt="Bidirectional Bridge Architecture" width="526" />

<details>
<summary>View flowchart source</summary>

```mermaid
flowchart TD
    subgraph channels ["Messaging Channels"]
        direction LR
        CH1["Feishu Group/DM"]
        CH2["Slack Channel"]
        CH3["Web / Custom"]
    end

    subgraph pathA ["Path A: OpenClaw to Cursor (AI Backend)"]
        GW_A["OpenClaw<br/>Gateway"]
        subgraph proxyDetail ["Streaming Proxy :18790"]
            API["OpenAI-Compatible API"]
            SessionMgr["Session Auto-Derive"]
            API --- SessionMgr
        end
        Agent["cursor-agent<br/>-p --stream-partial-output<br/>--trust --approve-mcps"]
    end

    subgraph pathB ["Path B: Cursor to OpenClaw (Tool Calls)"]
        subgraph mcpDetail ["MCP Server stdio"]
            MCPCore["Tool Proxy + Retry"]
            SkillInst["Rich Instructions"]
            MCPCore --- SkillInst
        end
        GW_B["Gateway<br/>REST API"]
    end

    subgraph tools ["Plugin Ecosystem"]
        direction LR
        T1["feishu_doc<br/>feishu_wiki"]
        T2["GitHub<br/>Slack"]
        T3["Database<br/>Custom Plugins"]
    end

    channels -->|"User message"| GW_A
    GW_A -->|"POST /v1/chat/completions"| API
    SessionMgr -->|"spawn + stdin (--resume)"| Agent
    Agent -->|"stdout: JSON lines"| API
    API -->|"SSE real-time stream"| GW_A
    GW_A -->|"Reply"| channels

    Agent <-->|"MCP stdio CallTool"| MCPCore
    MCPCore -->|"POST /tools/invoke"| GW_B
    GW_B --> tools
```

</details>

**Path A** (upper) solves the "AI backend" problem: when a messaging channel receives a user request, the Gateway POSTs to the Streaming Proxy in OpenAI format. The Proxy automatically derives a session key from message metadata (meta → key → `--resume`), reuses cursor-agent sessions, and streams AI responses back in real-time.

**Path B** (lower) solves the "tool calling" problem: when cursor-agent needs external tools during reasoning, it calls the MCP Server via MCP protocol, which forwards requests to the Gateway REST API. The MCP Server instructions embed rich tool descriptions (`extractSkillBrief`), enabling the LLM to call tools directly without first querying documentation.

### 2.2 Component Relationships

<img src="technical-guide-en-mermaid/Untitled-2.png" alt="Component Relationships" width="1583" />

<details>
<summary>View flowchart source</summary>

```mermaid
flowchart TB
    subgraph orchestration ["Orchestration Layer (runs at Gateway startup)"]
        PluginEntry["index.ts<br/>Plugin Entry / register / CLI"]
        Setup["setup.ts<br/>Cursor Detection / Model Discovery<br/>MCP Config / Format Detection"]
        Doctor["doctor.ts<br/>11 Health Checks"]
        Cleanup["cleanup.ts<br/>3-Layer Uninstall Cleanup"]
    end

    subgraph runtime ["Runtime (Long-Running Processes)"]
        Proxy["streaming-proxy.mjs<br/>HTTP :18790 / Session Mgmt<br/>SSE Stream / Tool Call Logging"]
        MCPServer["server.mjs<br/>Tool Discovery / Rich Instructions<br/>Timeout-Retry / Cache"]
    end

    subgraph external ["External Dependencies"]
        GW["OpenClaw Gateway<br/>REST API :18789"]
        AgentCLI["cursor-agent CLI<br/>--stream-partial-output"]
        CursorIDE["Cursor IDE<br/>(manages MCP lifecycle)"]
    end

    PluginEntry -->|"runSetup()"| Setup
    PluginEntry -->|"startProxy()<br/>scriptHash check"| Proxy
    PluginEntry -->|"runDoctorChecks()"| Doctor
    PluginEntry -->|"runCleanup()"| Cleanup
    Proxy -->|"spawn per request"| AgentCLI
    MCPServer -->|"POST /tools/invoke"| GW
    CursorIDE -->|"stdio launch"| MCPServer
```

</details>

### 2.3 Key Design Decisions

**Why CLI spawn instead of SDK integration?**
cursor-agent is Cursor IDE's closed-source CLI tool with no Node.js SDK. The only integration method is subprocess spawn, utilizing its `--output-format stream-json` and `--stream-partial-output` parameters for structured JSON lines output.

**Why .mjs instead of .ts for MCP Server?**
MCP SDK's `McpServer` and `StdioServerTransport` require top-level `await server.connect(transport)`. Using `.mjs` enables direct top-level await without TypeScript compilation, reducing deployment complexity.

**Why are Proxy and MCP Server separate processes?**
The MCP Server communicates with Cursor IDE via stdio (launched via `~/.cursor/mcp.json`), with its lifecycle managed by Cursor. The Streaming Proxy is a persistent HTTP server (auto-started by Gateway), with its lifecycle managed by OpenClaw Gateway. They differ in responsibilities, lifecycles, and communication protocols, necessitating separate processes.

---

## Chapter 3: Data Flow Analysis

### 3.1 Complete Request Lifecycle

Full sequence using "summarize a Feishu document" as an example:

<img src="technical-guide-en-mermaid/Untitled-3.png" alt="Complete Request Lifecycle" width="2293" />

<details>
<summary>View flowchart source</summary>

```mermaid
sequenceDiagram
    participant U as User (Feishu)
    participant GW as OpenClaw Gateway
    participant P as Streaming Proxy
    participant S as Session Store
    participant A as cursor-agent
    participant MCP as MCP Server
    participant API as Gateway REST

    U->>GW: "Summarize: https://feishu.cn/docx/ABC123"
    GW->>P: POST /v1/chat/completions (stream: true)
    Note over GW,P: Request body contains Conversation info metadata<br/>(sender_id, group_channel...)

    rect rgb(219, 234, 254)
        Note over P,S: Session Auto-Derive
        P->>P: extractSessionFromMeta()<br/>-> auto:dm:ou_xxx
        P->>S: sessions.get("auto:dm:ou_xxx")
        S-->>P: cursorSessionId = "abc-def"
    end

    P->>A: spawn cursor-agent -p --resume abc-def
    Note over P,A: Write user message to stdin

    rect rgb(254, 243, 199)
        Note over A,API: Tool Call (on demand)
        A->>A: LLM thinks: recognize Feishu URL -> call feishu_doc
        A->>MCP: tool_call: feishu_doc(read, ABC123)
        Note over P: tool:start feishu_doc
        MCP->>API: POST /tools/invoke {tool, args}
        API-->>MCP: Document content (3.2KB)
        MCP-->>A: Tool result
        Note over P: tool:done feishu_doc 433ms
    end

    A->>A: LLM generates summary
    A-->>P: stdout: {type:"result", result:"This document describes..."}
    A-->>P: stdout: {session_id: "abc-def-new"}

    rect rgb(220, 252, 231)
        Note over P: Response + Persistence
        P->>S: setSession("auto:dm:ou_xxx", "abc-def-new")
        P-->>GW: SSE: data: {"choices":[{"delta":{"content":"..."}}]}
        P-->>GW: data: [DONE]
    end

    GW-->>U: Summary content
```

</details>

### 3.2 Tool Call Chain

Tool call path from within Cursor IDE:

<img src="technical-guide-en-mermaid/Untitled-4.png" alt="Tool Call Chain" width="1396" />

<details>
<summary>View flowchart source</summary>

```mermaid
sequenceDiagram
    participant C as Cursor IDE
    participant MCP as MCP Server (stdio)
    participant GW as Gateway REST API
    participant Plugin as OpenClaw Plugin

    C->>MCP: CallTool("feishu_doc", {action:"read", args_json:"..."})
    MCP->>MCP: Parse args_json to object
    MCP->>GW: POST /tools/invoke<br/>{tool:"feishu_doc", args:{action:"read", doc_token:"..."}}

    alt Success
        GW->>Plugin: Execute tool
        Plugin-->>GW: Result
        GW-->>MCP: {ok:true, result:{content:[{text:"..."}]}}
        MCP-->>C: {content:[{type:"text", text:"..."}]}
    else Timeout (60s)
        MCP->>GW: Retry (up to 2 times)
        GW-->>MCP: Response
        MCP-->>C: Result or isError
    else Non-retryable error
        MCP-->>C: {content:[{text:"Error: ..."}], isError:true}
    end
```

</details>

### 3.3 Session Reuse Flow

<img src="technical-guide-en-mermaid/Untitled-5.png" alt="Session Reuse Flow" width="506" />

<details>
<summary>View flowchart source</summary>

```mermaid
flowchart TD
    Req(["New request arrives"])
    Req --> ExplicitCheck{"body/header contains<br/>explicit session ID?"}

    ExplicitCheck -->|"_openclaw_session_id<br/>session_id<br/>X-OpenClaw-Session-Id<br/>X-Session-Id"| ExplicitKey["Use explicit key"]
    ExplicitCheck -->|"None"| MetaCheck{"Message contains<br/>Conversation info?"}

    MetaCheck -->|"Has sender_id<br/>or group_channel"| AutoKey["Auto-derive key<br/>auto:dm:sender_id<br/>auto:grp:channel:topic"]
    MetaCheck -->|"None"| NoKey["session=none<br/>Fresh session each time"]

    ExplicitKey --> Lookup
    AutoKey --> Lookup
    Lookup["sessions.get(key)<br/>from cursor-sessions.json"]
    Lookup --> HasCursor{"Has cursorSessionId?"}

    HasCursor -->|"Yes (existing session)"| Resume["spawn --resume sessionId<br/>Load store.db history"]
    HasCursor -->|"No (first conversation)"| NewSession["spawn (no --resume)<br/>Create new session"]
    NoKey --> NewSession

    Resume --> AgentRun["cursor-agent executes<br/>reasoning + tool calls"]
    NewSession --> AgentRun

    AgentRun --> Save["setSession(key, newSessionId)<br/>Persist to disk"]
    AgentRun --> OutputExit["Return response<br/>Child process exits"]
```

</details>

**Complete Storage Sequence**:

<img src="technical-guide-en-mermaid/Untitled-6.png" alt="Complete Storage Sequence" width="1531" />

<details>
<summary>View flowchart source</summary>

```mermaid
sequenceDiagram
    participant Client as Caller
    participant Proxy as Streaming Proxy
    participant SessionFile as cursor-sessions.json
    participant AgentProc as cursor-agent (child process)
    participant StoreDB as store.db (SQLite)
    participant Transcript as agent-transcripts/

    Client->>Proxy: POST /v1/chat/completions<br/>(session_key="conv-123")
    Proxy->>SessionFile: Look up "conv-123"
    SessionFile-->>Proxy: cursor_session_id="abc-def"

    Proxy->>AgentProc: spawn --resume abc-def
    AgentProc->>StoreDB: Read blobs table<br/>Load conversation history
    StoreDB-->>AgentProc: Historical messages + tool call records

    AgentProc->>AgentProc: LLM reasoning (with history context)

    AgentProc-->>Proxy: stdout: session_id event
    Proxy->>SessionFile: Update "conv-123" -> new session_id

    AgentProc-->>Proxy: stdout: text/result events
    AgentProc->>StoreDB: Write new conversation records
    Note over AgentProc: Child process exits

    Proxy-->>Client: SSE streaming response
    Note over Transcript: Cursor async writes<br/>session transcript copy
```

</details>

**Two-Layer Session IDs**:

| Layer                    | Source                            | Purpose                                                                 |
| ------------------------ | --------------------------------- | ----------------------------------------------------------------------- |
| **External session key** | Passed by caller (body or header) | Represents "a conversation" from the caller's perspective               |
| **cursor session_id**    | Returned in cursor-agent output   | Represents cursor-agent's internal session context, used for `--resume` |

The Proxy maintains an `external key → cursor session_id` mapping to achieve cross-request session continuity.

**Session Key Resolution Priority** (`resolveSessionKey()`):

1. `body._openclaw_session_id` — OpenClaw-specific field
2. `body.session_id` — Generic field
3. `X-OpenClaw-Session-Id` header
4. `X-Session-Id` header
5. **Message metadata auto-derive** (`meta.auto`) — Parsed from `Conversation info` JSON block in `messages`

**Three-Layer Storage Architecture**:

| Layer                | Path                                                          | Format                        | Content                                                                                                          |
| -------------------- | ------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Session Mapping      | `~/.openclaw/cursor-sessions.json`                            | JSON array `[[key, id], ...]` | External session key → cursor session_id mapping, max 100 entries (LRU)                                          |
| Conversation History | `~/.cursor/chats/<workspace-hash>/<session-uuid>/store.db`    | SQLite 3                      | cursor-agent's complete conversation records (messages, tool calls, results); `--resume` loads context from here |
| Session Transcript   | `~/.cursor/projects/<project>/agent-transcripts/<uuid>.jsonl` | JSONL                         | Cursor-generated session transcript copy for review and search                                                   |

The `store.db` contains two tables:

- `meta`: Session metadata (settings, model selection, etc.)
- `blobs`: Conversation content stored as content-hash-keyed blobs (message bodies, tool call parameters and results, etc.)

### 3.4 Proxy Startup/Restart Flow

<img src="technical-guide-en-mermaid/Untitled-7.png" alt="Proxy Startup/Restart Flow" width="489" />

<details>
<summary>View flowchart source</summary>

```mermaid
flowchart TD
    GWStart(["Gateway starts<br/>register called"])
    GWStart --> IsRunning{"isProxyRunning(port)?<br/>curl /v1/health"}

    IsRunning -->|"Not running"| NeedStart["needRestart = true"]
    IsRunning -->|"Running"| FetchHealth["GET /v1/health<br/>get scriptHash"]

    FetchHealth --> CompareHash{"SHA-256 comparison<br/>running vs installed"}
    CompareHash -->|"Hash matches<br/>code unchanged"| UpToDate["Log: up-to-date<br/>keep running"]
    CompareHash -->|"Hash differs<br/>code updated"| NeedStart

    NeedStart --> Kill["killPortProcess(port)<br/>lsof / netstat cross-platform"]
    Kill --> Wait["Atomics.wait 300ms<br/>zero CPU wait"]
    Wait --> Spawn["spawn node streaming-proxy.mjs<br/>inject CURSOR_PATH env vars"]
    Spawn --> Listen["proxy listening :18790<br/>ready"]

    Listen --> Running["Running"]
    Running --> ExitEvent{"proxyChild.on exit<br/>exit code?"}
    ExitEvent -->|"code=0 / null"| Done["Normal exit<br/>no restart"]
    ExitEvent -->|"code nonzero"| CheckUptime{"Uptime > 5min?"}
    CheckUptime -->|"Yes"| ResetCount["Reset restartCount=0"]
    CheckUptime -->|"No"| CheckCount
    ResetCount --> CheckCount{"restartCount >= 3?"}
    CheckCount -->|"Yes"| GiveUp["Give up restarting<br/>log: manual proxy restart"]
    CheckCount -->|"No"| AutoRestart["Exponential backoff restart<br/>2s / 10s / 60s"]
    AutoRestart --> Kill
```

</details>

---

## Chapter 4: Key Technical Decisions

### 4.1 scriptHash vs Version Number

| Approach                | Pros                                                  | Cons                                                                 |
| ----------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| package.json version    | Simple and direct                                     | Version unchanged in local directory installs even when code changes |
| **Script content hash** | Accurately detects changes across all install methods | Requires additional hash computation                                 |

The reason for choosing content hash (first 12 chars of SHA-256): the plugin supports three installation methods — npm, tgz package, and local directory. Local directory installation is the most common during development, but `package.json` version may not be updated after every change. Content hash ensures the proxy auto-restarts whenever script content changes.

### 4.2 Atomics.wait vs execSync("sleep")

```typescript
// Old approach: fork a child process just to wait
execSync("sleep 2"); // Unix only, fork overhead

// New approach: zero-overhead synchronous wait
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
```

`Atomics.wait` is available in Node.js >= 16, with advantages:

- Zero CPU overhead (kernel-level wait)
- No child process overhead
- Cross-platform (Windows/macOS/Linux)
- Precise millisecond-level control

### 4.3 Rich Tool Descriptions vs openclaw_skill Calls

**Problem**: In the early design, server instructions required the LLM to "call openclaw_skill before first use of any tool", adding one extra tool call per request (+3-5 seconds).

**Solution**: Three-layer Progressive Disclosure:

1. **Server instructions** (zero cost): `buildServerInstructions()` + `extractSkillBrief()` extracts key information from SKILL.md and embeds it in MCP server instructions, covering common operations' actions, URL patterns, and parameter examples
2. **Capability summary** (zero cost): `buildCapabilitySummary()` injects brief descriptions of all tools into `openclaw_invoke` / `openclaw_discover` descriptions, ensuring tools are discoverable even when dynamic tools aren't registered
3. **Full documentation** (on-demand): `openclaw_skill` provides complete SKILL.md (all actions, parameters, examples, caveats), called only for advanced operations

```
CAPABILITIES:
  - feishu_doc: Feishu document read/write. Token: From URL ... Actions: Read Document(`read`),
    Write Document(`write`), ... Params: pass `action` and remaining fields as `args_json` JSON string.
    Example: { "action": "read", "doc_token": "ABC123def" }. Note: Image display size is ...

USAGE:
  1. When a user mentions URLs or services matching the capabilities above, use the corresponding tool.
  2. Use the token extraction rules and action keys above to call tools directly for common read/write operations.
  3. Call openclaw_skill(tool_name) for advanced operations, complex parameters, or when unsure about usage.
  4. Call openclaw_discover for a refreshed list of all available tools.
```

Result: The LLM can directly call tools for common operations (read, write, append documents, etc.), only consulting full documentation for complex scenarios. Measured reduction of 1 tool call + 3-5 seconds of thinking time.

### 4.4 InstantResult

**Problem**: cursor-agent sometimes doesn't stream text deltas but returns a `result` event all at once. The old design used `streamChunked` at 200 chars/s to simulate streaming — 901 characters took ~4.5 seconds of pure latency.

**Solution**: Default `INSTANT_RESULT=true`, sending the complete result at once. `INSTANT_RESULT=false` is retained as a fallback (some clients may need progressive display).

### 4.5 CORS + Session Header

**Problem**: OpenClaw Gateway may pass session IDs through different methods (body fields or HTTP headers), and the proxy needs to be compatible with all methods.

**Solution**:

1. `resolveSessionKey()` extracts from 5 sources by priority (including message metadata auto-derive)
2. Logs record session source (e.g., `session=abc123(header.x-openclaw)` or `session=auto:dm:ou_xxx(meta.auto)`) for debugging
3. CORS allows custom headers: `X-OpenClaw-Session-Id`, `X-Session-Id`

### 4.6 Session Auto-Derive

**Problem**: Gateway's `openai-completions` provider doesn't pass session IDs in body or headers, causing `session=none(none)` on the proxy side. cursor-agent starts a fresh session for every request, completely losing multi-turn conversation context.

**Analysis**: While the Gateway doesn't pass explicit session IDs, it embeds structured "Conversation info (untrusted metadata)" JSON blocks in every user message, containing stable identifiers like `sender_id`, `group_channel`, `topic_id`.

| Approach                              | Pros                                                    | Cons                                   |
| ------------------------------------- | ------------------------------------------------------- | -------------------------------------- |
| Modify Gateway to pass session header | Protocol-standard; proxy doesn't need to parse messages | Requires Gateway changes, longer cycle |
| **Auto-derive from message metadata** | Zero Gateway changes, immediately effective             | Depends on Gateway's metadata format   |

The reason for choosing metadata derivation: no Gateway dependency (zero-intrusion), immediately effective, and the metadata format is stable. Derivation rules are simple and clear (group chats use `group_channel:topic_id`, DMs use `sender_id`), serving as the lowest-priority fallback in `resolveSessionKey()` without affecting any explicit session ID passing scenarios.

### 4.7 Request Security

**Request body size limit**: `readBody()` caps at 10 MB maximum, preventing malicious clients from sending oversized request bodies that exhaust memory.

**Client disconnect handling**: `handleStream` tracks client connection state via a `clientGone` flag. When `req.on("close")` fires, the flag is checked in `rl.on("close")` to skip writes to the already-closed response, avoiding write-after-close errors.

---

## Chapter 5: Module Design Details

### 5.1 Plugin Entry (index.ts)

`index.ts` is the OpenClaw Plugin SDK entry file, exporting a `plugin` object. The core is the `register()` method, called when the Gateway starts.

#### register() Lifecycle

<img src="technical-guide-en-mermaid/Untitled-8.png" alt="register Lifecycle" width="580" />

<details>
<summary>View flowchart source</summary>

```mermaid
flowchart TD
    Start(["register(api) called"])
    Start --> IsUninstall{"argv contains<br/>uninstall / upgrade?"}
    IsUninstall -->|"Yes"| SkipSetup["Skip setup and proxy"]

    IsUninstall -->|"No"| RunSetup["runSetup(ctx)<br/>Cursor detection / model discovery / MCP write"]
    RunSetup --> SyncProvider{"Provider config<br/>changed?"}
    SyncProvider -->|"JSON.stringify<br/>identical"| LogUnchanged["Log: unchanged<br/>skip write"]
    SyncProvider -->|"Different"| WriteConfig["writeConfigFile(patch)<br/>sync models + agents"]

    WriteConfig --> CheckProxy
    LogUnchanged --> CheckProxy
    CheckProxy{"Proxy<br/>running?"}
    CheckProxy -->|"Not running"| StartProxy["startProxy<br/>kill / wait / spawn"]
    CheckProxy -->|"Running"| HashCheck{"scriptHash<br/>matches?"}
    HashCheck -->|"SHA-256 match"| LogUpToDate["Log: up-to-date"]
    HashCheck -->|"Hash differs<br/>code updated"| StartProxy

    StartProxy --> RegisterCLI["Register CLI commands<br/>setup / doctor / status<br/>upgrade / uninstall / proxy"]
    LogUpToDate --> RegisterCLI
    SkipSetup --> RegisterCLI
```

</details>

#### Configuration Deduplication

The Gateway's plugin subsystem and gateway subsystem each call `register()` once, potentially triggering `writeConfigFile` twice. The solution is to compare old and new provider configs with `JSON.stringify` before writing:

```javascript
// index.ts — config deduplication logic
const newProviderConfig = buildProviderConfig(proxyPort, discovered);
const existingProvider = existingProviders[PROVIDER_ID];
const providerUnchanged =
  existingProvider &&
  JSON.stringify(existingProvider) === JSON.stringify(newProviderConfig);

if (providerUnchanged && providerExists) {
  api.logger.info(`Provider "${PROVIDER_ID}" unchanged ...`);
}
```

#### scriptHash Auto-Restart

After upgrading the plugin, the old proxy process is still running. Content hash detects code changes:

1. On startup, the proxy computes its script's first 12 chars of SHA-256, exposed in `/v1/health`'s `scriptHash` field
2. `register()` fetches the running proxy's `scriptHash` and compares with local file hash
3. If mismatched, kill + restart

```javascript
// index.ts — content hash computation
function computeFileHash(filePath: string): string {
  const content = readFileSync(filePath, "utf-8");
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}
```

#### CLI Command Tree

```
openclaw cursor-brain
├── setup              # MCP config + interactive model selection
├── doctor             # Health check (11 items)
├── status             # Version, config, models, tool count
├── upgrade <source>   # One-click upgrade (uninstall old → install new → model selection)
├── uninstall          # Full uninstall (4-step cleanup)
└── proxy
    ├── (default)       # Show proxy status
    ├── stop            # Stop proxy
    ├── restart         # Restart proxy (detached mode)
    └── log [-n N]      # Show last N log lines
```

### 5.2 Setup Module (src/setup.ts)

The Setup module handles all initialization and configuration, designed to be **idempotent** — repeated execution produces no side effects.

#### detectCursorPath()

Cross-platform cursor-agent binary detection, by priority:

1. User-configured `overridePath`
2. `which agent` / `where agent` (PATH lookup)
3. Platform-specific candidate path list (macOS: `~/.local/bin/agent`; Windows: `%LOCALAPPDATA%\Programs\cursor\...`)

#### discoverCursorModels()

Model discovery with retry: executes `cursor-agent --list-models`, parses output in `"model-id  -  Model Name (annotation)"` format, supports up to 2 retries. Each retry interval uses `Atomics.wait` for 2-second blocking wait — zero CPU overhead, no child processes, cross-platform compatible.

#### detectOutputFormat()

Probes whether cursor-agent supports the `stream-json` format:

1. If user explicitly configured `outputFormat`, use it directly
2. Otherwise execute `cursor-agent --help` and check if output contains `"stream-json"`
3. If supported, use `stream-json` (enables thinking events); otherwise fall back to `json`

#### configureMcpJson()

Idempotent write to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "openclaw-gateway": {
      "command": "node",
      "args": ["<pluginDir>/mcp-server/server.mjs"],
      "env": {
        "OPENCLAW_GATEWAY_URL": "http://127.0.0.1:<port>",
        "OPENCLAW_GATEWAY_TOKEN": "<token>"
      }
    }
  }
}
```

Before writing, `args` and `env` fields are compared; if identical, the write is skipped.

### 5.3 MCP Server (mcp-server/server.mjs)

The MCP Server is the most complex module, responsible for exposing all OpenClaw plugin tools as MCP tools for native Cursor IDE access.

#### Tool Discovery and Registration

<img src="technical-guide-en-mermaid/Untitled-9.png" alt="Tool Discovery and Registration" width="574" />

<details>
<summary>View flowchart source</summary>

```mermaid
flowchart TD
    subgraph p1 ["Phase 1: Candidate Tool Discovery (Disk IO, 60s cache)"]
        ReadConfig["Read openclaw.json<br/>Get plugin install paths"] --> ScanSkills["Scan SKILL.md<br/>tool name + full docs"]
        ReadConfig --> ScanSource["Scan src/*.ts<br/>name/description pattern matching"]
        ScanSkills --> Merge["Merge and deduplicate"]
        ScanSource --> Merge
    end

    subgraph p2 ["Phase 2: Immediate MCP Registration (Gateway-independent)"]
        direction LR
        DynTools["Dynamic tools (per-tool)<br/>feishu_doc / feishu_wiki / ...<br/>schema: action + args_json"]
        StaticTools["Built-in tools<br/>openclaw_invoke<br/>openclaw_discover<br/>openclaw_skill"]
    end

    subgraph p3 ["Background: Liveness Verification (non-blocking)"]
        Probe["Promise.allSettled<br/>parallel POST /tools/invoke<br/>each candidate / 5s timeout"]
        Probe --> LogResult["Log: verified / missing<br/>(diagnostic only)"]
    end

    Merge -->|"N candidate tools"| DynTools
    DynTools -.->|"async, non-blocking"| Probe
```

</details>

**Phase 1: `discoverCandidateTools()`**

Scans candidate tools from two sources (pure disk I/O, Gateway-independent):

- **SKILL.md files**: reads subdirectories under each plugin's `skills/` directory, converts directory names to tool names (e.g., `feishu-doc` → `feishu_doc`), reads complete SKILL.md content (including inlined `references/*.md`)
- **Source scanning** (fallback): parses `name: "tool_name"` and `description: "..."` patterns in `src/*.ts` files, extracting tool names and descriptions not covered by SKILL.md

**Phase 2: Immediate Registration**

All candidate tools are immediately registered to the MCP Server via `server.tool(name, description, schema, handler)`, without waiting for Gateway liveness probes. This avoids race conditions when MCP Server starts before Gateway. Each tool's schema is unified as `{ action?: string, args_json?: string }`. If a tool is called when Gateway isn't ready yet, `invokeGatewayTool`'s built-in retry logic (2 retries + backoff) handles it gracefully.

**Background: `discoverVerifiedTools()`**

After registration, a non-blocking background probe verifies which tools are actually available on the Gateway. This is for diagnostic logging only — missing tools are logged as warnings but remain registered (they'll work once Gateway is ready).

#### Cache Layer

```javascript
let _candidateCache = null;
let _candidateCacheAt = 0;
const CANDIDATE_TTL_MS = 60_000;

function getCachedCandidateTools(forceRefresh = false) {
  if (
    !forceRefresh &&
    _candidateCache &&
    Date.now() - _candidateCacheAt < CANDIDATE_TTL_MS
  ) {
    return _candidateCache;
  }
  _candidateCache = discoverCandidateTools();
  _candidateCacheAt = now;
  return _candidateCache;
}
```

During startup, `discoverCandidateTools()` is called from multiple places (`buildServerInstructions`, main scope, `getSkillsByTool`); caching avoids redundant disk I/O. `openclaw_discover` passes `forceRefresh=true` to force a refresh.

#### Server Instructions Builder

`buildServerInstructions()` generates MCP server instructions embedded in `McpServer`'s `instructions` field. These instructions appear in Cursor's system prompt, guiding the LLM on how to use tools.

`extractSkillBrief()` extracts key information from SKILL.md:

| Extracted Item         | Source                               | Purpose                                             |
| ---------------------- | ------------------------------------ | --------------------------------------------------- |
| Token extraction rules | `## Token Extraction` section        | LLM knows how to extract parameters from URLs       |
| Action mapping         | `"action"` field in JSON code blocks | LLM uses exact action strings directly              |
| URL patterns           | Regex matching `*.cn/path/`          | LLM identifies which URLs correspond to which tools |
| Parameter format       | First JSON example                   | LLM knows the parameter format                      |
| Dependency hints       | `**Dependency:**` / `**Note:**`      | LLM knows inter-tool dependencies                   |

With this information embedded in server instructions, the LLM can call tools directly without first calling `openclaw_skill` for documentation, saving one tool call.

#### Capability Summary Injection

**Problem**: When Gateway starts slowly or is unavailable, dynamic tools can't register, leaving MCP Server with only 3 static tools (`openclaw_invoke`, `openclaw_discover`, `openclaw_skill`). Their descriptions don't mention any specific capabilities (like Feishu documents), so the LLM won't think to use MCP when encountering a Feishu URL.

**Solution**: `buildCapabilitySummary()` generates a capability brief from candidate tool metadata, appended to `openclaw_invoke` and `openclaw_discover` descriptions:

```
openclaw_invoke: "Call any OpenClaw Gateway tool by name...
  Available: feishu_doc: Feishu document read/write operations.
  Activate when user mentions Feishu docs, cloud docs, or docx links.;
  feishu_wiki: ...; feishu_drive: ..."
```

Since candidate tools come from disk scanning (Phase 1) and don't depend on Gateway, the LLM can discover available capabilities from static tool descriptions even when Gateway is unavailable.

#### Lazy-Loaded Skill Cache

`getSkillsByTool()` provides Gateway-independent skill content access. On first call, it extracts all tools with skills from `discoverCandidateTools()` and caches them in memory. `openclaw_skill` uses this function to fetch documentation on demand, independent of startup-time Gateway probe results.

#### Tool System

| Tool                         | Purpose                                          | Schema                                               |
| ---------------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| **Dynamic tools** (per-tool) | Directly call tools on Gateway                   | `{ action?, args_json? }`                            |
| **openclaw_invoke**          | Generic caller for tools not directly registered | `{ tool, action?, args_json? }`                      |
| **openclaw_discover**        | List all available tools, identify new ones      | `{}`                                                 |
| **openclaw_skill**           | Get complete usage documentation for tools       | `{ tool }` (supports comma-separated multiple tools) |

#### Gateway REST Calls

`invokeGatewayTool()` implements REST calls with retry:

- Timeout: 60 seconds default (`OPENCLAW_TOOL_TIMEOUT_MS`)
- Retry conditions: `AbortError` (timeout), `ECONNREFUSED`, `ECONNRESET`
- Max 2 retries (`OPENCLAW_TOOL_RETRY_COUNT`), 1-second interval

### 5.4 Streaming Proxy (mcp-server/streaming-proxy.mjs)

The Streaming Proxy is an OpenAI-compatible HTTP server that wraps cursor-agent CLI as a standard API.

#### API Endpoints

| Endpoint               | Method | Function                                                                                                 |
| ---------------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| `/v1/chat/completions` | POST   | Chat completions (supports stream/non-stream)                                                            |
| `/v1/models`           | GET    | List available models                                                                                    |
| `/v1/health`           | GET    | Health check (includes `scriptHash`, `sessions`, `consecutiveFailures`, `lastErrorTime`, `lastErrorMsg`) |

#### cursor-agent Process Management

```javascript
// streaming-proxy.mjs — core process management
function spawnCursorAgent(
  userMsg,
  sessionKey,
  requestModel,
  { skipSession = false } = {},
) {
  const cursorSessionId =
    !skipSession && sessionKey ? sessions.get(sessionKey) : null;
  const args = [
    "-p",
    "--output-format",
    OUTPUT_FORMAT,
    "--stream-partial-output",
    "--trust",
    "--approve-mcps",
    "--force",
  ];
  const model = CURSOR_MODEL || mapRequestModel(requestModel);
  if (model) args.push("--model", model);
  if (cursorSessionId) args.push("--resume", cursorSessionId);

  const child = spawn(CURSOR_PATH, args, {
    cwd: WORKSPACE_DIR || undefined,
    env: {
      ...process.env,
      ...(process.platform !== "win32" && {
        SHELL: process.env.SHELL || "/bin/bash",
      }),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.write(userMsg);
  child.stdin.end();
  child._usedSession = !!cursorSessionId;
  return child;
}
```

Key parameters:

- `-p`: Non-interactive mode (pipe mode)
- `--stream-partial-output`: Enable incremental output
- `--trust --approve-mcps --force`: Auto-trust MCP tool calls
- `--resume`: Reuse existing session
- `CURSOR_MODEL || mapRequestModel(requestModel)`: Global model takes priority, otherwise mapped from request parameter
- `skipSession`: Skip `--resume` on retry, avoiding persistent empty responses from stale sessions

#### Three-Layer Fault Tolerance

**Request level: Session-aware retry**

When cursor-agent returns an empty result with a `--resume` session, the session is automatically cleared and retried with `skipSession=true`. Retry is only possible before content has been written to the client, avoiding duplicate output. Empty results from timeouts don't trigger retry.

**Process level: Consecutive failure self-healing**

The Proxy tracks consecutive failures (`consecutiveFailures`). Reset to 0 on each successful request, incremented on failure. When the threshold is reached (default 5, configurable via `CURSOR_PROXY_MAX_CONSECUTIVE_FAILURES`), `process.exit(2)` triggers self-exit for gateway-level restart. `/v1/health` exposes `consecutiveFailures`, `lastErrorTime`, `lastErrorMsg` for diagnostics.

**Gateway level: Crash auto-restart**

`proxyChild.on("exit")` in `index.ts` implements exponential backoff restart for abnormal exits:

| Exit Code                    | Behavior                                                     |
| ---------------------------- | ------------------------------------------------------------ |
| `0` / `null`                 | Normal exit (SIGTERM), no restart                            |
| `2`                          | Self-healing exit (consecutive failures), restart after 2s   |
| Other                        | Abnormal crash, exponential backoff restart (2s → 10s → 60s) |
| ≥3 consecutive crashes       | Give up restarting, log suggests manual `proxy restart`      |
| Crash after >5min stable run | Reset counter, treated as new round                          |

#### Event Stream Processing

cursor-agent outputs JSON lines via stdout, one event per line:

<img src="technical-guide-en-mermaid/Untitled-10.png" alt="Event Stream Processing" width="1321" />

<details>
<summary>View flowchart source</summary>

```mermaid
flowchart TD
    Input["cursor-agent<br/>stdout JSON lines"]
    Parse["JSON.parse line by line"]
    Switch{"event.type?"}

    ToolBranch{"subtype?"}
    ToolStart["tool:start log<br/>record name / args / call_id<br/>start timer"]
    ToolDone["tool:done log<br/>elapsed / success / failure"]

    ThinkBranch{"FORWARD_THINKING?"}
    ForwardThink["SSE: reasoning_content"]
    DropThink["Drop"]

    TextDelta["SSE: content delta<br/>(real-time push)"]

    ResultBranch{"INSTANT_RESULT?"}
    InstantSend["Send all at once<br/>zero latency"]
    ChunkedSend["Chunked streaming<br/>~200 chars/s"]

    SaveSession["setSession<br/>persist to disk"]

    Input --> Parse --> Switch

    Switch -->|"tool_call"| ToolBranch
    ToolBranch -->|"started"| ToolStart
    ToolBranch -->|"completed"| ToolDone

    Switch -->|"thinking"| ThinkBranch
    ThinkBranch -->|"true"| ForwardThink
    ThinkBranch -->|"false"| DropThink

    Switch -->|"text"| TextDelta

    Switch -->|"result"| ResultBranch
    ResultBranch -->|"true"| InstantSend
    ResultBranch -->|"false"| ChunkedSend

    Switch -->|"has session_id"| SaveSession
```

</details>

#### Streaming vs Non-Streaming

| Feature          | Streaming (handleStream)           | Non-Streaming (handleNonStream)      |
| ---------------- | ---------------------------------- | ------------------------------------ |
| Event processing | Real-time line-by-line             | Buffered batch processing            |
| Response format  | SSE (text/event-stream)            | JSON (application/json)              |
| tool_call timing | Precise (real-time timestamp)      | No elapsed tracking (post-processed) |
| Result output    | Incremental delta / instant result | All-at-once return                   |

#### Session Management

**Process model**: For each incoming request, the Proxy spawns a new cursor-agent child process. After processing, the child process exits. There are no persistent cursor-agent processes globally — they only exist temporarily while handling requests. Concurrent requests produce multiple simultaneously running child processes.

**Auto-derive mechanism** (`extractSessionFromMeta()`):

OpenClaw Gateway embeds "Conversation info (untrusted metadata)" JSON blocks in every user message, containing stable identifiers like `sender_id`, `group_channel`, `topic_id`, `is_group_chat`. The Proxy extracts this JSON from the last user message via regex and constructs a session key:

- Group chat: `auto:grp:{group_channel}:{topic_id || "main"}`
- Direct message: `auto:dm:{sender_id}`

Log example: `session=auto:dm:ou_f7bdc8b28fc7cc4905d6143c76bde5d0(meta.auto)`

This mechanism solves the problem of Gateway's `openai-completions` provider not passing explicit session IDs, enabling automatic multi-turn conversation context preservation.

#### InstantResult Mode

When cursor-agent returns a `result` event (rather than streaming `text`):

- `INSTANT_RESULT=true` (default): Send complete result at once, zero latency
- `INSTANT_RESULT=false`: Simulate streaming output at 200 chars/s chunked

### 5.5 Health Check (src/doctor.ts)

`runDoctorChecks()` implements 11 checks:

| #   | Check Item             | Implementation                                 |
| --- | ---------------------- | ---------------------------------------------- |
| 1   | Plugin version         | Read `package.json`                            |
| 2   | Cursor Agent CLI       | `detectCursorPath()`                           |
| 3   | Cursor Agent version   | `cursor-agent --version`                       |
| 4   | MCP server file        | `existsSync()`                                 |
| 5   | MCP SDK dependency     | Check `node_modules/@modelcontextprotocol/sdk` |
| 6   | Cursor mcp.json        | Parse JSON, check `openclaw-gateway` entry     |
| 7   | OpenClaw config        | `existsSync(OPENCLAW_CONFIG_PATH)`             |
| 8   | Streaming provider     | Check `cursor-local` provider config           |
| 9   | Output format          | `detectOutputFormat()`                         |
| 10  | Discovered tools count | `countDiscoveredTools()` source scanning       |
| 11  | Gateway connectivity   | curl / node fetch probing REST API             |

Gateway connectivity check uses a dual-platform approach: Unix uses `curl` (most efficient), Windows falls back to `node -e "fetch(...)"`.

### 5.6 Cleanup Module (src/cleanup.ts)

`runCleanup()` performs three-layer cleanup:

| Layer                 | Operation                                                    | File                        |
| --------------------- | ------------------------------------------------------------ | --------------------------- |
| MCP config            | Delete `mcpServers.openclaw-gateway` entry                   | `~/.cursor/mcp.json`        |
| Provider registration | Delete `models.providers.cursor-local`                       | `~/.openclaw/openclaw.json` |
| Model references      | Clear `cursor-local/*` references in `agents.defaults.model` | `~/.openclaw/openclaw.json` |

Each layer executes independently; failure in one doesn't affect others. All operations are file-level JSON read/write, with no external command dependencies.

---

## Chapter 6: Installation & Configuration

### 6.1 Installation Methods

```bash
# Method 1: npm install (recommended)
openclaw plugins install openclaw-cursor-brain

# Method 2: Local directory install (for development)
openclaw plugins install /path/to/openclaw-cursor-brain

# Method 3: tgz package install
openclaw plugins install openclaw-cursor-brain-1.2.0.tgz
```

After installation, restart the Gateway and verify:

```bash
openclaw gateway restart         # Apply changes
openclaw cursor-brain doctor     # Verify
```

To re-run interactive model selection at any time:

```bash
openclaw cursor-brain setup     # MCP config + model selection
```

### 6.2 Auto-Configured Files

| File                               | Write Timing           | Content                           |
| ---------------------------------- | ---------------------- | --------------------------------- |
| `~/.cursor/mcp.json`               | `setup` / `register()` | MCP Server startup config         |
| `~/.openclaw/openclaw.json`        | `setup` / `register()` | Provider config + model selection |
| `~/.openclaw/cursor-sessions.json` | Proxy runtime          | Session persistence               |
| `~/.openclaw/cursor-proxy.log`     | Proxy runtime          | Proxy logs                        |

### 6.3 Complete Environment Variable Reference

#### MCP Server Environment Variables

| Variable                    | Default                     | Description                      |
| --------------------------- | --------------------------- | -------------------------------- |
| `OPENCLAW_GATEWAY_URL`      | `http://127.0.0.1:18789`    | Gateway REST API address         |
| `OPENCLAW_GATEWAY_TOKEN`    | `""`                        | Gateway auth token               |
| `OPENCLAW_CONFIG_PATH`      | `~/.openclaw/openclaw.json` | OpenClaw config file path        |
| `OPENCLAW_TOOL_TIMEOUT_MS`  | `60000`                     | Tool call timeout (ms)           |
| `OPENCLAW_TOOL_RETRY_COUNT` | `2`                         | Max retries for transient errors |

#### Streaming Proxy Environment Variables

| Variable                                | Default       | Description                                                    |
| --------------------------------------- | ------------- | -------------------------------------------------------------- |
| `CURSOR_PATH`                           | Auto-detected | cursor-agent binary path                                       |
| `CURSOR_PROXY_PORT`                     | `18790`       | Proxy listen port                                              |
| `CURSOR_WORKSPACE_DIR`                  | `""`          | cursor-agent working directory                                 |
| `CURSOR_PROXY_API_KEY`                  | `""`          | API Key auth (empty = no auth)                                 |
| `CURSOR_OUTPUT_FORMAT`                  | `stream-json` | cursor-agent output format                                     |
| `CURSOR_MODEL`                          | `""`          | Model override                                                 |
| `CURSOR_PROXY_FORWARD_THINKING`         | `false`       | Forward LLM reasoning as `reasoning_content`                   |
| `CURSOR_PROXY_INSTANT_RESULT`           | `true`        | Send batch results all at once (no chunking)                   |
| `CURSOR_PROXY_STREAM_SPEED`             | `200`         | Chunk speed (chars/s, only when INSTANT_RESULT=false)          |
| `CURSOR_PROXY_REQUEST_TIMEOUT`          | `300000`      | Per-request timeout (5 minutes)                                |
| `CURSOR_PROXY_MAX_CONSECUTIVE_FAILURES` | `5`           | Consecutive failure limit, proxy self-exits to trigger restart |

### 6.4 Plugin Configuration Schema

Under `openclaw.json`'s `plugins.entries.openclaw-cursor-brain.config`:

| Field           | Type                        | Default               | Description                                |
| --------------- | --------------------------- | --------------------- | ------------------------------------------ |
| `cursorPath`    | string                      | Auto-detected         | cursor-agent binary path                   |
| `model`         | string                      | Interactive selection | Primary model (skips interaction when set) |
| `fallbackModel` | string                      | Interactive selection | Fallback model override                    |
| `cursorModel`   | string                      | `""`                  | Passed directly to `--model` parameter     |
| `outputFormat`  | `"stream-json"` \| `"json"` | Auto-detected         | cursor-agent output format                 |
| `proxyPort`     | number                      | `18790`               | Proxy listen port                          |

---

## Chapter 7: Usage Guide

### 7.1 CLI Command Details

#### setup — Initialize Configuration

```bash
openclaw cursor-brain setup
```

Execution flow: Configure MCP Server → Detect models → Interactive primary model selection (single-select) → Interactive fallback model selection (multi-select) → Save configuration.

#### doctor — Health Check

```bash
openclaw cursor-brain doctor
```

Example output:

```
Cursor Brain Doctor

  ✓ Plugin version: v1.2.0
  ✓ Cursor Agent CLI: /Users/me/.local/bin/agent
  ✓ Cursor Agent version: 0.50.5
  ✓ MCP server file: /Users/me/.openclaw/extensions/.../server.mjs
  ✓ MCP SDK dependency: installed
  ✓ Cursor mcp.json: Server "openclaw-gateway" configured
  ✓ OpenClaw config: /Users/me/.openclaw/openclaw.json
  ✓ Streaming provider: "cursor-local" configured
  ✓ Output format (detected): "stream-json" (streaming + thinking)
  ✓ Discovered tool candidates: 7 tools found in plugin sources
  ✓ Gateway REST API: http://127.0.0.1:18789 (HTTP 404)

11/11 checks passed
```

#### status — Status Overview

```bash
openclaw cursor-brain status
```

Displays plugin version, platform, Cursor path/version, output format, proxy status, provider config, model selection, Gateway address, tool count.

#### upgrade — One-Click Upgrade

```bash
openclaw cursor-brain upgrade ./                    # From local directory
openclaw cursor-brain upgrade openclaw-cursor-brain  # From npm
```

Flow: Uninstall old → Clean config → Install new → Discover models → Interactive selection → Save config.

#### proxy Subcommands

```bash
openclaw cursor-brain proxy              # Status
openclaw cursor-brain proxy stop         # Stop
openclaw cursor-brain proxy restart      # Restart
openclaw cursor-brain proxy log          # Last 30 log lines
openclaw cursor-brain proxy log -n 100   # Last 100 log lines
```

### 7.2 Standalone Proxy Mode

The Streaming Proxy can run independently of OpenClaw, turning any Cursor into an OpenAI-compatible API:

```bash
# Start
node mcp-server/streaming-proxy.mjs

# Start with configuration
CURSOR_PROXY_PORT=8080 \
CURSOR_PROXY_API_KEY=my-secret \
CURSOR_MODEL=claude-sonnet \
node mcp-server/streaming-proxy.mjs

# Call
curl http://127.0.0.1:18790/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### 7.3 Troubleshooting

| Problem                         | Diagnosis                               | Solution                                                    |
| ------------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| Cursor Agent CLI not found      | `openclaw cursor-brain doctor`          | Install Cursor and launch it once, or set `cursorPath`      |
| Gateway unreachable             | `openclaw gateway status`               | Confirm Gateway is running, check token                     |
| Tools not appearing             | `openclaw cursor-brain status`          | Restart Gateway, call `openclaw_discover` in Cursor         |
| Tool call timeout               | Check proxy log                         | Set `OPENCLAW_TOOL_TIMEOUT_MS=120000`                       |
| Proxy not started               | `openclaw cursor-brain proxy log`       | `proxy restart` to force start                              |
| Proxy not updated after upgrade | `curl http://127.0.0.1:18790/v1/health` | Check `scriptHash`; `gateway restart` triggers auto-restart |
| Batch response latency          | Check proxy startup log                 | Confirm `InstantResult: true`                               |
| Debug tool calls                | `~/.openclaw/cursor-proxy.log`          | Search for `tool:start` / `tool:done`                       |

---

## Chapter 8: Development & Contributing

### 8.1 Local Development Flow

```bash
# 1. Clone repository
git clone https://github.com/andeya/openclaw-cursor-brain.git
cd openclaw-cursor-brain
npm install

# 2. Install as local plugin
openclaw plugins install ./
openclaw gateway restart

# 3. Sync after code changes
openclaw cursor-brain upgrade ./
openclaw gateway restart

# 4. Verify
openclaw cursor-brain doctor
openclaw cursor-brain status
```

### 8.2 Module Extension Guide

#### Adding New MCP Tools

Add new `server.tool()` calls in `server.mjs`. No other files need modification — the tool discovery mechanism automatically handles new plugin tools from the Gateway.

#### Extending Proxy Functionality

Add environment variable → Read in config section → Use in handler. Follow existing patterns (e.g., `FORWARD_THINKING`, `INSTANT_RESULT`).

#### Adding New Health Checks

Append new check items to `runDoctorChecks()` in `doctor.ts`:

```typescript
checks.push({
  ok: /* check logic */,
  label: "Check name",
  detail: "Detailed info",
});
```

### 8.3 Design Principles

| Principle                   | Meaning                                             | Practice                                                           |
| --------------------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| **Zero Config**             | Works out of the box, no manual config file editing | `register()` auto-detects, auto-writes config                      |
| **Idempotent**              | Repeated execution produces no side effects         | Setup compares before write, cleanup layers independently          |
| **Cross-Platform**          | Supports macOS, Linux, Windows                      | `process.platform` branching, path.join, dual-platform commands    |
| **Dynamic Discovery**       | No hardcoded tool names                             | Source scanning + REST probe, new plugins auto-register            |
| **Progressive Enhancement** | Core features first, advanced features optional     | FORWARD_THINKING default off, INSTANT_RESULT default on            |
| **Observable**              | Sufficient logging and diagnostic capability        | tool:start/done logging, doctor checks, session source annotations |

---

## Appendix: Constants & Identifiers Quick Reference

| Identifier                 | Value                     | Purpose                                             |
| -------------------------- | ------------------------- | --------------------------------------------------- |
| `PLUGIN_ID`                | `"openclaw-cursor-brain"` | Plugin unique ID                                    |
| `MCP_SERVER_ID`            | `"openclaw-gateway"`      | MCP server name (written to mcp.json)               |
| `PROVIDER_ID`              | `"cursor-local"`          | LLM Provider name (written to openclaw.json)        |
| `DEFAULT_PROXY_PORT`       | `18790`                   | Streaming Proxy default port                        |
| `CANDIDATE_TTL_MS`         | `60000`                   | Tool cache TTL (60 seconds)                         |
| `MAX_SESSIONS`             | `100`                     | Max session persistence count                       |
| `MAX_CONSECUTIVE_FAILURES` | `5`                       | Proxy consecutive failure self-exit threshold       |
| `MAX_PROXY_RESTARTS`       | `3`                       | Gateway-level max auto-restart count                |
| `PROXY_RESTART_DELAYS`     | `[2s, 10s, 60s]`          | Gateway-level restart exponential backoff delays    |
| `PROXY_STABLE_PERIOD`      | `300000` (5min)           | Stable running duration, resets restart count after |
| `TOOL_TIMEOUT_MS`          | `60000`                   | Tool call timeout (60 seconds)                      |
| `TOOL_RETRY_COUNT`         | `2`                       | Tool call max retry count                           |
| `TOOL_RETRY_DELAY_MS`      | `1000`                    | Retry interval (1 second)                           |

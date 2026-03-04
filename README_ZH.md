# openclaw-cursor-brain

[![npm version](https://img.shields.io/npm/v/openclaw-cursor-brain.svg)](https://www.npmjs.com/package/openclaw-cursor-brain)
[![npm downloads](https://img.shields.io/npm/dm/openclaw-cursor-brain.svg)](https://www.npmjs.com/package/openclaw-cursor-brain)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-orange.svg)](https://github.com/openclaw/openclaw)
[![Cursor](https://img.shields.io/badge/Cursor-Agent%20CLI-purple.svg)](https://cursor.sh)
[![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

[English](./README.md) | 中文

将 [Cursor Agent CLI](https://cursor.sh) 作为 [OpenClaw](https://github.com/openclaw/openclaw) 的 AI 大脑，通过 [MCP (Model Context Protocol)](https://modelcontextprotocol.io) 桥接 OpenClaw Gateway 中注册的所有插件工具，使 Cursor Agent 能直接调用飞书、Slack、GitHub 等第三方插件能力。

**零配置**——安装、重启，完事。

## 工作原理

```
用户消息 → OpenClaw Gateway → cursor-cli (CLI Backend)
                                    ↓
                              Cursor Agent
                                    ↓
                          MCP Server (本插件提供)
                                    ↓
                        Gateway REST API (/tools/invoke)
                                    ↓
                          OpenClaw 插件工具 (飞书、Slack 等)
```

1. **安装时**：插件自动配置 `~/.cursor/mcp.json` 和 `openclaw.json` 中的 CLI 后端
2. **每次对话时**：cursor-cli 启动后自动加载 MCP Server 进程
3. **MCP Server 启动时**：读取 `openclaw.json`（JSON 解析），扫描已安装插件的源码提取工具名，通过 REST API 探测验证可用性
4. **工具调用时**：Cursor Agent 通过 MCP 协议调用工具，MCP Server 转发到 Gateway REST API

新安装的 OpenClaw 插件会被自动发现，无需额外配置。

## 安装

**前置条件**：

- Node.js >= 18
- [Cursor CLI](https://cursor.sh) 已安装（`agent` 命令可用）
- OpenClaw Gateway 已运行

```bash
# 从本地路径安装（开发调试）
openclaw plugins install /path/to/openclaw-cursor-brain

# 从 .tgz 压缩包安装（团队分发）
openclaw plugins install ./openclaw-cursor-brain-1.0.0.tgz

# 从 npm 安装
openclaw plugins install openclaw-cursor-brain

# 重启 gateway 加载插件
openclaw gateway restart
```

### 打包为 .tgz

在插件源码目录下执行：

```bash
cd /path/to/openclaw-cursor-brain
npm pack
# 生成 openclaw-cursor-brain-<version>.tgz（约 12KB）
```

将 `.tgz` 文件发送给团队成员，对方执行 `openclaw plugins install xxx.tgz` 即可安装，依赖会自动安装。

安装完成后，插件在 gateway 启动时自动执行以下操作（幂等，可重复执行）：

1. 探测 Cursor Agent CLI 路径（`which agent` → 常见路径扫描）
2. 写入 `~/.cursor/mcp.json`（合并，不覆盖其他 MCP server）
3. 若 `openclaw.json` 中无 `cursor-cli` 后端，自动写入完整配置

## 验证安装

```bash
# 健康检查（检测 Cursor CLI、MCP 配置、依赖、Gateway 连通性）
openclaw cursor-brain doctor

# 查看当前配置状态
openclaw cursor-brain status
```

## 配置选项

在 `openclaw.json` 中 `plugins.entries.cursor-brain.config` 下可配置：

| 参数            | 类型   | 默认值         | 说明                                                                   |
| --------------- | ------ | -------------- | ---------------------------------------------------------------------- |
| `cursorPath`    | string | 自动探测       | Cursor Agent CLI 二进制路径，留空则按 `which agent` → 常见路径自动探测 |
| `model`         | string | `"auto"`       | 主模型，写入 `agents.defaults.model.primary` 为 `cursor-cli/<model>`   |
| `fallbackModel` | string | `"sonnet-4.6"` | 备用模型，写入 `agents.defaults.model.fallbacks`                       |

示例：

```json
{
  "plugins": {
    "entries": {
      "cursor-brain": {
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

插件在每次 gateway 启动时自动执行幂等配置（已配好的不重复写入），无需手动干预。

## CLI 命令

| 命令                                      | 说明                                        |
| ----------------------------------------- | ------------------------------------------- |
| `openclaw cursor-brain setup`            | 手动重新执行配置（写入 mcp.json、CLI 后端） |
| `openclaw cursor-brain doctor`           | 检查所有组件健康状态                        |
| `openclaw cursor-brain status`           | 显示当前配置详情                            |
| `openclaw cursor-brain upgrade <source>` | 一键升级（清理 → 卸载 → 安装新版本）        |
| `openclaw cursor-brain uninstall`        | 一键完整卸载（清理配置 + 删除插件文件）     |

## 升级

一条命令完成升级，`<source>` 为新版本的路径、.tgz 包或 npm 包名：

```bash
openclaw cursor-brain upgrade ./openclaw-cursor-brain-2.0.0.tgz
openclaw gateway restart
```

`upgrade` 自动执行四步：配置清理 → 删除旧插件 → 安装新版本 → 提示重启。

## 卸载

一条命令完成卸载（清理配置 + 删除插件文件）：

```bash
openclaw cursor-brain uninstall
openclaw gateway restart
```

自动执行四步：

1. 移除插件配置注册（`openclaw plugins uninstall` 自动确认）
2. 删除插件目录 `~/.openclaw/extensions/cursor-brain`
3. 清理自定义配置（见下表）
4. 提示重启 gateway

清理的配置项：

| 位置                                          | 清理内容                                |
| --------------------------------------------- | --------------------------------------- |
| `~/.cursor/mcp.json`                          | 移除 `openclaw-gateway` MCP server 条目 |
| `openclaw.json` `agents.defaults.cliBackends` | 移除 `cursor-cli` 后端配置              |
| `openclaw.json` `agents.defaults.model`       | 移除 `cursor-cli/*` 模型引用            |
| `openclaw.json` `plugins.entries`             | 移除 `cursor-brain` 注册               |

> **注意**：不要直接执行 `openclaw plugins uninstall cursor-brain`，它只移除配置条目，不会清理上表中的自定义配置。
> 如果误操作，需手动编辑 `~/.cursor/mcp.json` 和 `~/.openclaw/openclaw.json` 移除相关条目。

## 自动配置写入的内容

### ~/.cursor/mcp.json

```json
{
  "mcpServers": {
    "openclaw-gateway": {
      "command": "node",
      "args": ["<插件安装路径>/mcp-server/server.mjs"],
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

## 跨平台支持

| 平台    | Cursor 路径探测                                | Shell       | mcp.json 位置                    |
| ------- | ---------------------------------------------- | ----------- | -------------------------------- |
| macOS   | `~/.local/bin/agent`, `/usr/local/bin/agent`   | `/bin/bash` | `~/.cursor/mcp.json`             |
| Linux   | 同上                                           | `/bin/bash` | `~/.cursor/mcp.json`             |
| Windows | `%LOCALAPPDATA%\Programs\cursor\...\agent.exe` | `cmd.exe`   | `%USERPROFILE%\.cursor\mcp.json` |

## MCP Server 提供的工具

MCP Server 在启动时自动发现并注册所有 OpenClaw 插件工具，此外始终提供两个内置工具：

| 工具                | 说明                                  |
| ------------------- | ------------------------------------- |
| `openclaw_invoke`   | 通用调用：按名称调用任意 Gateway 工具 |
| `openclaw_discover` | 发现：列出所有可用工具及状态          |

工具发现机制（无正则、无日志解析）：

1. 读取 `openclaw.json`（JSON 解析）获取已安装插件路径
2. 扫描每个插件 `src/*.ts` 中的 `name: "tool_name"` 声明
3. 通过 Gateway REST API 逐个探测验证可用性
4. 仅注册已验证的工具

## 故障排查

**doctor 报告 "Cursor Agent CLI not found"**

- 确认已安装 Cursor 并运行过一次（生成 `agent` 二进制）
- 或在配置中指定路径：`config.cursorPath = "/path/to/agent"`

**工具调用返回 "Gateway error"**

- 确认 gateway 正在运行：`openclaw gateway status`
- 检查 token 是否匹配：比较 `~/.cursor/mcp.json` 和 `openclaw.json` 中的 token

**新安装的插件工具未出现**

- 重启 gateway 以触发工具注册
- 调用 `openclaw_discover` 查看实时可用工具
- 使用 `openclaw_invoke` 直接按名称调用

## 目录结构

```
cursor-brain/
  package.json              # 依赖声明
  openclaw.plugin.json      # OpenClaw 插件清单
  index.ts                  # 插件入口（register + CLI 命令）
  README.md                 # 本文件
  src/
    constants.ts            # 跨平台路径常量
    setup.ts                # 幂等安装逻辑
    doctor.ts               # 健康检查
    cleanup.ts              # 卸载清理逻辑
  mcp-server/
    server.mjs              # MCP bridge（JSON 解析 + REST 探测）
  skills/
    cursor-brain/
      SKILL.md              # Agent 技能描述
```

## 贡献

参见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

[MIT](./LICENSE)

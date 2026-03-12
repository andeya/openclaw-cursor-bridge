# 安装 / 卸载 / 升级流程说明

本文档梳理 OpenClaw Cursor Brain 插件在安装、卸载、升级时的执行顺序与注意点，便于排查问题和扩展逻辑。

## 1. 安装 (install)

### 1.1 用户命令

- `openclaw plugins install openclaw-cursor-brain`（npm）
- `openclaw plugins install ./` 或 `openclaw plugins install /path/to/repo`（本地路径）
- `openclaw plugins install ./plugin.tgz`（归档）

### 1.2 执行顺序（从 OpenClaw 到插件）

1. **OpenClaw 核心**
   - 解析 source（npm / 路径 / 归档），将插件解压或复制到 `~/.openclaw/extensions/openclaw-cursor-brain`。
   - 可能在此之前或之后向 `openclaw.json` 写入 `plugins.installs[openclaw-cursor-brain]`（不同版本行为可能不同；部分版本会写入 `source: "tarball"`，与 OpenClaw 校验允许的 `npm | archive | path` 不一致）。

2. **加载插件并调用 `register(api)`**
   - `pluginDir` 通过 `resolvePluginDir(api)` 得到：优先 `api.config.plugins.installs[PLUGIN_ID].installPath`，否则约定路径 `~/.openclaw/extensions/openclaw-cursor-brain`，再否则 `api.resolvePath(".")`。
   - 判定：
     - `isPluginsInstall` = argv 含 `plugins` 且 `install` → 本次是「插件安装」流程，不启动 proxy/健康检查，保证进程能退出。
     - `isUninstalling` = argv 含 `cursor-brain` 且含 `uninstall` 或 `upgrade` → 仅在我们自己的 `cursor-brain uninstall/upgrade` 时为 true，不跑安装期配置；**不**把 `openclaw plugins upgrade` 当成 uninstall，以便升级时仍跑 register 内的配置逻辑。

3. **插件 register() 内逻辑（非 isUninstalling 时）**
   - **开头立即修 source**  
     读 `openclaw.json`，若已存在 `plugins.installs[openclaw-cursor-brain]` 且 `source` 不在 `["npm","archive","path"]`，则改为合法值（如 `tarball`→`archive`，其它→`path`），并写回磁盘，避免核心随后校验失败并覆盖配置。
   - **runSetup(ctx)**
     - 探测 Cursor Agent、输出格式、模型列表，写 MCP 配置等。
   - **若 result.cursorPath 存在**
     - 构建 provider 配置；若与现有一致且 provider 已存在，则只 `doSyncInstallRecord()`、补默认模型、可选跑交互 setup。
     - 否则从磁盘读 `freshConfig`，用 `patch` 合并 models/agents，**在 patch 里把本插件的 install 记录的 source 规范为合法值**，然后：
       - **若是 isPluginsInstall**：同步 `writeFileSync` 写 `openclaw.json`，再 `doSyncInstallRecord()`（确保 install 记录里始终有合法 `source`），可选 `runInteractiveSetupAfterInstall()`，最后 `setImmediate(() => fixInstallRecordSourceOnDisk(pluginDir))`，在下一事件循环再修一次磁盘上的 install 记录（防止核心在 register 返回后又写回非法 source）。
       - **否则**：`api.runtime.config.writeConfigFile(patch)`，再 `doSyncInstallRecord()`。
   - **doSyncInstallRecord()**
     - 总是写入/更新 `plugins.installs[openclaw-cursor-brain]`、`plugins.entries`、`plugins.allow`；**未传 opts.source 时也会根据 installPath 推断并写入合法 source**（目录有 package.json 则 `path`，否则 `npm`），避免核心只认 `npm|archive|path` 而报错。

4. **fixInstallRecordSourceOnDisk(installPath)**（setImmediate）
   - 再次读 `openclaw.json`：若本插件 install 记录缺失（例如被核心校验失败后覆盖），则按约定补全 install + entries + allow；若存在但 source 非法，则改为 `path` 或 `archive` 并写回。用于应对「核心在 register 返回后再次写盘」或「校验失败后写回最小配置」的情况。

### 1.3 已知问题与应对

- **Invalid config: plugins.installs.openclaw-cursor-brain.source / unknown command 'cursor-brain'**
  - 原因：历史上或某些安装路径下，会写入 `source: "tarball"` 或其它非法值，OpenClaw 校验只允许 `npm | archive | path`，校验失败后可能覆盖配置并导致后续子进程无法识别 `cursor-brain` 命令。
  - 应对：
    - register 开头立即修磁盘上已有记录的 source；
    - 写 patch 时规范 patch 内该记录的 source；
    - doSyncInstallRecord 在未传 source 时也写入合法 source；
    - setImmediate 中 fixInstallRecordSourceOnDisk 补全或修正 install 记录（含 entries/allow）。
  - 若仍报错：可手动编辑 `~/.openclaw/openclaw.json`，将 `plugins.installs.openclaw-cursor-brain.source` 改为 `"path"`（本地安装）或 `"archive"`（tgz），保存后再执行一次 `openclaw plugins install ./` 或重启 gateway。

- **安装时卡在 "Provider cursor-local synced"**
  - 原因：安装阶段若启动 proxy 或健康检查定时器，进程不会退出。
  - 应对：在 `isPluginsInstall` 为 true 时不调用 startProxy/startHealthCheck。

## 2. 卸载 (uninstall)

### 2.1 用户命令

- **方式 A**：`openclaw cursor-brain uninstall`（推荐，会顺带清理 MCP / provider / 模型引用）
- **方式 B**：`openclaw plugins uninstall openclaw-cursor-brain`（仅核心卸载：移除插件登记与扩展目录）

### 2.2 方式 A：`openclaw cursor-brain uninstall`

1. 插件已加载，执行 `cursor-brain uninstall` 子命令。
2. `execSync("openclaw plugins uninstall openclaw-cursor-brain", { input: "y\n", ... })`
   - 子进程中 OpenClaw 核心从配置移除该插件并删除 `~/.openclaw/extensions/openclaw-cursor-brain`。
3. 若扩展目录仍存在，再 `rmSync(installPath, { recursive: true })`（双保险）。
4. **runCleanup()**（cleanup.ts）
   - 从 Cursor 的 `mcp.json` 移除本 MCP server；
   - 从 `openclaw.json` 移除 `models.providers["cursor-local"]` 以及 `agents.defaults.model` 中 primary/fallbacks 下所有 `cursor-local/*` 引用。
5. **removePluginInstallRecord()**
   - 从 `openclaw.json` 的 `plugins.installs`、`plugins.entries`、`plugins.allow` 中移除本插件（若核心已在步骤 2 移除，此处为无操作）。

### 2.3 方式 B：`openclaw plugins uninstall openclaw-cursor-brain`

- 仅核心行为：移除插件登记并删除扩展目录；**不会**执行 runCleanup，因此 MCP 配置和 openclaw 中的 provider/模型引用可能仍保留，需要用户手动清理或再执行一次 `openclaw cursor-brain uninstall`（此时插件已不在，该命令可能不可用）。推荐优先用方式 A。

## 3. 升级 (upgrade)

### 3.1 用户命令

- `openclaw cursor-brain upgrade <source>`  
  例如：`openclaw cursor-brain upgrade ./` 或 `openclaw cursor-brain upgrade openclaw-cursor-brain@latest`

### 3.2 执行顺序

1. 插件已加载，argv 含 `cursor-brain` 与 `upgrade` → **isUninstalling === true**，register() 内不跑 setup/写配置/起 proxy，只注册 CLI。
2. 用户执行 `cursor-brain upgrade <source>`：
   - 版本比较与确认（可选交互）。
   - `execSync("openclaw plugins uninstall openclaw-cursor-brain", { input: "y\n", ... })`，必要时再 `rmSync(installPath)`。
   - **runCleanup()**，清理 MCP 与 openclaw 中的 provider/模型引用。
   - `execSync("openclaw plugins install " + source, ...)`
     - 子进程里会重新走「安装」流程，包括 register() 中的 source 修正、doSyncInstallRecord、setImmediate 的 fixInstallRecordSourceOnDisk 等。
   - 安装完成后，在当前进程内调用 **syncPluginInstallRecord({ installPath, source, updateTimestamp: true })**，用正确的 source 再写一次 install 记录。
   - 探测模型并可选交互选择主/备模型，写回 openclaw.json。

注意：`openclaw plugins upgrade openclaw-cursor-brain`（核心的 upgrade）不会设置 isUninstalling（因为 argv 不含 `cursor-brain` 子命令），因此 register() 会正常跑配置与 provider 写入，与「安装」行为一致。

## 4. 小结

| 场景                            | register() 内是否跑 setup/写配置                             | 是否起 proxy      | 备注                                                              |
| ------------------------------- | ------------------------------------------------------------ | ----------------- | ----------------------------------------------------------------- |
| openclaw plugins install ...    | 是（isPluginsInstall 时同步写盘 + setImmediate 再修 source） | 否                | 保证合法 source，避免校验覆盖                                     |
| openclaw plugins upgrade ...    | 是                                                           | 按非 install 逻辑 | isUninstalling 仅对 cursor-brain uninstall/upgrade 为 true        |
| openclaw cursor-brain uninstall | 否（isUninstalling）                                         | 否                | 仅注册 CLI，由子命令执行卸载与 cleanup                            |
| openclaw cursor-brain upgrade   | 否（isUninstalling）                                         | 否                | 由子命令先 uninstall 再 install，install 在子进程里跑完整安装流程 |

所有涉及写入 `plugins.installs.openclaw-cursor-brain` 的地方都保证 `source` 仅为 `npm`、`archive` 或 `path`，避免 OpenClaw 配置校验失败导致配置被覆盖或出现 unknown command。

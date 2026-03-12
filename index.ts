import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { existsSync, readFileSync, writeFileSync, appendFileSync, rmSync, realpathSync, mkdirSync, cpSync } from "fs";
import { createHash } from "crypto";
import { join, resolve, dirname, isAbsolute } from "path";
import { homedir } from "os";
import { execSync, spawn } from "child_process";
import { createRequire } from "module";
import { runSetup, type SetupContext, type CursorModel, detectCursorPath, detectOutputFormat, discoverCursorModels } from "./src/setup.js";
import { runDoctorChecks, formatDoctorResults, countDiscoveredTools } from "./src/doctor.js";
import { runCleanup } from "./src/cleanup.js";
import { PLUGIN_ID, PROVIDER_ID, DEFAULT_PROXY_PORT, OPENCLAW_CONFIG_PATH, getCursorMcpConfigPath, type OutputFormat } from "./src/constants.js";

let proxyChild: ReturnType<typeof spawn> | null = null;
let proxyRestartCount = 0;
let lastProxyStartTime = 0;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
const MAX_PROXY_RESTARTS = 3;
const PROXY_RESTART_DELAYS = [2000, 10000, 60000];
const PROXY_STABLE_PERIOD = 300000;
const HEALTH_CHECK_INTERVAL = 60000; // 60s

// @clack/prompts lives in openclaw's node_modules; follow the bin symlink to resolve
let _clack: any;
function loadClack() {
  if (_clack) return _clack;
  let entry = process.argv[1] || __filename;
  try { entry = realpathSync(entry); } catch {}
  _clack = createRequire(entry)("@clack/prompts");
  return _clack;
}

function fetchProxyHealth(port: number, timeoutMs = 5000): Record<string, any> | null {
  try {
    const cmd = process.platform === "win32"
      ? `node -e "fetch('http://127.0.0.1:${port}/v1/health').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.stdout.write('{}'))"`
      : `curl -sf http://127.0.0.1:${port}/v1/health`;
    const raw = execSync(cmd, { encoding: "utf-8", timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"] });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isProxyRunning(port: number): boolean {
  return fetchProxyHealth(port) !== null;
}

function killPortProcess(port: number) {
  try {
    if (process.platform === "win32") {
      const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
        encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const pids = new Set(out.split("\n").map(l => l.trim().split(/\s+/).pop()).filter(Boolean));
      for (const pid of pids) {
        try { process.kill(parseInt(pid!, 10), "SIGTERM"); } catch {}
      }
    } else {
      const out = execSync(`lsof -ti :${port}`, { encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).trim();
      if (out) {
        for (const pid of out.split("\n")) {
          try { process.kill(parseInt(pid, 10), "SIGTERM"); } catch {}
        }
      }
    }
  } catch {}
}

function computeFileHash(filePath: string): string {
  try {
    const content = readFileSync(filePath, "utf-8");
    return createHash("sha256").update(content).digest("hex").slice(0, 12);
  } catch { return "unknown"; }
}

/** Run interactive setup (model selection) during plugins install when TTY is available. */
function runInteractiveSetupAfterInstall(): void {
  try {
    execSync("openclaw cursor-brain setup", { stdio: "inherit" });
  } catch {
    // User cancelled or non-zero exit; ignore so install still completes
  }
}

function readPackageVersion(dir: string): string {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")).version || "unknown";
  } catch { return "unknown"; }
}

/** Returns 1 if a > b, -1 if a < b, 0 if equal. Non-semver strings compare as equal. */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  if (pa.some(isNaN) || pb.some(isNaN)) return 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function startProxy(opts: { pluginDir: string; cursorPath: string; workspaceDir: string; port: number; outputFormat: OutputFormat; cursorModel: string; logger: any }) {
  const proxyScript = join(opts.pluginDir, "mcp-server", "streaming-proxy.mjs");
  if (!existsSync(proxyScript)) return;

  if (proxyChild) {
    proxyChild.kill();
    proxyChild = null;
  }

  killPortProcess(opts.port);
  for (let i = 0; i < 15; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    if (!isProxyRunning(opts.port)) break;
  }

  const proxyLogPath = join(homedir(), ".openclaw", "cursor-proxy.stderr.log");
  let stderrBuf = "";
  const appendProxyStderr = (chunk: string) => {
    stderrBuf = (stderrBuf + chunk).slice(-50_000);
    try { appendFileSync(proxyLogPath, chunk); } catch {}
  };

  const child = spawn("node", [proxyScript], {
    env: {
      ...process.env,
      CURSOR_PATH: opts.cursorPath,
      CURSOR_WORKSPACE_DIR: opts.workspaceDir,
      CURSOR_PROXY_PORT: String(opts.port),
      CURSOR_OUTPUT_FORMAT: opts.outputFormat,
      CURSOR_MODEL: opts.cursorModel,
      CURSOR_PROXY_SCRIPT_HASH: computeFileHash(proxyScript),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  proxyChild = child;

  child.stderr?.on("data", (d: Buffer | string) => {
    const s = Buffer.isBuffer(d) ? d.toString("utf-8") : String(d);
    appendProxyStderr(s);
  });
  child.on("error", (err: Error) => {
    const msg = `[proxy-child-error] ${err?.message || String(err)}\n`;
    appendProxyStderr(msg);
    opts.logger.error(`Streaming proxy child process error: ${err?.message || String(err)}`);
  });

  lastProxyStartTime = Date.now();

  child.on("exit", (code) => {
    opts.logger.info(`Streaming proxy exited (code ${code})`);
    if (proxyChild === child) proxyChild = null;

    if (code === 0 || code === null || proxyRestartScheduled) return;

    const stderrSnippet = stderrBuf.trim().slice(-2000);
    if (stderrSnippet) {
      opts.logger.warn(`Streaming proxy stderr (tail): ${stderrSnippet.replace(/\s+/g, " ")}`);
    }

    const uptime = Date.now() - lastProxyStartTime;
    if (uptime > PROXY_STABLE_PERIOD) proxyRestartCount = 0;

    if (proxyRestartCount >= MAX_PROXY_RESTARTS) {
      opts.logger.error(`Proxy crashed ${proxyRestartCount} times within cooldown, not restarting. Run: openclaw cursor-brain proxy restart`);
      return;
    }

    const delay = PROXY_RESTART_DELAYS[Math.min(proxyRestartCount, PROXY_RESTART_DELAYS.length - 1)];
    proxyRestartCount++;
    opts.logger.warn(`Proxy crashed (code ${code}), restarting in ${delay / 1000}s (attempt ${proxyRestartCount}/${MAX_PROXY_RESTARTS})`);
    setTimeout(() => startProxy(opts), delay);
  });

  opts.logger.info(`Streaming proxy started on port ${opts.port} (pid ${child.pid})`);
  startHealthCheck(opts);
}

let proxyRestartScheduled = false;

function startHealthCheck(opts: { pluginDir: string; cursorPath: string; workspaceDir: string; port: number; outputFormat: OutputFormat; cursorModel: string; logger: any }) {
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  proxyRestartScheduled = false;
  healthCheckTimer = setInterval(() => {
    if (!proxyChild || proxyRestartScheduled) return;
    try {
      const health = fetchProxyHealth(opts.port);
      if (!health) return;
      if (health.status === "degraded") {
        opts.logger.warn(`Proxy health degraded (failures=${health.consecutiveFailures}, timeouts=${health.consecutiveTimeouts}), restarting...`);
        proxyRestartScheduled = true;
        if (healthCheckTimer) clearInterval(healthCheckTimer);
        proxyChild?.kill();
        proxyChild = null;
        setTimeout(() => {
          proxyRestartScheduled = false;
          startProxy(opts);
        }, 2000);
      }
    } catch {
      // health check itself failed — proxy may be down, exit handler will restart it
    }
  }, HEALTH_CHECK_INTERVAL);
  healthCheckTimer.unref();
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const MODEL_DEFAULTS = { input: ["text"], contextWindow: 128000, maxTokens: 8192, cost: ZERO_COST };

function buildProviderConfig(port: number, cursorModels: CursorModel[]) {
  const models = cursorModels.length
    ? cursorModels.map((m) => ({ id: m.id, name: m.name, reasoning: m.reasoning, ...MODEL_DEFAULTS }))
    : [{ id: "auto", name: "Cursor Auto", reasoning: true, ...MODEL_DEFAULTS }];

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "local",
    api: "openai-completions",
    models,
  };
}

function autoSelectModels(
  models: CursorModel[],
  currentPrimary?: string,
  currentFallbacks?: string[],
): { primary: string; fallbacks: string[] } {
  const defaultModel = models.find((m) => m.isDefault);
  const primary = currentPrimary || defaultModel?.id || models[0]?.id || "auto";
  const fallbacks = currentFallbacks?.length
    ? currentFallbacks.filter((id) => id !== primary)
    : models.filter((m) => m.id !== primary).map((m) => m.id);
  return { primary, fallbacks };
}

async function promptModelSelection(
  models: CursorModel[],
  currentPrimary?: string,
  currentFallbacks?: string[],
): Promise<{ primary: string; fallbacks: string[] } | null> {
  if (!models.length) {
    console.log("  ⚠ No models discovered from cursor-agent");
    return null;
  }

  try {
    const clack = loadClack();

    const toOption = (m: CursorModel) => {
      const tags: string[] = [];
      if (m.reasoning) tags.push("thinking");
      if (m.isDefault) tags.push("cursor default");
      return { value: m.id, label: m.id, hint: `${m.name}${tags.length ? ` (${tags.join(", ")})` : ""}` };
    };
    const options = models.map(toOption);

    const primary = await clack.select({
      message: "Select primary model (↑↓ navigate, enter confirm)",
      options,
      initialValue: currentPrimary || models[0].id,
      maxItems: 12,
    });
    if (clack.isCancel(primary)) { clack.cancel("Cancelled"); return null; }

    const fallbackOptions = models.filter((m) => m.id !== primary).map(toOption);
    const defaultFallbacks = currentFallbacks?.length
      ? currentFallbacks.filter((id) => id !== primary)
      : fallbackOptions.map((o) => o.value);

    const fallbacks = await clack.multiselect({
      message: "Select fallback models (space toggle, enter confirm, order follows list)",
      options: fallbackOptions,
      initialValues: defaultFallbacks,
      maxItems: 12,
      required: false,
    });
    if (clack.isCancel(fallbacks)) { clack.cancel("Cancelled"); return null; }

    const selectedFallbacks = fallbacks as string[];
    clack.log.success(`Primary:   ${PROVIDER_ID}/${primary}`);
    clack.log.success(`Fallbacks: ${selectedFallbacks.length ? selectedFallbacks.map((f) => `${PROVIDER_ID}/${f}`).join(" → ") : "none"}`);

    return { primary: primary as string, fallbacks: selectedFallbacks };
  } catch (err: any) {
    console.log(`  ⚠ Interactive prompt failed (${err.code || err.message}), using defaults.`);
    const result = autoSelectModels(models, currentPrimary, currentFallbacks);
    console.log(`    Primary:   ${PROVIDER_ID}/${result.primary}`);
    console.log(`    Fallbacks: ${result.fallbacks.length ? result.fallbacks.map((f) => `${PROVIDER_ID}/${f}`).join(" → ") : "none"}`);
    console.log("    Run `openclaw cursor-brain setup` in an interactive terminal to choose manually.");
    return result;
  }
}

function saveModelSelection(primary: string, fallbacks: string[], proxyPort: number, models: CursorModel[]) {
  let config: Record<string, any> = {};
  try { config = JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, "utf-8")); } catch {}
  const agents = config.agents || {};
  const defaults = agents.defaults || {};
  defaults.model = {
    primary: `${PROVIDER_ID}/${primary}`,
    fallbacks: fallbacks.map((f) => `${PROVIDER_ID}/${f}`),
  };
  agents.defaults = defaults;
  config.agents = agents;

  const modelsSection = config.models || {};
  modelsSection.mode = "merge";
  const providers = modelsSection.providers || {};
  providers[PROVIDER_ID] = buildProviderConfig(proxyPort, models);
  modelsSection.providers = providers;
  config.models = modelsSection;

  writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

const VALID_SOURCES = ["npm", "archive", "path"] as const;

/**
 * Re-read openclaw.json and fix plugins.installs[PLUGIN_ID].source to a valid
 * value (or re-add the record if missing after core overwrite). Called from
 * setImmediate after install so we run after core may have written invalid source.
 */
function fixInstallRecordSourceOnDisk(installPath: string): void {
  try {
    if (!existsSync(OPENCLAW_CONFIG_PATH)) return;
    const raw = readFileSync(OPENCLAW_CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw);
    const plugins = cfg.plugins || {};
    const installs = plugins.installs || {};
    const entries = plugins.entries || {};
    let rec = installs[PLUGIN_ID];
    let changed = false;
    if (!rec) {
      rec = { installPath, source: "path", sourcePath: resolve(installPath) };
      if (existsSync(join(installPath, "package.json"))) {
        try { rec.version = JSON.parse(readFileSync(join(installPath, "package.json"), "utf-8")).version; } catch { /* ignore */ }
      }
      installs[PLUGIN_ID] = rec;
      plugins.installs = installs;
      entries[PLUGIN_ID] = { ...entries[PLUGIN_ID], enabled: true };
      plugins.entries = entries;
      const allow: string[] = Array.isArray(plugins.allow) ? plugins.allow : [];
      if (!allow.includes(PLUGIN_ID)) {
        allow.push(PLUGIN_ID);
        plugins.allow = allow;
      }
      cfg.plugins = plugins;
      changed = true;
    } else if (rec.source === "tarball" || (rec.source && !VALID_SOURCES.includes(rec.source as any))) {
      rec.source = existsSync(join(installPath, "package.json")) ? "path" : "archive";
      if (rec.source === "path") rec.sourcePath = resolve(installPath);
      changed = true;
    }
    if (changed) writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  } catch { /* ignore */ }
}

/**
 * Ensure plugins.installs and plugins.entries in openclaw.json reflect the
 * actual on-disk state.  Both `openclaw plugins install` and `uninstall` may
 * exit non-zero (e.g. plugins.allow warnings) without persisting config
 * changes, so the plugin itself must reconcile the record.
 */
function syncPluginInstallRecord(opts: {
  installPath: string;
  source?: string;
  updateTimestamp?: boolean;
}): void {
  let config: Record<string, any> = {};
  try { config = JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, "utf-8")); } catch {}

  const plugins = config.plugins || {};
  const entries = plugins.entries || {};
  const installs = plugins.installs || {};

  entries[PLUGIN_ID] = { ...entries[PLUGIN_ID], enabled: true };

  const allow: string[] = Array.isArray(plugins.allow) ? plugins.allow : [];
  if (!allow.includes(PLUGIN_ID)) {
    allow.push(PLUGIN_ID);
    plugins.allow = allow;
  }

  const version = readPackageVersion(opts.installPath);
  const prev = installs[PLUGIN_ID] || {};
  const record: Record<string, any> = { ...prev, installPath: opts.installPath };

  // OpenClaw only allows source: "npm" | "archive" | "path"
  if (record.source === "tarball") record.source = "archive";

  if (version !== "unknown") record.version = version;
  if (opts.updateTimestamp !== false) record.installedAt = new Date().toISOString();

  if (opts.source) {
    const abs = resolve(opts.source);
    if (opts.source.endsWith(".tgz") || opts.source.endsWith(".tar.gz")) {
      record.source = "archive";
      record.sourcePath = abs;
      delete record.spec;
    } else if (existsSync(join(abs, "package.json"))) {
      record.source = "path";
      record.sourcePath = abs;
      delete record.spec;
    } else {
      record.source = "npm";
      record.spec = opts.source;
      delete record.sourcePath;
    }
  } else if (!record.source || record.source === "tarball") {
    // Always set a valid source so core validation never sees invalid/tarball
    if (existsSync(join(opts.installPath, "package.json"))) {
      record.source = "path";
      record.sourcePath = resolve(opts.installPath);
      delete record.spec;
    } else {
      record.source = "npm";
      record.spec = PLUGIN_ID;
      delete record.sourcePath;
    }
  }

  installs[PLUGIN_ID] = record;
  plugins.entries = entries;
  plugins.installs = installs;
  config.plugins = plugins;

  writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Remove this plugin's entries from plugins.installs, plugins.entries, and
 * plugins.allow in openclaw.json.  Called during uninstall to ensure clean
 * removal even when `openclaw plugins uninstall` exits non-zero.
 */
function removePluginInstallRecord(): void {
  let config: Record<string, any> = {};
  try { config = JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, "utf-8")); } catch { return; }

  const plugins = config.plugins;
  if (!plugins) return;

  let changed = false;

  if (plugins.entries?.[PLUGIN_ID]) {
    delete plugins.entries[PLUGIN_ID];
    changed = true;
  }
  if (plugins.installs?.[PLUGIN_ID]) {
    delete plugins.installs[PLUGIN_ID];
    changed = true;
  }
  if (Array.isArray(plugins.allow)) {
    const idx = plugins.allow.indexOf(PLUGIN_ID);
    if (idx !== -1) {
      plugins.allow.splice(idx, 1);
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  }
}

function resolvePluginDir(api: OpenClawPluginApi): string {
  const installRecord = (api.config.plugins as any)?.installs?.[PLUGIN_ID];
  if (installRecord?.installPath && existsSync(join(installRecord.installPath, "mcp-server", "server.mjs"))) {
    return installRecord.installPath;
  }
  const conventionPath = join(homedir(), ".openclaw", "extensions", PLUGIN_ID);
  if (existsSync(join(conventionPath, "mcp-server", "server.mjs"))) {
    return conventionPath;
  }
  return api.resolvePath(".");
}

const plugin = {
  id: PLUGIN_ID,
  name: "Cursor Brain",
  description:
    "Use Cursor Agent as the AI brain for OpenClaw via MCP. " +
    "Auto-discovers plugin tools and proxies them through the Gateway REST API.",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    // Fix invalid source value on disk immediately so OpenClaw config validation won't overwrite
    try {
      if (existsSync(OPENCLAW_CONFIG_PATH)) {
        const raw = readFileSync(OPENCLAW_CONFIG_PATH, "utf-8");
        const cfg = JSON.parse(raw);
        const rec = cfg?.plugins?.installs?.[PLUGIN_ID];
        if (rec && rec.source && !VALID_SOURCES.includes(rec.source as any)) {
          rec.source = rec.source === "tarball" ? "archive" : "path";
          if (rec.source === "path" && rec.installPath) rec.sourcePath = resolve(rec.installPath);
          writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
        }
      }
    } catch { /* ignore */ }

    const pluginDir = resolvePluginDir(api);
    const config = api.config;
    const pluginConfig = api.pluginConfig || {};

    // Only skip setup when user runs our CLI uninstall/upgrade; "openclaw plugins upgrade" should still run register setup
    const isCursorBrainUninstallOrUpgrade =
      process.argv.includes("cursor-brain") &&
      process.argv.some((a) => a === "uninstall" || a === "upgrade");
    const isUninstalling = isCursorBrainUninstallOrUpgrade;
    const argv = process.argv.join(" ");
    const isProxyCmd = /\bcursor-brain\s+proxy\b/.test(argv);
    // During "openclaw plugins install", do not start proxy or timers so the install process can exit
    const isPluginsInstall = process.argv.includes("plugins") && process.argv.includes("install");
    // When running "cursor-brain setup" (standalone or as install child), skip starting proxy; user will "gateway restart" to get proxy
    const isSetupOnly = process.argv.includes("cursor-brain") && process.argv.includes("setup");

    if (!isUninstalling) {
      const ctx: SetupContext = {
        pluginDir,
        gatewayPort: config.gateway?.port ?? 18789,
        gatewayToken: (config.gateway as any)?.auth?.token ?? "",
        workspaceDir: (config.agents as any)?.defaults?.workspace ?? "",
        pluginConfig,
        logger: api.logger,
      };

      const result = runSetup(ctx);

      for (const w of result.warnings) api.logger.warn(w);
      for (const e of result.errors) api.logger.error(e);

      if (result.cursorPath && result.mcpConfigured) {
        api.logger.info("Cursor Brain setup complete");
      }
      const runInteractiveSetup = isPluginsInstall && result.cursorPath && result.cursorModels.length > 0 && !!process.stdin.isTTY;
      if (isPluginsInstall && result.cursorPath && !runInteractiveSetup) {
        api.logger.info("Run 'openclaw cursor-brain setup' to choose primary/fallback models (optional), then 'openclaw gateway restart' to start.");
      }

      const proxyPort = (pluginConfig.proxyPort as number) || DEFAULT_PROXY_PORT;
      const existingProviders = (config as any).models?.providers ?? {};
      const discovered = result.cursorModels;
      const providerExists = !!existingProviders[PROVIDER_ID];

      const doSyncInstallRecord = () => {
        try {
          syncPluginInstallRecord({ installPath: pluginDir, updateTimestamp: false });
        } catch (e: any) {
          api.logger.warn(`Could not sync install record: ${e.message}`);
        }
      };

      if (result.cursorPath) {
        try {
          const newProviderConfig = buildProviderConfig(proxyPort, discovered);
          const existingProvider = existingProviders[PROVIDER_ID];
          const providerUnchanged = existingProvider &&
            JSON.stringify(existingProvider) === JSON.stringify(newProviderConfig);

          if (providerUnchanged && providerExists) {
            api.logger.info(`Provider "${PROVIDER_ID}" unchanged (${discovered.length} models, port ${proxyPort})`);
            doSyncInstallRecord();
            // Still ensure default model is set when missing (e.g. config was overwritten or never set)
            try {
              let cfg: Record<string, any> = {};
              try { cfg = JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, "utf-8")); } catch { /* ignore */ }
              const currentPrimary = (cfg.agents?.defaults?.model as any)?.primary;
              if (!currentPrimary || String(currentPrimary).startsWith(`${PROVIDER_ID}/`)) {
                const primary = (pluginConfig.model as string) || "auto";
                const fallbacks = discovered.filter((m) => m.id !== primary).map((m) => `${PROVIDER_ID}/${m.id}`);
                const agents = cfg.agents || {};
                const defaults = agents.defaults || {};
                defaults.model = { primary: `${PROVIDER_ID}/${primary}`, fallbacks };
                agents.defaults = defaults;
                cfg.agents = agents;
                writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
                api.logger.info(`Default model set to ${PROVIDER_ID}/${primary}`);
              }
            } catch (e: any) {
              api.logger.warn(`Could not set default model: ${e.message}`);
            }
            if (runInteractiveSetup) runInteractiveSetupAfterInstall();
          } else {
            // Read fresh config from disk rather than using api.config snapshot,
            // which may contain stale plugins data (e.g. during install subprocess
            // where the core has already updated plugins.installs on disk but
            // api.config still holds the pre-update snapshot).
            let freshConfig: Record<string, any> = {};
            try { freshConfig = JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, "utf-8")); } catch { freshConfig = { ...config }; }

            const patch: Record<string, unknown> = {
              ...freshConfig,
              models: {
                ...(freshConfig.models || {}),
                mode: "merge",
                providers: {
                  ...(freshConfig.models?.providers || {}),
                  [PROVIDER_ID]: newProviderConfig,
                },
              },
            };

            const currentPrimary = (freshConfig.agents?.defaults?.model as any)?.primary;
            const shouldSetDefaultModel =
              !providerExists ||
              !currentPrimary ||
              String(currentPrimary).startsWith(`${PROVIDER_ID}/`);
            if (shouldSetDefaultModel) {
              const primary = (pluginConfig.model as string) || "auto";
              const fallbacks = discovered.filter((m) => m.id !== primary).map((m) => `${PROVIDER_ID}/${m.id}`);
              (patch as any).agents = {
                ...(freshConfig.agents || {}),
                defaults: {
                  ...(freshConfig.agents?.defaults || {}),
                  model: {
                    primary: `${PROVIDER_ID}/${primary}`,
                    fallbacks,
                  },
                },
              };
            }

            // Ensure OpenClaw-accepted source value (avoids config overwrite during install)
            const patchInstallRecord = (patch as any).plugins?.installs?.[PLUGIN_ID];
            if (patchInstallRecord?.source === "tarball") patchInstallRecord.source = "archive";

            if (isPluginsInstall) {
              try {
                mkdirSync(dirname(OPENCLAW_CONFIG_PATH), { recursive: true });
                writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(patch, null, 2) + "\n");
                api.logger.info(`Provider "${PROVIDER_ID}" synced (${discovered.length} models, port ${proxyPort})`);
                doSyncInstallRecord();
                if (runInteractiveSetup) runInteractiveSetupAfterInstall();
                // Core may overwrite config after we return; fix source again on next tick so disk stays valid
                setImmediate(() => fixInstallRecordSourceOnDisk(pluginDir));
              } catch (err: any) {
                api.logger.warn(`Could not write config: ${err.message}`);
                doSyncInstallRecord();
                if (runInteractiveSetup) runInteractiveSetupAfterInstall();
                setImmediate(() => fixInstallRecordSourceOnDisk(pluginDir));
              }
            } else {
              api.runtime.config.writeConfigFile(patch as any).then(() => {
                api.logger.info(`Provider "${PROVIDER_ID}" synced (${discovered.length} models, port ${proxyPort})`);
                doSyncInstallRecord();
              }).catch((err: any) => {
                api.logger.warn(`Could not write config: ${err.message}`);
                doSyncInstallRecord();
              });
            }
          }
        } catch (e: any) {
          api.logger.warn(`Could not auto-configure: ${e.message}`);
          doSyncInstallRecord();
          if (isPluginsInstall) setImmediate(() => fixInstallRecordSourceOnDisk(pluginDir));
        }
      } else {
        doSyncInstallRecord();
        if (isPluginsInstall) setImmediate(() => fixInstallRecordSourceOnDisk(pluginDir));
      }

      if (result.cursorPath && !isProxyCmd && !isPluginsInstall && !isSetupOnly) {
        const proxyOpts = {
          pluginDir,
          cursorPath: result.cursorPath,
          workspaceDir: ctx.workspaceDir,
          port: proxyPort,
          outputFormat: result.outputFormat,
          cursorModel: (pluginConfig.cursorModel as string) || "",
          logger: api.logger,
        };

        const proxyRunning = isProxyRunning(proxyPort);
        let needRestart = !proxyRunning;

        if (proxyRunning) {
          const health = fetchProxyHealth(proxyPort, 3000);
          if (health) {
            const proxyScript = join(pluginDir, "mcp-server", "streaming-proxy.mjs");
            const installedHash = computeFileHash(proxyScript);
            if (health.scriptHash !== installedHash) {
              api.logger.info(`Proxy script changed (running=${health.scriptHash}, installed=${installedHash}), restarting...`);
              needRestart = true;
            }
          } else {
            needRestart = true;
          }
        }

        if (needRestart) {
          startProxy(proxyOpts);
        } else if (!proxyChild) {
          // Proxy is running but not our child (orphan from previous gateway).
          // Kill it and start a fresh one under this process tree to ensure
          // proper stdio handling and health monitoring.
          api.logger.info(`Adopting orphan proxy on port ${proxyPort} — killing and restarting under this gateway`);
          startProxy(proxyOpts);
        } else {
          api.logger.info(`Streaming proxy up-to-date on port ${proxyPort}`);
          startHealthCheck(proxyOpts);
        }
      }
    }

    api.registerCli((ctx) => {
      const prog = ctx.program
        .command("cursor-brain")
        .description("Cursor Brain — AI backend management via MCP");

      prog
        .command("setup")
        .description("Run or re-run MCP server configuration")
        .action(async () => {
          const clack = loadClack();
          clack.intro(`Cursor Brain Setup (v${readPackageVersion(pluginDir)})`);

          const s = clack.spinner();
          s.start("Configuring MCP server...");
          const setupCtx: SetupContext = {
            pluginDir,
            gatewayPort: config.gateway?.port ?? 18789,
            gatewayToken: (config.gateway as any)?.auth?.token ?? "",
            workspaceDir: (config.agents as any)?.defaults?.workspace ?? "",
            pluginConfig,
            logger: api.logger,
          };
          const result = runSetup(setupCtx);
          if (result.errors.length) {
            s.stop("Setup failed");
            for (const e of result.errors) clack.log.error(e);
            process.exitCode = 1;
            return;
          }
          s.stop("MCP server configured");
          clack.log.info(`Cursor:        ${result.cursorPath}`);
          clack.log.info(`Output format: ${result.outputFormat}`);
          clack.log.info(`Models found:  ${result.cursorModels.length}`);
          clack.log.info(`MCP config:    ${getCursorMcpConfigPath()}`);

          const currentModel = (config.agents as any)?.defaults?.model;
          const curPrimary = currentModel?.primary?.replace(`${PROVIDER_ID}/`, "");
          const curFallbacks = (currentModel?.fallbacks as string[] | undefined)?.map((f: string) => f.replace(`${PROVIDER_ID}/`, ""));
          const selection = await promptModelSelection(result.cursorModels, curPrimary, curFallbacks);
          if (selection) {
            const proxyPort = (pluginConfig.proxyPort as number) || DEFAULT_PROXY_PORT;
            try {
              saveModelSelection(selection.primary, selection.fallbacks, proxyPort, result.cursorModels);
              clack.log.success("Model configuration saved to openclaw.json");
            } catch (e: any) {
              clack.log.error(`Could not save config: ${e.message}`);
            }
          }
          try {
            syncPluginInstallRecord({ installPath: pluginDir, updateTimestamp: false });
          } catch {}
          clack.outro("Run `openclaw gateway restart` to apply changes");
          process.exit(0);
        });

      prog
        .command("doctor")
        .description("Check Cursor Brain health")
        .action(() => {
          const checks = runDoctorChecks({
            gatewayPort: config.gateway?.port ?? 18789,
            gatewayToken: (config.gateway as any)?.auth?.token ?? "",
            pluginDir,
            cursorPathOverride: pluginConfig.cursorPath as string | undefined,
          });
          console.log(formatDoctorResults(checks));
          if (checks.some((c) => !c.ok)) process.exitCode = 1;
        });

      prog
        .command("status")
        .description("Show current configuration status")
        .action(() => {
          const cursorPath = detectCursorPath(pluginConfig.cursorPath as string | undefined);
          const model = (config.agents as any)?.defaults?.model;

          const pluginVersion = readPackageVersion(pluginDir);

          let cursorVersion = "unknown";
          if (cursorPath) {
            try {
              const out = execSync(`"${cursorPath}" --version`, {
                encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"],
              });
              cursorVersion = out.trim().split("\n")[0]?.trim() || "unknown";
            } catch { /* ignore */ }
          }

          let detectedFormat: OutputFormat | "n/a" = "n/a";
          if (cursorPath) {
            detectedFormat = detectOutputFormat(cursorPath, pluginConfig.outputFormat as string | undefined);
          }

          const toolCandidates = countDiscoveredTools() ?? 0;

          const proxyPort = (pluginConfig.proxyPort as number) || DEFAULT_PROXY_PORT;
          const proxyUp = isProxyRunning(proxyPort);
          const providers = (config as any).models?.providers ?? {};
          const hasProvider = !!providers[PROVIDER_ID];

          console.log("Cursor Brain Status\n");
          console.log(`  Plugin version:   v${pluginVersion}`);
          console.log(`  Platform:         ${process.platform}`);
          console.log(`  Plugin dir:       ${pluginDir}`);
          console.log(`  Cursor path:      ${cursorPath || "not found"}`);
          console.log(`  Cursor version:   ${cursorVersion}`);
          console.log(`  Output format:    ${detectedFormat}`);
          console.log(`  Streaming proxy:  ${proxyUp ? `running on :${proxyPort}` : "not running"}`);
          console.log(`  Provider:         ${hasProvider ? `"${PROVIDER_ID}" configured` : "not configured"}`);
          console.log(`  Primary model:    ${model?.primary || "not set"}`);
          const fb = model?.fallbacks;
          console.log(`  Fallbacks (${fb?.length || 0}):   ${fb?.length ? fb.slice(0, 5).join(" → ") + (fb.length > 5 ? ` … +${fb.length - 5} more` : "") : "none"}`);
          console.log(`  Gateway:          http://127.0.0.1:${config.gateway?.port ?? 18789}`);
          console.log(`  MCP config:       ${getCursorMcpConfigPath()}`);
          console.log(`  Tool candidates:  ${toolCandidates} (from plugin sources)`);
        });

      prog
        .command("uninstall")
        .description("Clean up configurations and remove the plugin completely")
        .action(() => {
          const installPath = join(homedir(), ".openclaw", "extensions", PLUGIN_ID);

          console.log(`Cursor Brain Uninstall (v${readPackageVersion(pluginDir)})\n`);

          console.log("[1/4] Removing plugin registration...");
          try {
            execSync(`openclaw plugins uninstall ${PLUGIN_ID}`, {
              encoding: "utf-8",
              input: "y\n",
              timeout: 30000,
              stdio: ["pipe", "pipe", "pipe"],
            });
            console.log("  ✓ Plugin config entry removed");
          } catch {
            console.log("  - Plugin config entry already removed or command failed");
          }

          console.log("[2/4] Removing plugin files...");
          if (existsSync(installPath)) {
            rmSync(installPath, { recursive: true, force: true });
            console.log(`  ✓ Removed ${installPath}`);
          } else {
            console.log("  - Plugin directory already removed");
          }

          console.log("[3/4] Cleaning up configurations...");
          const result = runCleanup();
          try { removePluginInstallRecord(); } catch {}

          if (result.mcpRemoved) console.log(`  ✓ Removed MCP server from ${getCursorMcpConfigPath()}`);
          if (result.providerRemoved) console.log(`  ✓ Removed provider "${PROVIDER_ID}"`);
          if (result.modelReset) console.log(`  ✓ Removed ${PROVIDER_ID}/* model references`);

          if (result.errors.length) {
            for (const e of result.errors) console.error(`  ✗ ${e}`);
            process.exitCode = 1;
          }

          console.log("[4/4] Done!\n");
          console.log("Restart the gateway to apply changes:");
          console.log("  openclaw gateway restart");
        });

      prog
        .command("upgrade <source>")
        .description("Upgrade plugin from a path, .tgz archive, or npm spec")
        .action(async (source: string) => {
          const clack = loadClack();

          const installPath = join(homedir(), ".openclaw", "extensions", PLUGIN_ID);

          const oldVersion = readPackageVersion(pluginDir);
          const sourceVersion = readPackageVersion(source);
          const versionHint = sourceVersion !== "unknown"
            ? `v${oldVersion} → v${sourceVersion}`
            : `v${oldVersion} → ${source}`;

          clack.intro(`Cursor Brain Upgrade (${versionHint})`);

          if (sourceVersion !== "unknown" && oldVersion !== "unknown") {
            const cmp = compareSemver(sourceVersion, oldVersion);
            if (cmp < 0) {
              try {
                const ok = await clack.confirm({ message: `Target version v${sourceVersion} is older than current v${oldVersion}. Downgrade anyway?` });
                if (ok !== true) {
                  clack.log.info("Upgrade cancelled");
                  return;
                }
              } catch {
                clack.log.warn(`Target version v${sourceVersion} is older than current v${oldVersion}. Proceeding (non-interactive).`);
              }
            } else if (cmp === 0) {
              try {
                const ok = await clack.confirm({ message: `Target version v${sourceVersion} is the same as current. Reinstall?` });
                if (ok !== true) {
                  clack.log.info("Upgrade cancelled");
                  return;
                }
              } catch {
                clack.log.info(`Reinstalling v${sourceVersion} (non-interactive).`);
              }
            }
          }

          const s = clack.spinner();
          s.start("Removing old plugin...");
          try {
            execSync(`openclaw plugins uninstall ${PLUGIN_ID}`, {
              encoding: "utf-8",
              input: "y\n",
              timeout: 30000,
              stdio: ["pipe", "pipe", "pipe"],
            });
          } catch (e: any) {
            const msg = e?.stderr || e?.stdout || e?.message || String(e);
            if (msg) clack.log.warn(`Uninstall CLI output: ${msg.slice(0, 500)}`);
          }
          if (existsSync(installPath)) {
            rmSync(installPath, { recursive: true, force: true });
          }
          try { removePluginInstallRecord(); } catch {}
          runCleanup();
          if (existsSync(installPath)) {
            clack.log.warn(`Install path still exists after cleanup: ${installPath}`);
            rmSync(installPath, { recursive: true, force: true });
          }
          s.stop(`Old plugin removed (v${oldVersion})`);

          // Resolve source path. Only use PWD for path-like source (e.g. "./"): during upgrade the host may have
          // chdir'd to the plugin dir, so process.cwd() would be wrong. For npm specs (e.g. "openclaw-cursor-brain")
          // we must not resolve with PWD, else resolve(PWD, "openclaw-cursor-brain") can equal installPath and trigger a false conflict.
          const isPathLike = source.startsWith(".") || isAbsolute(source);
          const baseDir = isPathLike ? (process.env.PWD || process.cwd()) : process.cwd();
          let resolvedPath = isAbsolute(source) ? source : resolve(baseDir, source);
          if (isPathLike && !isAbsolute(source) && resolvedPath === installPath) {
            resolvedPath = resolve(process.cwd(), source);
            if (resolvedPath === installPath) {
              clack.log.error("Cannot resolve source: current directory appears to be the plugin dir. Use an absolute path: openclaw cursor-brain upgrade /path/to/openclaw-cursor-brain");
              process.exitCode = 1;
              return;
            }
            clack.log.warn(`Using PWD (${baseDir}) to resolve "${source}"; process.cwd() was the plugin dir.`);
          }
          const isLocalPath =
            isAbsolute(source) ||
            source.startsWith(".") ||
            existsSync(resolvedPath) ||
            existsSync(join(resolvedPath, "package.json"));
          const installSource = isLocalPath ? resolvedPath : source;
          const installArg = isLocalPath ? `"${installSource.replace(/"/g, '\\"')}"` : installSource;

          s.start(`Installing from ${source}...`);
          let installError: string | undefined;
          try {
            const installCwd = isLocalPath ? resolvedPath : process.cwd();
            const installCmd = isLocalPath ? "openclaw plugins install ." : `openclaw plugins install ${installArg}`;
            execSync(installCmd, {
              encoding: "utf-8",
              timeout: 60000,
              stdio: ["pipe", "pipe", "pipe"],
              cwd: installCwd,
            });
          } catch (e: any) {
            installError = [e?.stderr, e?.stdout, e?.message].filter(Boolean).join("\n").trim().slice(0, 800);
          }
          let pluginEntry = join(installPath, "index.ts");
          if (!existsSync(pluginEntry) && isLocalPath) {
            s.start("Copying from source...");
            mkdirSync(installPath, { recursive: true });
            try {
              cpSync(resolvedPath, installPath, {
                recursive: true,
                filter: (src) => !/[/\\]node_modules([/\\]|$)|[/\\]\.git([/\\]|$)/.test(src),
              });
            } catch (copyErr: any) {
              clack.log.error(`Fallback copy failed: ${copyErr?.message || copyErr}`);
            }
            pluginEntry = join(installPath, "index.ts");
          }
          if (!existsSync(pluginEntry)) {
            s.stop("Install failed");
            clack.log.error("Plugin files not found after install. Try: openclaw plugins install ./");
            clack.log.error(`  installPath: ${installPath}`);
            clack.log.error(`  source (resolved): ${resolvedPath}`);
            clack.log.error(`  isLocalPath: ${isLocalPath}`);
            if (installError) clack.log.error(`  install command stderr/stdout:\n${installError}`);
            process.exitCode = 1;
            return;
          }
          s.stop(`New version installed (v${readPackageVersion(installPath)})`);

          try {
            syncPluginInstallRecord({ installPath, source: installSource, updateTimestamp: true });
          } catch (e: any) {
            clack.log.warn(`Could not sync install record: ${e.message}`);
          }

          s.start("Discovering models...");
          const cursorPath = detectCursorPath(pluginConfig.cursorPath as string | undefined);
          if (!cursorPath) {
            s.stop("cursor-agent not found");
            clack.log.warn("Could not find cursor-agent binary. Ensure Cursor IDE is installed.");
          }
          const upgradeLogger = {
            info: (_msg: string) => {},
            warn: (msg: string) => clack.log.warn(msg),
            error: (msg: string) => clack.log.error(msg),
          };
          const models = cursorPath ? discoverCursorModels(cursorPath, upgradeLogger) : [];
          s.stop(`Found ${models.length} models`);

          const currentModel = (config.agents as any)?.defaults?.model;
          const curPrimary = currentModel?.primary?.replace(`${PROVIDER_ID}/`, "");
          const curFallbacks = (currentModel?.fallbacks as string[] | undefined)?.map((f: string) => f.replace(`${PROVIDER_ID}/`, ""));
          const selection = await promptModelSelection(models, curPrimary, curFallbacks);
          if (selection) {
            const proxyPort = (pluginConfig.proxyPort as number) || DEFAULT_PROXY_PORT;
            try {
              saveModelSelection(selection.primary, selection.fallbacks, proxyPort, models);
              clack.log.success("Model configuration saved to openclaw.json");
            } catch (e: any) {
              clack.log.error(`Could not save config: ${e.message}`);
            }
          }

          clack.outro("Run `openclaw gateway restart` to apply changes");
          process.exit(0);
        });

      // ── proxy subcommand group ──────────────────────────────────────────
      const proxyCmd = prog
        .command("proxy")
        .description("Manage the streaming proxy process");

      proxyCmd
        .action(() => {
          const proxyPort = (pluginConfig.proxyPort as number) || DEFAULT_PROXY_PORT;
          let up = false;
          let pid = "";
          let sessions = "";
          const health = fetchProxyHealth(proxyPort);
          if (health) {
            up = health.status === "ok" || health.status === "degraded";
            sessions = String(health.sessions ?? "?");
          }
          if (up) {
            try {
              if (process.platform === "win32") {
                const out = execSync(`netstat -ano | findstr :${proxyPort} | findstr LISTENING`, {
                  encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
                }).trim();
                pid = out.split("\n")[0]?.trim().split(/\s+/).pop() || "";
              } else {
                pid = execSync(`lsof -ti :${proxyPort}`, { encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).trim().split("\n")[0] || "";
              }
            } catch {}
          }
          console.log("Streaming Proxy Status\n");
          console.log(`  Status:    ${up ? "running" : "stopped"}`);
          console.log(`  Port:      ${proxyPort}`);
          if (pid) console.log(`  PID:       ${pid}`);
          if (sessions) console.log(`  Sessions:  ${sessions}`);
          console.log(`  Log file:  ${join(homedir(), ".openclaw", "cursor-proxy.log")}`);
        });

      proxyCmd
        .command("stop")
        .description("Stop the streaming proxy")
        .action(async () => {
          const proxyPort = (pluginConfig.proxyPort as number) || DEFAULT_PROXY_PORT;
          if (!isProxyRunning(proxyPort)) {
            console.log("Proxy is not running.");
            return;
          }
          killPortProcess(proxyPort);
          await new Promise((r) => setTimeout(r, 500));
          if (isProxyRunning(proxyPort)) {
            console.error(`Proxy on port ${proxyPort} may still be running. Try: kill $(lsof -ti :${proxyPort})`);
          } else {
            console.log(`Proxy on port ${proxyPort} stopped.`);
          }
        });

      proxyCmd
        .command("restart")
        .description("Restart the streaming proxy (detached)")
        .action(async () => {
          const proxyPort = (pluginConfig.proxyPort as number) || DEFAULT_PROXY_PORT;
          const cursorPath = detectCursorPath(pluginConfig.cursorPath as string | undefined);
          if (!cursorPath) {
            console.error("Cannot restart: cursor-agent not found.");
            process.exitCode = 1;
            return;
          }
          const proxyScript = join(pluginDir, "mcp-server", "streaming-proxy.mjs");
          if (!existsSync(proxyScript)) {
            console.error(`Cannot restart: proxy script not found at ${proxyScript}`);
            process.exitCode = 1;
            return;
          }

          if (isProxyRunning(proxyPort)) {
            killPortProcess(proxyPort);
            await new Promise((r) => setTimeout(r, 500));
          }

          const outputFormat = detectOutputFormat(cursorPath, pluginConfig.outputFormat as string | undefined);
          const child = spawn("node", [proxyScript], {
            env: {
              ...process.env,
              CURSOR_PATH: cursorPath,
              CURSOR_WORKSPACE_DIR: (config.agents as any)?.defaults?.workspace ?? "",
              CURSOR_PROXY_PORT: String(proxyPort),
              CURSOR_OUTPUT_FORMAT: outputFormat,
              CURSOR_MODEL: (pluginConfig.cursorModel as string) || "",
              CURSOR_PROXY_SCRIPT_HASH: computeFileHash(proxyScript),
            },
            stdio: "ignore",
            detached: true,
          });
          child.unref();
          console.log(`Proxy restarted on port ${proxyPort} (pid ${child.pid}).`);
        });

      proxyCmd
        .command("log")
        .description("Show recent proxy log entries")
        .option("-n, --lines <count>", "Number of lines to show", "30")
        .action((opts: { lines: string }) => {
          const logPath = join(homedir(), ".openclaw", "cursor-proxy.log");
          if (!existsSync(logPath)) {
            console.log("No proxy log file found.");
            return;
          }
          const n = Math.max(1, parseInt(opts.lines, 10) || 30);
          try {
            if (process.platform !== "win32") {
              const out = execSync(`tail -n ${n} "${logPath}"`, { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
              console.log(out.trimEnd());
            } else {
              const content = readFileSync(logPath, "utf-8");
              const lines = content.trimEnd().split("\n");
              console.log(lines.slice(-n).join("\n"));
            }
          } catch (e: any) {
            try {
              const content = readFileSync(logPath, "utf-8");
              const lines = content.trimEnd().split("\n");
              console.log(lines.slice(-n).join("\n"));
            } catch (err: any) {
              console.error(`Could not read log: ${err?.message || e?.message}`);
            }
          }
        });

    }, { commands: ["cursor-brain"] });
  },
};

export default plugin;

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { runSetup, type SetupContext, buildCliBackendConfig, detectCursorPath } from "./src/setup.js";
import { runDoctorChecks, formatDoctorResults } from "./src/doctor.js";
import { runCleanup } from "./src/cleanup.js";
import { PLUGIN_ID, CLI_BACKEND_ID, getCursorMcpConfigPath } from "./src/constants.js";

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
  name: "Cursor Bridge",
  description:
    "Bridge OpenClaw Gateway tools to Cursor Agent via MCP. " +
    "Auto-discovers plugin tools and proxies them through the Gateway REST API.",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const pluginDir = resolvePluginDir(api);
    const config = api.config;
    const pluginConfig = api.pluginConfig || {};

    const isUninstalling = process.argv.some(
      (a) => a === "uninstall" || a === "upgrade"
    );

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
        api.logger.info("Cursor Bridge setup complete");
      }

      const backends = (config.agents as any)?.defaults?.cliBackends ?? {};
      if (result.cursorPath && !backends[CLI_BACKEND_ID] && ctx.workspaceDir) {
        try {
          const newBackend = buildCliBackendConfig(result.cursorPath, ctx.workspaceDir);
          const model = (pluginConfig.model as string) || "auto";
          const fallback = (pluginConfig.fallbackModel as string) || "sonnet-4.6";

          const patch = {
            ...config,
            agents: {
              ...(config.agents || {}),
              defaults: {
                ...((config.agents as any)?.defaults || {}),
                model: {
                  primary: `${CLI_BACKEND_ID}/${model}`,
                  fallbacks: [`${CLI_BACKEND_ID}/${fallback}`],
                },
                cliBackends: {
                  ...backends,
                  [CLI_BACKEND_ID]: newBackend,
                },
              },
            },
          };

          api.runtime.config.writeConfigFile(patch as any).then(() => {
            api.logger.info(`Configured CLI backend "${CLI_BACKEND_ID}" (primary: ${model}, fallback: ${fallback})`);
          }).catch((err: any) => {
            api.logger.warn(`Could not write CLI backend config: ${err.message}`);
          });
        } catch (e: any) {
          api.logger.warn(`Could not auto-configure CLI backend: ${e.message}`);
        }
      }
    }

    api.registerCli((ctx) => {
      const prog = ctx.program
        .command("cursor-bridge")
        .description("Cursor Agent MCP bridge management");

      prog
        .command("setup")
        .description("Run or re-run MCP bridge configuration")
        .action(() => {
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
            for (const e of result.errors) console.error(`  \u2717 ${e}`);
            process.exitCode = 1;
          } else {
            console.log("  \u2713 MCP bridge configured successfully");
            console.log(`    Cursor: ${result.cursorPath}`);
            console.log(`    MCP config: ${getCursorMcpConfigPath()}`);
          }
        });

      prog
        .command("doctor")
        .description("Check Cursor Bridge health")
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
        .description("Show current bridge configuration status")
        .action(() => {
          const cursorPath = detectCursorPath(pluginConfig.cursorPath as string | undefined);
          const backends = (config.agents as any)?.defaults?.cliBackends ?? {};
          const hasCli = !!backends[CLI_BACKEND_ID];
          const model = (config.agents as any)?.defaults?.model;

          console.log("Cursor Bridge Status\n");
          console.log(`  Platform:       ${process.platform}`);
          console.log(`  Plugin dir:     ${pluginDir}`);
          console.log(`  Cursor path:    ${cursorPath || "not found"}`);
          console.log(`  CLI backend:    ${hasCli ? "configured" : "not configured"}`);
          console.log(`  Primary model:  ${model?.primary || "not set"}`);
          console.log(`  Fallbacks:      ${model?.fallbacks?.join(", ") || "none"}`);
          console.log(`  Gateway:        http://127.0.0.1:${config.gateway?.port ?? 18789}`);
          console.log(`  MCP config:     ${getCursorMcpConfigPath()}`);
        });

      prog
        .command("uninstall")
        .description("Clean up configurations and remove the plugin completely")
        .action(() => {
          console.log("Cursor Bridge Uninstall\n");

          const installPath = join(homedir(), ".openclaw", "extensions", PLUGIN_ID);

          // Step 1: remove plugin config entry (auto-confirm prompt)
          console.log("[1/4] Removing plugin registration...");
          try {
            execSync(`openclaw plugins uninstall ${PLUGIN_ID}`, {
              encoding: "utf-8",
              input: "y\n",
              timeout: 30000,
              stdio: ["pipe", "pipe", "pipe"],
            });
            console.log("  \u2713 Plugin config entry removed");
          } catch {
            console.log("  - Plugin config entry already removed or command failed");
          }

          // Step 2: delete plugin directory
          console.log("[2/4] Removing plugin files...");
          if (existsSync(installPath)) {
            rmSync(installPath, { recursive: true, force: true });
            console.log(`  \u2713 Removed ${installPath}`);
          } else {
            console.log("  - Plugin directory already removed");
          }

          // Step 3: cleanup custom configs (code is in memory, no file dependency)
          console.log("[3/4] Cleaning up configurations...");
          const result = runCleanup();

          if (result.mcpRemoved) console.log(`  \u2713 Removed MCP server from ${getCursorMcpConfigPath()}`);
          if (result.cliBackendRemoved) console.log(`  \u2713 Removed CLI backend "${CLI_BACKEND_ID}"`);
          if (result.modelReset) console.log(`  \u2713 Removed ${CLI_BACKEND_ID}/* model references`);

          if (result.errors.length) {
            for (const e of result.errors) console.error(`  \u2717 ${e}`);
            process.exitCode = 1;
          }

          // Step 4: done
          console.log("[4/4] Done!\n");
          console.log("Restart the gateway to apply changes:");
          console.log("  openclaw gateway restart");
        });
      prog
        .command("upgrade <source>")
        .description("Upgrade plugin from a path, .tgz archive, or npm spec")
        .action((source: string) => {
          console.log("Cursor Bridge Upgrade\n");

          const installPath = join(homedir(), ".openclaw", "extensions", PLUGIN_ID);

          // Step 1: remove old plugin
          console.log("[1/3] Removing old plugin...");
          try {
            execSync(`openclaw plugins uninstall ${PLUGIN_ID}`, {
              encoding: "utf-8",
              input: "y\n",
              timeout: 30000,
              stdio: ["pipe", "pipe", "pipe"],
            });
          } catch { /* ignore */ }
          if (existsSync(installPath)) {
            rmSync(installPath, { recursive: true, force: true });
          }
          const cleanResult = runCleanup();
          if (cleanResult.mcpRemoved) console.log("  \u2713 MCP config cleaned");
          if (cleanResult.cliBackendRemoved) console.log("  \u2713 CLI backend removed");
          if (cleanResult.modelReset) console.log("  \u2713 Model references removed");
          console.log("  \u2713 Old plugin removed");

          // Step 2: install new version
          console.log(`[2/3] Installing from ${source}...`);
          try {
            const out = execSync(`openclaw plugins install ${source}`, {
              encoding: "utf-8",
              timeout: 60000,
              stdio: "pipe",
            });
            if (out.includes("Installed plugin")) {
              console.log("  \u2713 New version installed");
            } else {
              console.log(out);
            }
          } catch (e: any) {
            console.error(`  \u2717 Install failed: ${e.stderr || e.message}`);
            process.exitCode = 1;
            return;
          }

          // Step 3: done
          console.log("[3/3] Done!\n");
          console.log("Restart the gateway to load the new version:");
          console.log("  openclaw gateway restart");
        });

    }, { commands: ["cursor-bridge"] });
  },
};

export default plugin;
